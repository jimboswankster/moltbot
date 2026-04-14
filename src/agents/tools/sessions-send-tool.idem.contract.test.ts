import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsSendTool } from "./sessions-send-tool.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-1" })),
}));

import { callGateway } from "../../gateway/call.js";

describe("sessions_send idempotency (contract)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("honors provided idempotencyKey", async () => {
    const tool = createSessionsSendTool({ agentSessionKey: "agent:main:main" });
    const idemProvided = "idem-fixed";
    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue("idem-random");

    await tool.execute(
      "tool-1",
      {
        sessionKey: "agent:main:main",
        message: "hello",
        idempotencyKey: idemProvided,
      },
      undefined,
      undefined,
    );

    expect(callGateway).toHaveBeenCalled();
    const params = vi.mocked(callGateway).mock.calls[0]?.[0]?.params as Record<string, unknown>;
    expect(params.idempotencyKey).toBe(idemProvided);

    uuidSpy.mockRestore();
  });

  it("does not rerun the side effect when resumed with the same idempotencyKey", async () => {
    const acceptedRuns = new Map<string, string>();
    let uniqueSideEffects = 0;

    vi.mocked(callGateway).mockImplementation(async (opts) => {
      if (opts.method !== "agent") {
        return { ok: true };
      }
      const params = (opts.params ?? {}) as { idempotencyKey?: string };
      const idem = params.idempotencyKey ?? "missing";
      let runId = acceptedRuns.get(idem);
      if (!runId) {
        uniqueSideEffects += 1;
        runId = `run-${uniqueSideEffects}`;
        acceptedRuns.set(idem, runId);
      }
      return { runId };
    });

    const tool = createSessionsSendTool({ agentSessionKey: "agent:main:main" });
    const idemProvided = "idem-resume-safe";

    const first = await tool.execute(
      "tool-crash-1",
      {
        sessionKey: "agent:main:main",
        message: "hello",
        idempotencyKey: idemProvided,
        timeoutSeconds: 0,
      },
      undefined,
      undefined,
    );

    const second = await tool.execute(
      "tool-crash-2",
      {
        sessionKey: "agent:main:main",
        message: "hello",
        idempotencyKey: idemProvided,
        timeoutSeconds: 0,
      },
      undefined,
      undefined,
    );

    expect(first.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(second.details).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(uniqueSideEffects).toBe(1);
  });
});
