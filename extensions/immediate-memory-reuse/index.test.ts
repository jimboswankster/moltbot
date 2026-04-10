import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import immediateMemoryReusePlugin, { extractImmediateReuseFact } from "./index.js";

type HookHandler = (
  event: unknown,
  ctx: { workspaceDir?: string; sessionKey?: string },
) => Promise<unknown> | unknown;

const tempDirs: string[] = [];

function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "openclaw-immediate-memory-"));
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function createMockApi(pluginConfig?: unknown) {
  const hooks = new Map<string, HookHandler>();
  const logs: string[] = [];
  return {
    hooks,
    logs,
    api: {
      pluginConfig,
      logger: {
        info: (message: string) => logs.push(`info:${message}`),
        warn: (message: string) => logs.push(`warn:${message}`),
        debug: (message: string) => logs.push(`debug:${message}`),
      },
      on: (hookName: "before_agent_start" | "agent_end", handler: HookHandler) => {
        hooks.set(hookName, handler);
      },
    },
  };
}

describe("immediate-memory-reuse plugin", () => {
  it("extracts one compact repo-entry fact from recent messages", () => {
    const extracted = extractImmediateReuseFact([
      {
        role: "tool",
        content: [
          {
            type: "text",
            text: "Found package.json and pnpm-lock.yaml in the repo root.",
          },
        ],
      },
    ]);

    expect(extracted?.fact).toContain("pnpm-aware commands");
    expect(extracted?.sourceSnippet).toContain("pnpm-lock.yaml");
  });

  it("writes a sidecar on agent_end and consumes it once on before_agent_start", async () => {
    const workspaceDir = await makeTempDir();
    tempDirs.push(workspaceDir);
    const sessionKey = "agent:main:test-session";
    const { api, hooks } = createMockApi();

    immediateMemoryReusePlugin.register(api);

    const agentEnd = hooks.get("agent_end");
    const beforeAgentStart = hooks.get("before_agent_start");

    expect(agentEnd).toBeDefined();
    expect(beforeAgentStart).toBeDefined();

    await agentEnd?.(
      {
        success: true,
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "text",
                text: "Inspection result: package.json exists and packageManager is pnpm.",
              },
            ],
          },
        ],
      },
      { workspaceDir, sessionKey },
    );

    const storageDir = path.join(workspaceDir, ".openclaw", "surface-3-memory");
    const written = await fs.readdir(storageDir);
    expect(written).toHaveLength(1);

    const firstInject = await beforeAgentStart?.({ prompt: "what should I do next?" }, {
      workspaceDir,
      sessionKey,
    });
    expect(firstInject).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("Immediate prior-turn harness fact"),
      }),
    );
    expect((firstInject as { prependContext: string }).prependContext).toContain("pnpm-aware");

    const remainingAfterConsume = await fs.readdir(storageDir);
    expect(remainingAfterConsume).toHaveLength(0);

    const secondInject = await beforeAgentStart?.({ prompt: "and now?" }, { workspaceDir, sessionKey });
    expect(secondInject).toBeUndefined();
  });

  it("does not write a sidecar for failed or non-matching runs", async () => {
    const workspaceDir = await makeTempDir();
    tempDirs.push(workspaceDir);
    const sessionKey = "agent:main:test-session";
    const { api, hooks } = createMockApi();

    immediateMemoryReusePlugin.register(api);
    const agentEnd = hooks.get("agent_end");

    await agentEnd?.(
      {
        success: false,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "This should not be stored." }],
          },
        ],
      },
      { workspaceDir, sessionKey },
    );

    await expect(fs.readdir(path.join(workspaceDir, ".openclaw", "surface-3-memory"))).rejects.toThrow();
  });
});
