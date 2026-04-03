import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const recordRuntimeTelemetryEventMock = vi.fn();
const readLatestAssistantReplyMock = vi.fn();
const runAgentStepMock = vi.fn();
const resolveAnnounceTargetMock = vi.fn();
const recordA2AInboxEventMock = vi.fn();

vi.mock("../../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: (opts: unknown) => runAgentStepMock(opts),
  readLatestAssistantReply: (opts: unknown) => readLatestAssistantReplyMock(opts),
}));

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: (opts: unknown) => resolveAnnounceTargetMock(opts),
}));

vi.mock("../../a2a-inbox.js", () => ({
  recordA2AInboxEvent: (opts: unknown) => recordA2AInboxEventMock(opts),
}));

vi.mock("../../infra/runtime-telemetry.js", () => ({
  recordRuntimeTelemetryEvent: (event: unknown) => recordRuntimeTelemetryEventMock(event),
}));

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true, deliveryMode: "inject" } },
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

import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

describe("sessions send a2a telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockResolvedValue({ status: "ok" });
    runAgentStepMock.mockResolvedValue("Announced");
    resolveAnnounceTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "+15555550123",
      accountId: "acct-1",
    });
  });

  it("emits handoff start and completion telemetry", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:sub",
      displayKey: "sub",
      message: "Do work",
      announceTimeoutMs: 1000,
      maxPingPongTurns: 1,
      requesterSessionKey: "agent:main:root",
      requesterChannel: "telegram",
      roundOneReply: "Done",
      waitRunId: "run-123",
    });

    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.a2a_handoff_started",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-123",
          targetSessionKey: "agent:main:sub",
        }),
      }),
    );
    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.a2a_handoff_completed",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-123",
          outcome: "announce_sent",
        }),
      }),
    );
  });
});
