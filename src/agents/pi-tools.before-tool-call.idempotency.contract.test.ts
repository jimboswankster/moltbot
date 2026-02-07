import { describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

describe("before_tool_call idempotency injection (contract)", () => {
  it("injects deterministic idempotencyKey for side-effect tools using runId", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "sessions_send", execute } as any, {
      runId: "cron:job-1:1700000000000",
      sessionKey: "agent:main:cron:job-1",
    });

    await tool.execute(
      "call-1",
      { sessionKey: "agent:main:main", message: "hi" },
      undefined,
      undefined,
    );
    await tool.execute(
      "call-2",
      { sessionKey: "agent:main:main", message: "hi" },
      undefined,
      undefined,
    );

    const first = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = execute.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(first.idempotencyKey).toBeTruthy();
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it("emits telemetry when idempotency is injected for cron runs", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      events.push({ stream: evt.stream, data: evt.data as Record<string, unknown> });
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "sessions_send", execute } as any, {
      runId: "cron:job-2:1700000000000",
      sessionKey: "agent:main:cron:job-2",
    });

    await tool.execute(
      "call-3",
      { sessionKey: "agent:main:main", message: "hello" },
      undefined,
      undefined,
    );
    stop();

    const telemetry = events.find(
      (evt) =>
        evt.stream === "lifecycle" &&
        evt.data?.phase === "telemetry" &&
        evt.data?.kind === "idempotency_injected",
    );
    expect(telemetry).toBeTruthy();
    expect(telemetry?.data?.toolName).toBe("sessions_send");
    expect(telemetry?.data?.scope).toBe("cron");
  });

  it("does not emit telemetry for non-cron runs", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      events.push({ stream: evt.stream, data: evt.data as Record<string, unknown> });
    });
    const tool = wrapToolWithBeforeToolCallHook({ name: "sessions_send", execute } as any, {
      runId: "run:interactive:1",
      sessionKey: "agent:main:interactive",
    });

    await tool.execute(
      "call-4",
      { sessionKey: "agent:main:main", message: "hello" },
      undefined,
      undefined,
    );
    stop();

    const telemetry = events.find(
      (evt) =>
        evt.stream === "lifecycle" &&
        evt.data?.phase === "telemetry" &&
        evt.data?.kind === "idempotency_injected",
    );
    expect(telemetry).toBeUndefined();
  });

  it("supports idempotencyKeySeed override and strips it before execution", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "sessions_send", execute } as any, {
      runId: "cron:job-3:1700000000000",
      sessionKey: "agent:main:cron:job-3",
    });

    await tool.execute(
      "call-5",
      { sessionKey: "agent:main:main", message: "hi", idempotencyKeySeed: "seed-a" },
      undefined,
      undefined,
    );
    await tool.execute(
      "call-6",
      { sessionKey: "agent:main:main", message: "hi", idempotencyKeySeed: "seed-b" },
      undefined,
      undefined,
    );

    const first = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = execute.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(first.idempotencyKey).toBeTruthy();
    expect(second.idempotencyKey).toBeTruthy();
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.idempotencyKeySeed).toBeUndefined();
    expect(second.idempotencyKeySeed).toBeUndefined();
  });

  it("uses stable serialization for idempotencyKey (order independent)", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook({ name: "sessions_send", execute } as any, {
      runId: "cron:job-4:1700000000000",
      sessionKey: "agent:main:cron:job-4",
    });

    await tool.execute(
      "call-7",
      {
        sessionKey: "agent:main:main",
        message: "hi",
        meta: { b: 2, a: 1 },
        list: [{ z: 3, y: 2 }],
      },
      undefined,
      undefined,
    );
    await tool.execute(
      "call-8",
      {
        sessionKey: "agent:main:main",
        message: "hi",
        list: [{ y: 2, z: 3 }],
        meta: { a: 1, b: 2 },
      },
      undefined,
      undefined,
    );

    const first = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = execute.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(first.idempotencyKey).toBeTruthy();
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });
});
