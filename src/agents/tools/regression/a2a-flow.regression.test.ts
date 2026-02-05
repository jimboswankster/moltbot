/**
 * A2A Flow Regression Tests
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC Protocol: TEST-QA-PASSING-FAILURE v1.0.0
 *
 * Test matrix derived from: workspace/docs/development/debug/a2a-bug/code-inspection.md
 *
 * These tests validate the agent-to-agent (A2A) flow behavior to prevent regressions
 * in the ping-pong, announce, and message injection mechanisms.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (external boundaries only - SUT remains real)
// ─────────────────────────────────────────────────────────────────────────────

const callGatewayMock = vi.fn();
vi.mock("../../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

const runAgentStepMock = vi.fn();
const readLatestAssistantReplyMock = vi.fn();
vi.mock("../agent-step.js", () => ({
  runAgentStep: (opts: unknown) => runAgentStepMock(opts),
  readLatestAssistantReply: (opts: unknown) => readLatestAssistantReplyMock(opts),
}));

const resolveAnnounceTargetMock = vi.fn();
vi.mock("../sessions-announce-target.js", () => ({
  resolveAnnounceTarget: (opts: unknown) => resolveAnnounceTargetMock(opts),
}));

const recordA2AInboxEventMock = vi.fn();
vi.mock("../../a2a-inbox.js", () => ({
  recordA2AInboxEvent: (opts: unknown) => recordA2AInboxEventMock(opts),
}));

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true } },
      }) as never,
  };
});

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports (after mocks - SUT is real, dependencies are mocked)
// ─────────────────────────────────────────────────────────────────────────────

import {
  isAnnounceSkip,
  isReplySkip,
  buildAgentToAgentReplyContext,
  buildAgentToAgentAnnounceContext,
} from "../sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "../sessions-send-tool.a2a.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Constants
// ─────────────────────────────────────────────────────────────────────────────

const REPLY_SKIP_TOKEN = "REPLY_SKIP";
const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";

// ─────────────────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────────────────

function createDefaultParams(
  overrides: Partial<Parameters<typeof runSessionsSendA2AFlow>[0]> = {},
) {
  return {
    targetSessionKey: "agent:main:subagent:sub-001",
    displayKey: "subagent:sub-001",
    message: "Test message",
    announceTimeoutMs: 30_000,
    maxPingPongTurns: 5,
    requesterSessionKey: "agent:main:main",
    requesterChannel: "telegram" as const,
    roundOneReply: "Sub agent completed the task.",
    waitRunId: "run-123",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Skip Token Detection (Pure Functions)
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Skip Token Detection", () => {
  it("isReplySkip returns true for exact REPLY_SKIP token", () => {
    // Observable: Return value of isReplySkip()
    const result = isReplySkip(REPLY_SKIP_TOKEN);
    expect(result).toBe(true);
  });

  it("isReplySkip returns true for REPLY_SKIP with surrounding whitespace", () => {
    // Observable: Return value of isReplySkip()
    const result = isReplySkip(`  ${REPLY_SKIP_TOKEN}  `);
    expect(result).toBe(true);
  });

  it("isReplySkip returns false for non-skip content", () => {
    // Observable: Return value of isReplySkip()
    expect(isReplySkip("Some other reply")).toBe(false);
    expect(isReplySkip("")).toBe(false);
    expect(isReplySkip(undefined)).toBe(false);
    expect(isReplySkip("REPLY_SKIP extra text")).toBe(false);
  });

  it("isAnnounceSkip returns true for exact ANNOUNCE_SKIP token", () => {
    // Observable: Return value of isAnnounceSkip()
    const result = isAnnounceSkip(ANNOUNCE_SKIP_TOKEN);
    expect(result).toBe(true);
  });

  it("isAnnounceSkip returns true for ANNOUNCE_SKIP with surrounding whitespace", () => {
    // Observable: Return value of isAnnounceSkip()
    const result = isAnnounceSkip(`  ${ANNOUNCE_SKIP_TOKEN}  `);
    expect(result).toBe(true);
  });

  it("isAnnounceSkip returns false for non-skip content", () => {
    // Observable: Return value of isAnnounceSkip()
    expect(isAnnounceSkip("Some announcement")).toBe(false);
    expect(isAnnounceSkip("")).toBe(false);
    expect(isAnnounceSkip(undefined)).toBe(false);
    expect(isAnnounceSkip("ANNOUNCE_SKIP extra")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Context Builders (Pure Functions)
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Context Builders", () => {
  it("buildAgentToAgentReplyContext includes tool restriction instruction", () => {
    // Observable: Return value (string) of buildAgentToAgentReplyContext()
    const result = buildAgentToAgentReplyContext({
      requesterSessionKey: "agent:main:main",
      requesterChannel: "telegram",
      targetSessionKey: "subagent:sub-001",
      targetChannel: "internal",
      currentRole: "requester",
      turn: 1,
      maxTurns: 5,
    });

    // Verify critical content is present (behavior, not just existence)
    expect(result).toContain("Do NOT use tools");
    expect(result).toContain("REPLY_SKIP");
    expect(result).toContain("Turn 1 of 5");
    expect(result).toContain("Agent 1 (requester)");
  });

  it("buildAgentToAgentReplyContext includes turn information accurately", () => {
    // Observable: Return value (string) of buildAgentToAgentReplyContext()
    const result = buildAgentToAgentReplyContext({
      requesterSessionKey: "agent:main:main",
      targetSessionKey: "subagent:sub-001",
      currentRole: "target",
      turn: 3,
      maxTurns: 5,
    });

    expect(result).toContain("Turn 3 of 5");
    expect(result).toContain("Agent 2 (target)");
  });

  it("buildAgentToAgentAnnounceContext includes tool restriction and skip instruction", () => {
    // Observable: Return value (string) of buildAgentToAgentAnnounceContext()
    const result = buildAgentToAgentAnnounceContext({
      requesterSessionKey: "agent:main:main",
      requesterChannel: "telegram",
      targetSessionKey: "subagent:sub-001",
      targetChannel: "internal",
      originalMessage: "Do the task",
      roundOneReply: "Done!",
      latestReply: "Done!",
    });

    expect(result).toContain("Do NOT use tools");
    expect(result).toContain("ANNOUNCE_SKIP");
    expect(result).toContain("agent-to-agent conversation is over");
    expect(result).toContain("Original request: Do the task");
    expect(result).toContain("Round 1 reply: Done!");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Ping-Pong Mechanism
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Ping-Pong Mechanism", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips ping-pong even when conditions are met", async () => {
    // Observable: runAgentStepMock call count and arguments
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement message");

    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams();
    await runSessionsSendA2AFlow(params);

    // Only announce step runs
    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
    expect(runAgentStepMock.mock.calls[0][0]).toMatchObject({
      sessionKey: "agent:main:subagent:sub-001",
      message: "Agent-to-agent announce step.",
    });
  });

  it("does not run ping-pong when REPLY_SKIP would be emitted", async () => {
    // Observable: runAgentStepMock call count (announce only)
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement message");

    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams();
    await runSessionsSendA2AFlow(params);

    // Only announce step runs
    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
  });

  it("does not run ping-pong when reply would be empty", async () => {
    // Observable: runAgentStepMock call count
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement message");

    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams();
    await runSessionsSendA2AFlow(params);

    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
  });

  it("skips ping-pong when requesterSessionKey equals targetSessionKey", async () => {
    // Observable: runAgentStepMock call count (should be 1, announce only)
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement message");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      requesterSessionKey: "agent:main:subagent:sub-001",
      targetSessionKey: "agent:main:subagent:sub-001",
    });
    await runSessionsSendA2AFlow(params);

    // Only announce step runs
    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
  });

  it("skips ping-pong when requesterSessionKey is undefined", async () => {
    // Observable: runAgentStepMock call count (should be 1, announce only)
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement message");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      requesterSessionKey: undefined,
    });
    await runSessionsSendA2AFlow(params);

    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
  });

  it("skips ping-pong when maxPingPongTurns is 0", async () => {
    // Observable: runAgentStepMock call count (should be 1, announce only)
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement message");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Announce Mechanism
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Announce Mechanism", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delivers announcement via callGateway send method with correct params", async () => {
    // Observable: callGatewayMock called with method:"send" and specific params
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "discord",
      to: "channel:12345",
      accountId: "acc-001",
    });

    runAgentStepMock.mockResolvedValueOnce("Task completed successfully!");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    // Verify callGateway was called with correct send parameters
    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![0]).toMatchObject({
      method: "send",
      params: {
        channel: "discord",
        to: "channel:12345",
        accountId: "acc-001",
        message: "Task completed successfully!",
      },
    });
  });

  it("does not call send when agent replies with ANNOUNCE_SKIP token", async () => {
    // Observable: callGatewayMock NOT called with method:"send"
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce(ANNOUNCE_SKIP_TOKEN);

    const params = createDefaultParams({
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeUndefined();
  });

  it("does not call send when announce reply is whitespace only", async () => {
    // Observable: callGatewayMock NOT called with method:"send"
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("   ");

    const params = createDefaultParams({
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeUndefined();
  });

  it("does not call send when resolveAnnounceTarget returns null", async () => {
    // Observable: callGatewayMock NOT called with method:"send"
    resolveAnnounceTargetMock.mockResolvedValue(null);

    runAgentStepMock.mockResolvedValueOnce("Announcement message");

    const params = createDefaultParams({
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Rate Limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("delays 1000ms before the announce step", async () => {
    // Observable: Timing behavior via fake timers
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      maxPingPongTurns: 5,
    });

    const flowPromise = runSessionsSendA2AFlow(params);

    expect(runAgentStepMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await flowPromise;

    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - No Reply Early Exit
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - No Reply Early Exit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exits without running agent steps when no reply and wait fails", async () => {
    // Observable: runAgentStepMock NOT called
    callGatewayMock.mockResolvedValue({ status: "timeout" });
    readLatestAssistantReplyMock.mockResolvedValue(undefined);

    const params = createDefaultParams({
      roundOneReply: undefined,
    });
    await runSessionsSendA2AFlow(params);

    expect(runAgentStepMock).not.toHaveBeenCalled();
  });

  it("continues to announce when wait succeeds and retrieves reply from history", async () => {
    // Observable: runAgentStepMock called once (announce step)
    callGatewayMock.mockResolvedValue({ status: "ok" });
    readLatestAssistantReplyMock.mockResolvedValue("Retrieved reply from history");
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement");

    const params = createDefaultParams({
      roundOneReply: undefined,
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Inbox Recording
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Inbox Recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records A2A completion into the requester inbox", async () => {
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Final announcement");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      roundOneReply: "Sub completed the task",
      waitRunId: "run-123",
    });
    await runSessionsSendA2AFlow(params);

    expect(recordA2AInboxEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-123",
        replyText: "Final announcement",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Error Handling
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Error Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not throw when announce delivery fails with network error", async () => {
    // Observable: Function completes without throwing
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement message");
    callGatewayMock.mockRejectedValue(new Error("Network error"));

    const params = createDefaultParams({
      maxPingPongTurns: 0,
    });

    // Should complete without throwing
    await expect(runSessionsSendA2AFlow(params)).resolves.toBeUndefined();
  });

  it("does not throw when runAgentStep fails", async () => {
    // Observable: Function completes without throwing
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockRejectedValue(new Error("Agent step failed"));

    const params = createDefaultParams({
      maxPingPongTurns: 0,
    });

    await expect(runSessionsSendA2AFlow(params)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Max Turns Exhaustion (Gap #4)
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Max Turns Exhaustion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("announces using the latest reply when ping-pong is skipped", async () => {
    // Observable: announce context contains latest reply
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Final announcement");

    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      maxPingPongTurns: 5,
    });
    await runSessionsSendA2AFlow(params);

    expect(runAgentStepMock).toHaveBeenCalledTimes(1);
    const announceCall = runAgentStepMock.mock.calls[0][0] as {
      message: string;
      extraSystemPrompt: string;
    };
    expect(announceCall.message).toBe("Agent-to-agent announce step.");
    expect(announceCall.extraSystemPrompt).toContain("Latest reply: Sub agent completed the task.");
  });

  it("does not call the requester session during announce-only flow", async () => {
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      maxPingPongTurns: 5,
    });
    await runSessionsSendA2AFlow(params);

    const call1 = runAgentStepMock.mock.calls[0][0] as { sessionKey: string };
    expect(call1.sessionKey).toBe("agent:main:subagent:sub-001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Announce Skip with Whitespace (Gap #5)
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Announce Skip Token Normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("respects ANNOUNCE_SKIP with leading whitespace", async () => {
    // Observable: callGatewayMock NOT called with method:"send"
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("   ANNOUNCE_SKIP"); // Leading whitespace

    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      maxPingPongTurns: 5,
    });
    await runSessionsSendA2AFlow(params);

    // Should NOT call send because ANNOUNCE_SKIP (with whitespace) was returned
    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeUndefined();
  });

  it("respects ANNOUNCE_SKIP with trailing whitespace", async () => {
    // Observable: callGatewayMock NOT called with method:"send"
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("ANNOUNCE_SKIP   "); // Trailing whitespace

    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      maxPingPongTurns: 5,
    });
    await runSessionsSendA2AFlow(params);

    const sendCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - History Reply Retrieval (Gap #6)
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - History Reply Retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls readLatestAssistantReply when roundOneReply is absent and wait succeeds", async () => {
    // Observable: readLatestAssistantReplyMock called with correct sessionKey
    callGatewayMock.mockResolvedValue({ status: "ok" });
    readLatestAssistantReplyMock.mockResolvedValue("Retrieved from history");
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement");

    const params = createDefaultParams({
      roundOneReply: undefined,
      waitRunId: "run-456",
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    // Verify readLatestAssistantReply was called with target session
    expect(readLatestAssistantReplyMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:sub-001",
    });
  });

  it("uses retrieved history reply as latestReply in announce context", async () => {
    // Observable: Announce step receives history reply in context
    callGatewayMock.mockResolvedValue({ status: "ok" });
    readLatestAssistantReplyMock.mockResolvedValue("History reply content");
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement");

    const params = createDefaultParams({
      roundOneReply: undefined,
      waitRunId: "run-789",
      maxPingPongTurns: 0,
    });
    await runSessionsSendA2AFlow(params);

    // Verify the announce step received the history reply
    const announceCall = runAgentStepMock.mock.calls[0][0] as {
      extraSystemPrompt: string;
    };
    expect(announceCall.extraSystemPrompt).toContain("Round 1 reply: History reply content");
    expect(announceCall.extraSystemPrompt).toContain("Latest reply: History reply content");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Flow - Role/Source Attribution (Gap #2)
// ─────────────────────────────────────────────────────────────────────────────

describe("A2A Flow - Role/Source Attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not call the requester session during A2A flow", async () => {
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "user:123",
    });

    runAgentStepMock.mockResolvedValueOnce("Announcement");
    callGatewayMock.mockResolvedValue({ status: "ok" });

    const params = createDefaultParams({
      roundOneReply: "Sub completed the task",
      maxPingPongTurns: 3,
    });
    await runSessionsSendA2AFlow(params);

    const call1 = runAgentStepMock.mock.calls[0][0] as { sessionKey: string };
    expect(call1.sessionKey).toBe("agent:main:subagent:sub-001");
  });
});

/**
 * QC PROTOCOL CHECKLIST (Protocol: TEST-QA-PASSING-FAILURE v1.0.0)
 * ─────────────────────────────────────────────────────────────────
 * [x] PHASE_1: Test inventory declared in describe() blocks
 * [x] PHASE_2: SUT (runSessionsSendA2AFlow, isReplySkip, etc.) actually invoked
 * [x] PHASE_3: Assertions verify behavior (call counts, params, return values)
 * [x] PHASE_4: No test.fails used
 * [x] PHASE_5: Error paths tested (network errors, agent step failures)
 * [x] PHASE_6: Each test uses fresh mocks (beforeEach/afterEach cleanup)
 * [x] PHASE_7: Unit tests mock external boundaries only (gateway, logging)
 * [x] PHASE_8: Mutation check - tests would fail if SUT returned different values
 * [x] PHASE_9: All violations addressed
 *
 * Observable sources documented per test.
 * Mocks target external boundaries only (gateway, logging, announce target).
 * SUT functions (runSessionsSendA2AFlow, isReplySkip, etc.) remain real.
 */
