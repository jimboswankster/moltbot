import { beforeEach, describe, expect, it, vi } from "vitest";

const recordRuntimeTelemetryEventMock = vi.fn();

vi.mock("../infra/runtime-telemetry.js", () => ({
  recordRuntimeTelemetryEvent: (event: unknown) => recordRuntimeTelemetryEventMock(event),
}));

import { runWithModelFallback } from "./model-fallback.js";

describe("model fallback agent ops telemetry", () => {
  beforeEach(() => {
    recordRuntimeTelemetryEventMock.mockClear();
  });

  it("emits llm invocation completion with usage and cost", async () => {
    vi.useFakeTimers();
    try {
      await runWithModelFallback({
        cfg: {
          models: {
            providers: {
              openai: {
                models: [
                  {
                    id: "gpt-test",
                    cost: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-test",
        telemetryContext: { runId: "run-1", sessionKey: "agent:main:test" },
        run: async () => {
          vi.advanceTimersByTime(42);
          return {
            meta: {
              agentMeta: {
                provider: "openai",
                model: "gpt-test",
                usage: {
                  input: 1000,
                  output: 500,
                  total: 1500,
                },
              },
            },
          };
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.llm_invocation_started",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-1",
          provider: "openai",
          model: "gpt-test",
        }),
      }),
    );
    expect(recordRuntimeTelemetryEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.llm_invocation_completed",
        subsystem: "agent-ops",
        details: expect.objectContaining({
          runId: "run-1",
          provider: "openai",
          model: "gpt-test",
          durationMs: 42,
          usage: expect.objectContaining({
            input: 1000,
            output: 500,
            total: 1500,
          }),
          costUsd: 2,
        }),
      }),
    );
  });
});
