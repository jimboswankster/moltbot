import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSessionsSendTool } from "./sessions-send-tool.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-1" })),
}));

import { callGateway } from "../../gateway/call.js";

describe("sessions_send idempotency (contract)", () => {
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
});
