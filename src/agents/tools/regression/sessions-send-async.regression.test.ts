/**
 * Sessions Send Async Mode Regression Tests
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC Protocol: TEST-QA-PASSING-FAILURE v1.0.0
 *
 * Test matrix derived from: workspace/docs/development/debug/a2a-bug/code-inspection.md
 *
 * These tests validate the sessions_send tool behavior, particularly around
 * async (fire-and-forget) mode and the A2A flow triggering.
 *
 * DOCUMENTED BUG: async-no-a2a
 * When timeoutSeconds === 0 (fire-and-forget), the A2A flow STILL runs.
 * This is documented in code-inspection.md - the recommended fix is to
 * skip startA2AFlow() when in async mode.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (external boundaries only)
// ─────────────────────────────────────────────────────────────────────────────

const callGatewayMock = vi.fn();
vi.mock("../../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

const runSessionsSendA2AFlowMock = vi.fn();
vi.mock("../sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: (opts: unknown) => runSessionsSendA2AFlowMock(opts),
}));

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true } },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
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
// Imports (after mocks - SUT remains real)
// ─────────────────────────────────────────────────────────────────────────────

import { createSessionsSendTool } from "../sessions-send-tool.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Async Mode (Fire-and-Forget)
// ─────────────────────────────────────────────────────────────────────────────

describe("sessions_send - Async Mode Behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock: gateway calls succeed
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "sessions.resolve") {
        return { key: "agent:main:subagent:sub-001" };
      }
      if (opts.method === "agent") {
        return { runId: "run-async-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "ok" };
      }
      if (opts.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * DOCUMENTED BUG: async-no-a2a
   *
   * When timeoutSeconds === 0, the tool operates in fire-and-forget mode.
   * The intention is to dispatch the message and return immediately without
   * waiting for the sub-agent to complete.
   *
   * CURRENT BEHAVIOR: startA2AFlow() is called even in async mode.
   * EXPECTED BEHAVIOR: startA2AFlow() should NOT be called when timeoutSeconds === 0.
   *
   * This test documents the CURRENT (buggy) behavior.
   */
  it("returns accepted status in async mode with timeoutSeconds=0", async () => {
    // Observable: tool.execute return value status field
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-async-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Fire and forget task",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: expect.any(String),
    });
  });

  it("calls A2A flow in async mode (CURRENT BUG - should not happen)", async () => {
    // Observable: runSessionsSendA2AFlowMock called
    // NOTE: This test documents buggy behavior. When fixed, update assertion.
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    await tool.execute("call-async-2", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Fire and forget task",
      timeoutSeconds: 0,
    });

    // BUG: A2A flow IS being called even in fire-and-forget mode
    // When fixed, change to: expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
    expect(runSessionsSendA2AFlowMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Test for FIXED behavior - skip this until fix is applied.
   * Rationale: Test documents expected behavior post-fix. Currently skipped
   * because fix has not been applied yet. See code-inspection.md.
   */
  it.fails("should NOT call A2A flow in async mode (EXPECTED BEHAVIOR)", async () => {
    // Observable: runSessionsSendA2AFlowMock NOT called
    // This test will pass once the fix is applied.
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    await tool.execute("call-async-fix-test", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Fire and forget task",
      timeoutSeconds: 0,
    });

    // EXPECTED after fix: A2A should NOT be called for fire-and-forget
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Sync Mode (Wait for Reply)
// ─────────────────────────────────────────────────────────────────────────────

describe("sessions_send - Sync Mode Behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "sessions.resolve") {
        return { key: "agent:main:subagent:sub-001" };
      }
      if (opts.method === "agent") {
        return { runId: "run-sync-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "ok" };
      }
      if (opts.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: "Task completed!" }],
        };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok status in sync mode", async () => {
    // Observable: tool.execute return value status field
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-sync-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Do this task and wait",
      timeoutSeconds: 30,
    });

    // Verify sync mode returns ok status
    expect(result.details).toMatchObject({
      status: "ok",
      runId: expect.any(String),
    });
  });

  it("calls A2A flow in sync mode with session keys", async () => {
    // Observable: runSessionsSendA2AFlowMock called with correct session keys
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    await tool.execute("call-sync-2", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Task with reply",
      timeoutSeconds: 30,
    });

    expect(runSessionsSendA2AFlowMock).toHaveBeenCalledTimes(1);
    // Verify the key session parameters are passed correctly
    expect(runSessionsSendA2AFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:main:subagent:sub-001",
        requesterSessionKey: "agent:main:main",
        requesterChannel: "telegram",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Cross-Agent Detection
// ─────────────────────────────────────────────────────────────────────────────

describe("sessions_send - Cross-Agent Detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes requester and target session keys to A2A flow", async () => {
    // Observable: runSessionsSendA2AFlowMock call arguments
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        return { runId: "run-cross-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "ok" };
      }
      if (opts.method === "chat.history") {
        return { messages: [{ role: "assistant", content: "Done" }] };
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    await tool.execute("call-cross-1", {
      sessionKey: "agent:other:subagent:sub-001",
      message: "Cross-agent message",
      timeoutSeconds: 30,
    });

    // Verify both session keys are passed to A2A flow
    expect(runSessionsSendA2AFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:other:subagent:sub-001",
      }),
    );
  });

  it("passes same-agent session keys when sending to own subagent", async () => {
    // Observable: runSessionsSendA2AFlowMock call arguments
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        return { runId: "run-self-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "ok" };
      }
      if (opts.method === "chat.history") {
        return { messages: [{ role: "assistant", content: "Done" }] };
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    await tool.execute("call-self-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Same-agent message to subagent",
      timeoutSeconds: 30,
    });

    expect(runSessionsSendA2AFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:subagent:sub-001",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Timeout and Error Handling
// ─────────────────────────────────────────────────────────────────────────────

describe("sessions_send - Timeout and Error Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns timeout status when agent.wait returns timeout", async () => {
    // Observable: tool.execute return value status field
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        return { runId: "run-timeout-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "timeout", error: "Agent did not complete in time" };
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-timeout-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Slow task",
      timeoutSeconds: 5,
    });

    expect(result.details).toMatchObject({
      status: "timeout",
    });
    // A2A should NOT be called on timeout (no reply to work with)
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });

  it("returns error status when agent.wait returns error", async () => {
    // Observable: tool.execute return value status field
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        return { runId: "run-error-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "error", error: "Agent crashed" };
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-error-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Failing task",
      timeoutSeconds: 30,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "Agent crashed",
    });
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });

  it("returns error status when gateway agent method throws", async () => {
    // Observable: tool.execute return value status field
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        throw new Error("Gateway connection failed");
      }
      return {};
    });

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-gateway-error-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Task that fails at gateway",
      timeoutSeconds: 30,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Gateway connection failed"),
    });
  });
});

/**
 * QC PROTOCOL CHECKLIST (Protocol: TEST-QA-PASSING-FAILURE v1.0.0)
 * ─────────────────────────────────────────────────────────────────
 * [x] PHASE_1: Test inventory declared in describe() blocks
 * [x] PHASE_2: SUT (createSessionsSendTool().execute()) actually invoked
 * [x] PHASE_3: Assertions verify behavior (status values, call arguments)
 * [x] PHASE_4: test.fails has rationale (documenting expected behavior post-fix)
 * [x] PHASE_5: Error paths tested (timeout, error, gateway throw)
 * [x] PHASE_6: Each test uses fresh mocks (beforeEach/afterEach cleanup)
 * [x] PHASE_7: Unit tests mock external boundaries only
 * [x] PHASE_8: Mutation check - tests would fail if status changed
 * [x] PHASE_9: All violations addressed
 *
 * Observable sources documented per test.
 * Mocks target external boundaries only (gateway, A2A flow, logging).
 * SUT function (createSessionsSendTool) remains real.
 */
