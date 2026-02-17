import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => "/custom/bin:/opt/bin"),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 1234),
  };
});

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

const normalizePathEntries = (value?: string) =>
  normalizeText(value)
    .split(/[:\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

describe("exec PATH login shell merge", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("merges login-shell PATH for host=gateway", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const { createExecTool } = await import("./bash-tools.exec.js");
    const { getShellPathFromLoginShell } = await import("../infra/shell-env.js");
    const shellPathMock = vi.mocked(getShellPathFromLoginShell);
    shellPathMock.mockClear();
    shellPathMock.mockReturnValue("/custom/bin:/opt/bin");

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call1", { command: "echo $PATH" });
    const entries = normalizePathEntries(result.content.find((c) => c.type === "text")?.text);

    expect(entries).toEqual(["/custom/bin", "/opt/bin", "/usr/bin"]);
    expect(shellPathMock).toHaveBeenCalledTimes(1);
  });

  it("throws security violation when env.PATH is provided", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const { createExecTool } = await import("./bash-tools.exec.js");
    const { getShellPathFromLoginShell } = await import("../infra/shell-env.js");
    const shellPathMock = vi.mocked(getShellPathFromLoginShell);
    shellPathMock.mockClear();

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo $PATH",
        env: { PATH: "/explicit/bin" },
      }),
    ).rejects.toThrow(/Security Violation: Custom 'PATH' variable is forbidden/);

    expect(shellPathMock).not.toHaveBeenCalled();
  });
});

describe("exec host env validation", () => {
  it("blocks LD_/DYLD_ env vars on host execution", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo ok",
        env: { LD_DEBUG: "1" },
      }),
    ).rejects.toThrow(/Security Violation: Environment variable 'LD_DEBUG' is forbidden/);
  });
});

describe("exec unicode-space path repair", () => {
  it("repairs simple ls command when quoted absolute path has unicode-space drift", async () => {
    if (isWin) {
      return;
    }
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-path-"));
    const actualBase = "Screenshot 2026-02-17 at 9.33.26\u202fAM.png";
    const actualPath = path.join(tempDir, actualBase);
    await fs.writeFile(actualPath, "x");
    const requestedPath = path.join(tempDir, "Screenshot 2026-02-17 at 9.33.26 AM.png");

    const tool = createExecTool({ host: "sandbox" });
    const result = await tool.execute("call1", { command: `ls "${requestedPath}"` });
    const text = normalizeText(result.content.find((c) => c.type === "text")?.text);

    expect(text).toContain(actualBase);
    expect((result.details as { command?: string })?.command).toContain(actualBase);
    expect((result.details as { command?: string })?.command).not.toContain("9.33.26 AM.png");
  });

  it("blocks complex commands with missing quoted absolute paths instead of rewriting", async () => {
    if (isWin) {
      return;
    }
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-path-"));
    const actualPath = path.join(tempDir, "Screenshot 2026-02-17 at 9.33.26\u202fAM.png");
    await fs.writeFile(actualPath, "x");
    const requestedPath = path.join(tempDir, "Screenshot 2026-02-17 at 9.33.26 AM.png");

    const tool = createExecTool({ host: "sandbox" });
    await expect(
      tool.execute("call2", { command: `ls "${requestedPath}" && echo "done"` }),
    ).rejects.toThrow(/Complex shell command was not auto-rewritten/);
  });

  it("does not rewrite non-allowlisted simple commands", async () => {
    if (isWin) {
      return;
    }
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-path-"));
    const requestedPath = path.join(tempDir, "Screenshot 2026-02-17 at 9.33.26 AM.png");

    const tool = createExecTool({ host: "sandbox" });
    const result = await tool.execute("call3", { command: `echo "${requestedPath}"` });
    const commandUsed = (result.details as { command?: string })?.command ?? "";

    expect(commandUsed).toContain(requestedPath);
    expect(commandUsed).toContain("9.33.26 AM.png");
  });

  it("repairs paths when filename uses ideographic space variant", async () => {
    if (isWin) {
      return;
    }
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-path-"));
    const actualBase = "Report 2026-02-17 09.33.26\u3000AM.txt";
    const actualPath = path.join(tempDir, actualBase);
    await fs.writeFile(actualPath, "ok");
    const requestedPath = path.join(tempDir, "Report 2026-02-17 09.33.26 AM.txt");

    const tool = createExecTool({ host: "sandbox" });
    const result = await tool.execute("call4", { command: `cat "${requestedPath}"` });
    const text = normalizeText(result.content.find((c) => c.type === "text")?.text);

    expect(text).toContain("ok");
    expect(text).toContain("unicode-space filename match");
    expect((result.details as { command?: string })?.command).toContain(actualBase);
  });
});
