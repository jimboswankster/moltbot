/**
 * REMEDIATION CONTRACT TESTS — H-2/H-6: Memory Flush Model + Fallbacks
 *
 * These tests define CORRECT behavior. They are RED until fixes land.
 * After the fixes, they become permanent regression tests.
 *
 * Hardening area: H-2, H-6
 * Source: src/auto-reply/reply/agent-runner-memory.ts
 * Correct behavior: flush uses memoryFlush.model when configured and omits fallbacksOverride
 * Paired characterization: deleted after fix H-2/H-6
 * Status: RED -> GREEN when fixes land
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 2: Remediation Contract)
 */

import { describe, it, expect, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const resolveAgentModelFallbacksOverrideMock = vi.fn();

vi.mock("../../agents/model-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-fallback.js")>();
  return {
    ...actual,
    runWithModelFallback: async (params: any) => runWithModelFallbackMock(params),
  };
});

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

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentModelFallbacksOverride: (...args: unknown[]) =>
    resolveAgentModelFallbacksOverrideMock(...args),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

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
            model: "google/gemini-3-flash-preview",
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
      sessionKey: undefined,
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
    sessionEntry: { totalTokens: 130_000, compactionCount: 1 },
  };
}

describe("runMemoryFlushIfNeeded model selection remediation contract", () => {
  it("uses memoryFlush.model when configured", async () => {
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    resolveAgentModelFallbacksOverrideMock.mockReset();

    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["openai/gpt-4o-mini"]);
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      return { provider, model };
    });

    const { cfg, followupRun, sessionCtx, sessionEntry } = createParams();

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      // Inflate context window for deterministic triggering with production-like thresholds.
      agentCfgContextTokens: 144_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      isHeartbeat: false,
    });

    const call = runWithModelFallbackMock.mock.calls[0]?.[0];
    expect(call.provider).toBe("google");
    expect(call.model).toBe("gemini-3-flash-preview");
  });

  it("omits fallbacksOverride to allow global fallback chain", async () => {
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    resolveAgentModelFallbacksOverrideMock.mockReset();

    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["openai/gpt-4o-mini"]);
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      return { provider, model };
    });

    const { cfg, followupRun, sessionCtx, sessionEntry } = createParams();

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      // Inflate context window for deterministic triggering with production-like thresholds.
      agentCfgContextTokens: 144_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      isHeartbeat: false,
    });

    const call = runWithModelFallbackMock.mock.calls[0]?.[0];
    expect(call.fallbacksOverride).toBeUndefined();
  });
});
