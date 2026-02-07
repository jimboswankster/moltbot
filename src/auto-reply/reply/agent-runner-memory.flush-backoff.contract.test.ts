/**
 * REMEDIATION CONTRACT TESTS — H-CHAIN: Memory Flush Failure Backoff
 *
 * Ensures repeated flush failures are throttled and failure state is persisted.
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 2: Remediation Contract)
 */

import { describe, it, expect, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";

const logWarnMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const updateSessionStoreEntryMock = vi.fn();

vi.mock("../../logger.js", () => ({
  logWarn: (message: string) => logWarnMock(message),
}));

vi.mock("../../agents/context.js", () => ({
  lookupContextTokens: () => undefined,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
    resolveAuthProfileOrder: () => [],
    isProfileInCooldown: () => false,
  };
});

vi.mock("../../agents/model-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-fallback.js")>();
  return {
    ...actual,
    runWithModelFallback: async (params: any) => runWithModelFallbackMock(params),
  };
});

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    updateSessionStoreEntry: (...args: unknown[]) => updateSessionStoreEntryMock(...args),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

function createParams(overrides?: Partial<FollowupRun["run"]>) {
  const cfg = {
    agents: {
      defaults: {
        compaction: {
          memoryFlush: {
            enabled: true,
            softThresholdTokens: 4_000,
            prompt: "Write notes.",
            systemPrompt: "Flush memory now.",
          },
          reserveTokensFloor: 20_000,
        },
      },
    },
  };

  const followupRun = {
    prompt: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: cfg,
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude-opus-4-5",
      thinkLevel: "low",
      verboseLevel: "off",
      reasoningLevel: "off",
      execOverrides: {},
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      extraSystemPrompt: "",
      ownerNumbers: [],
      authProfileId: "profile-1",
      authProfileIdSource: "agent-defaults",
      ...overrides,
    },
  } as unknown as FollowupRun;

  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+15550001111",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;

  return {
    cfg,
    followupRun,
    sessionCtx,
  };
}

describe("memory flush failure backoff remediation contract", () => {
  it("skips flush when backoff window has not elapsed", async () => {
    logWarnMock.mockReset();
    runWithModelFallbackMock.mockReset();

    const { cfg, followupRun, sessionCtx } = createParams();
    const future = Date.now() + 60_000;

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 144_000,
      resolvedVerboseLevel: "off",
      sessionEntry: {
        totalTokens: 130_000,
        compactionCount: 1,
        memoryFlushNextAllowedAt: future,
      },
      isHeartbeat: false,
    });

    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalled();
  });

  it("persists failure count and next-allowed time on flush failure", async () => {
    logWarnMock.mockReset();
    runWithModelFallbackMock.mockReset();
    updateSessionStoreEntryMock.mockReset();

    runWithModelFallbackMock.mockRejectedValue(new Error("boom"));

    const { cfg, followupRun, sessionCtx } = createParams();
    const sessionEntry = { totalTokens: 130_000, compactionCount: 1 };
    const sessionStore = { main: sessionEntry };

    updateSessionStoreEntryMock.mockImplementation(async ({ sessionKey, update }: any) => {
      const patch = await update(sessionStore[sessionKey]);
      if (!patch) {
        return sessionStore[sessionKey];
      }
      const merged = { ...sessionStore[sessionKey], ...patch };
      sessionStore[sessionKey] = merged;
      return merged;
    });

    const updated = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 144_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath: "/tmp/session-store.json",
      isHeartbeat: false,
    });

    expect(runWithModelFallbackMock).toHaveBeenCalled();
    expect(updated?.memoryFlushFailureCount).toBe(1);
    expect(updated?.memoryFlushLastFailureAt).toBeTypeOf("number");
    expect(updated?.memoryFlushNextAllowedAt).toBeTypeOf("number");
  });
});
