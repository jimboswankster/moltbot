/**
 * Agent Step Regression Tests
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC Protocol: TEST-QA-PASSING-FAILURE v1.0.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { runAgentStep } from "../agent-step.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Input Source Metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("agent-step - input source metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") {
        return { runId: "run-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "ok" };
      }
      if (opts.method === "chat.history") {
        return { messages: [{ role: "assistant", content: "OK" }] };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes inputSource metadata to gateway agent call", async () => {
    await runAgentStep({
      sessionKey: "agent:main:subagent:sub-001",
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: "prompt",
      timeoutMs: 10_000,
      inputSource: {
        type: "a2a-announce",
        sessionKey: "agent:main:main",
        runId: "run-abc",
      },
    });

    const agentCall = callGatewayMock.mock.calls.find((call) => {
      const arg = call[0] as { method?: string };
      return arg?.method === "agent";
    })?.[0] as { params?: Record<string, unknown> } | undefined;

    expect(agentCall?.params).toMatchObject({
      inputSource: {
        type: "a2a-announce",
        sessionKey: "agent:main:main",
        runId: "run-abc",
      },
    });
  });
});

/**
 * QC PROTOCOL CHECKLIST (Protocol: TEST-QA-PASSING-FAILURE v1.0.0)
 * ─────────────────────────────────────────────────────────────────
 * [x] PHASE_1: Test inventory declared in describe() blocks
 * [x] PHASE_2: SUT invoked (runAgentStep)
 * [x] PHASE_3: Assertions verify behavior (gateway call params)
 * [x] PHASE_4: No test.fails used
 * [x] PHASE_5: Error paths tested (not applicable)
 * [x] PHASE_6: Each test uses fresh mocks
 * [x] PHASE_7: Unit tests mock external boundaries only (gateway)
 * [x] PHASE_8: Mutation check - test fails if inputSource not forwarded
 * [x] PHASE_9: All violations addressed
 */
