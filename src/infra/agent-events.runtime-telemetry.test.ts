import { beforeEach, describe, expect, it, vi } from "vitest";

const recordRuntimeTelemetryEventMock = vi.fn();

vi.mock("./runtime-telemetry.js", () => ({
  recordRuntimeTelemetryEvent: (event: unknown) => recordRuntimeTelemetryEventMock(event),
}));

import {
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "./agent-events.js";

describe("agent-events runtime telemetry bridge", () => {
  beforeEach(() => {
    recordRuntimeTelemetryEventMock.mockClear();
    resetAgentRunContextForTest();
  });

  it("emits tool start and completion telemetry with duration", () => {
    vi.useFakeTimers();
    try {
      registerAgentRunContext("run-1", { sessionKey: "agent:main:test" });
      emitAgentEvent({
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", name: "exec", toolCallId: "tool-1" },
      });
      vi.advanceTimersByTime(25);
      emitAgentEvent({
        runId: "run-1",
        stream: "tool",
        data: { phase: "result", name: "exec", toolCallId: "tool-1", isError: false },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.tool_call_started",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-1",
          sessionKey: "agent:main:test",
          toolCallId: "tool-1",
          toolName: "exec",
        }),
      }),
    );
    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.tool_call_completed",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-1",
          sessionKey: "agent:main:test",
          toolCallId: "tool-1",
          durationMs: 25,
        }),
      }),
    );
  });

  it("emits run lifecycle telemetry with duration", () => {
    vi.useFakeTimers();
    try {
      registerAgentRunContext("run-2", { sessionKey: "agent:main:test" });
      emitAgentEvent({
        runId: "run-2",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      vi.advanceTimersByTime(80);
      emitAgentEvent({
        runId: "run-2",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.run_started",
        subsystem: "agent-ops",
      }),
    );
    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.run_completed",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-2",
          durationMs: 80,
        }),
      }),
    );
  });

  it("emits failed lifecycle telemetry with error details", () => {
    vi.useFakeTimers();
    try {
      registerAgentRunContext("run-3", { sessionKey: "agent:main:test" });
      emitAgentEvent({
        runId: "run-3",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      vi.advanceTimersByTime(15);
      emitAgentEvent({
        runId: "run-3",
        stream: "lifecycle",
        data: { phase: "error", error: "crash" },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.run_failed",
        subsystem: "agent-ops",
        severity: "error",
        status: "failed",
        details: expect.objectContaining({
          runId: "run-3",
          sessionKey: "agent:main:test",
          durationMs: 15,
          error: "crash",
        }),
      }),
    );
  });

  it("emits failed tool telemetry with malformed-call classification", () => {
    vi.useFakeTimers();
    try {
      registerAgentRunContext("run-4", { sessionKey: "agent:main:test" });
      emitAgentEvent({
        runId: "run-4",
        stream: "tool",
        data: { phase: "start", name: "read", toolCallId: "tool-4" },
      });
      vi.advanceTimersByTime(10);
      emitAgentEvent({
        runId: "run-4",
        stream: "tool",
        data: {
          phase: "result",
          name: "read",
          toolCallId: "tool-4",
          isError: true,
          result: {
            details: {
              status: "error",
              errorCode: "TOOL_READ_MISSING_PATH",
              errorCategory: "missing_required_param",
              missingKeys: ["path"],
              retryable: true,
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.tool_call_failed",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-4",
          toolName: "read",
          errorCode: "TOOL_READ_MISSING_PATH",
          errorCategory: "missing_required_param",
          missingKeys: ["path"],
          retryable: true,
        }),
      }),
    );
  });
});
