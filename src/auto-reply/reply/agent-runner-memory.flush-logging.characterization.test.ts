/**
 * CHARACTERIZATION TESTS — H-3: Memory Flush Failure Logging
 *
 * These tests pin CURRENT (broken) behavior for safe refactoring.
 * They are NOT correctness tests. They WILL be deleted/updated
 * when the corresponding fix lands.
 *
 * Hardening area: H-3
 * Source: src/auto-reply/reply/agent-runner-memory.ts
 * Broken behavior: flush failure logs only via logVerbose
 * Paired remediation contract: agent-runner-memory.flush-logging.contract.test.ts
 * Lifecycle: DELETE after fix H-3 commits
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 1: Characterization)
 */

import { describe, it, expect, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";

const logVerboseMock = vi.fn();
const runWithModelFallbackMock = vi.fn();

vi.mock("../../globals.js", () => ({
  logVerbose: (message: string) => logVerboseMock(message),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async (params: any) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
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
          },
          reserveTokensFloor: 5_000,
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
    sessionEntry: { totalTokens: 96_000, compactionCount: 1 },
  };
}

describe("runMemoryFlushIfNeeded logging characterization", () => {
  it("logs flush failure via logVerbose", async () => {
    logVerboseMock.mockReset();
    runWithModelFallbackMock.mockReset();

    runWithModelFallbackMock.mockRejectedValue(new Error("boom"));

    const { cfg, followupRun, sessionCtx, sessionEntry } = createParams();

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      isHeartbeat: false,
    });

    expect(logVerboseMock).toHaveBeenCalled();
    expect(logVerboseMock.mock.calls[0]?.[0]).toContain("memory flush run failed");
  });
});
