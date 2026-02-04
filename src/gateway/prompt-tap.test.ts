/**
 * Prompt Tap tests — no mocks. Uses isolated test home from test/setup.ts;
 * creates real workspace dir and runs real runPromptSnapshot against it.
 * Aligns with os/tests/README.md manual test protocol (real tool, real output).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runPromptSnapshot,
  snapshotTimestamp,
  splitSystemPrompt,
  type RunPromptSnapshotOptions,
} from "./prompt-tap.js";

describe("snapshotTimestamp", () => {
  it("returns format YYYYMMDDTHHMMSSZ", () => {
    const ts = snapshotTimestamp();
    expect(ts).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("is filesystem-safe (no colons)", () => {
    expect(snapshotTimestamp()).not.toContain(":");
  });
});

describe("splitSystemPrompt", () => {
  it("returns full content as harness when Project Context header is absent", () => {
    const text = "You are a helpful assistant.\n## Tooling\n";
    const { harness, workspace } = splitSystemPrompt(text);
    expect(harness).toBe(text);
    expect(workspace).toBe("");
  });

  it("splits at # Project Context header", () => {
    const harnessPart = "You are helpful.\n## Tooling\n";
    const workspacePart = "# Project Context\n\nSOUL.md:\nHello.";
    const { harness, workspace } = splitSystemPrompt(harnessPart + workspacePart);
    expect(harness).toBe(harnessPart.trimEnd());
    expect(workspace).toBe(workspacePart);
  });

  it("returns empty harness when prompt is empty", () => {
    const { harness, workspace } = splitSystemPrompt("");
    expect(harness).toBe("");
    expect(workspace).toBe("");
  });
});

describe("runPromptSnapshot", () => {
  /** Default workspace dir under isolated test HOME (see test/setup.ts). */
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = path.join(os.homedir(), ".openclaw", "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    if (!workspaceDir || !workspaceDir.includes(os.tmpdir())) {
      return;
    }
    const snapshotDir = path.join(workspaceDir, "os", "audits", "prompt-snapshots");
    try {
      const entries = await fs.readdir(snapshotDir);
      for (const name of entries) {
        await fs.unlink(path.join(snapshotDir, name)).catch(() => {});
      }
    } catch {
      // dir may not exist
    }
  });

  it("throws when mode is query and message is missing", async () => {
    await expect(runPromptSnapshot({ mode: "query" } as RunPromptSnapshotOptions)).rejects.toThrow(
      "--message is required when --mode is query",
    );
  });

  it("throws when mode is query and message is blank", async () => {
    await expect(runPromptSnapshot({ mode: "query", message: "   " })).rejects.toThrow(
      "--message is required when --mode is query",
    );
  });

  it("writes JSON and MD with workspaceFiles for startup mode (real run)", async () => {
    const result = await runPromptSnapshot({ mode: "startup" });

    expect(result.ok).toBe(true);
    expect(result.workspaceDir).toBeTruthy();
    expect(result.baseName).toMatch(/^\d{8}T\d{6}Z-startup$/);
    expect(result.jsonPath).toContain(path.join("os", "audits", "prompt-snapshots"));
    expect(result.jsonPath.endsWith(".json")).toBe(true);
    expect(result.mdPath).toContain(path.join("os", "audits", "prompt-snapshots"));
    expect(result.mdPath.endsWith(".md")).toBe(true);

    const json = JSON.parse(await fs.readFile(result.jsonPath, "utf-8"));
    expect(json.mode).toBe("startup");
    expect(typeof json.model).toBe("string");
    expect(json.model.length).toBeGreaterThan(0);
    expect(json.messages).toHaveLength(1);
    expect(json.messages[0].role).toBe("system");
    expect(json.messages[0].source).toBe("harness");
    expect(Array.isArray(json.workspaceFiles)).toBe(true);
    expect(json.workspaceFiles.length).toBeGreaterThan(0);
    for (const f of json.workspaceFiles) {
      expect(f).toHaveProperty("path");
      expect(f).toHaveProperty("bytes");
      expect(typeof f.bytes).toBe("number");
    }
    expect(json.timestamp).toBeDefined();
    expect(json.sessionId).toMatch(/^prompt-tap-\d+$/);

    const md = await fs.readFile(result.mdPath, "utf-8");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Workspace files loaded");
    expect(md).toContain("| path | bytes |");
    expect(md).toContain("_Total:");
    expect(md).toContain("bytes across");
    expect(md).toContain("file(s)._");
    expect(md).toContain("## [HARNESS SYSTEM]");
    expect(md).toContain("(empty for startup mode)");
  });

  it("includes user message in JSON and MD for query mode (real run)", async () => {
    const result = await runPromptSnapshot({
      mode: "query",
      message: "We were working on XYZ, remind me.",
    });

    const json = JSON.parse(await fs.readFile(result.jsonPath, "utf-8"));
    expect(json.mode).toBe("query");
    expect(json.messages).toHaveLength(2);
    expect(json.messages[1].role).toBe("user");
    expect(json.messages[1].source).toBe("debug-input");
    expect(json.messages[1].content).toBe("We were working on XYZ, remind me.");

    const md = await fs.readFile(result.mdPath, "utf-8");
    expect(md).toContain("We were working on XYZ, remind me.");
  });
});
