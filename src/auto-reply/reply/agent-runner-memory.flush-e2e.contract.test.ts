/**
 * REMEDIATION CONTRACT TESTS — H-CHAIN: Memory Flush End-to-End Failure Chain
 *
 * Defines correct end-to-end behavior when a memory flush attempt fails:
 * - flush is attempted with production-like thresholds
 * - failure is logged and diagnostics emitted
 * - compaction counters are not advanced
 * - session store is not updated
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 2: Remediation Contract)
 */

import { describe, it, expect, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";

const logWarnMock = vi.fn();
const emitDiagnosticEventMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const updateSessionStoreEntryMock = vi.fn();

vi.mock("../../logger.js", () => ({
  logWarn: (message: string) => logWarnMock(message),
}));

vi.mock("../../infra/diagnostic-events.js", () => ({
  emitDiagnosticEvent: (event: unknown) => emitDiagnosticEventMock(event),
  isDiagnosticsEnabled: () => true,
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
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, agentId: "main" }),
  resolveSandboxConfigForAgent: () => ({ workspaceAccess: "rw" }),
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
    diagnostics: { enabled: true },
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

  const sessionEntry = { totalTokens: 130_000, compactionCount: 1 };

  return {
    cfg,
    followupRun,
    sessionCtx,
    sessionEntry,
    sessionStore: { main: sessionEntry },
  };
}

describe("memory flush end-to-end failure chain remediation contract", () => {
  it("logs, emits diagnostics, and avoids session updates on flush failure", async () => {
    logWarnMock.mockReset();
    emitDiagnosticEventMock.mockReset();
    runWithModelFallbackMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
    updateSessionStoreEntryMock.mockReset();

    runWithModelFallbackMock.mockRejectedValue(new Error("cooldown"));

    const { cfg, followupRun, sessionCtx, sessionEntry, sessionStore } = createParams();

    const updated = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      // Inflate context window for deterministic triggering with production-like thresholds.
      agentCfgContextTokens: 144_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      isHeartbeat: false,
    });

    expect(runWithModelFallbackMock).toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalled();
    expect(emitDiagnosticEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "memory.flush.failed" }),
    );
    expect(updateSessionStoreEntryMock).not.toHaveBeenCalled();
    expect(updated?.memoryFlushCompactionCount).toBeUndefined();
  });
});
