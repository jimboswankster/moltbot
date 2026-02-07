import { describe, expect, it, vi } from "vitest";
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
});
