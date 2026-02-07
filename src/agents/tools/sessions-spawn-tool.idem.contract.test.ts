import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

vi.mock("../auth-profiles.js", () => ({
  loadAuthProfileStore: () => ({}),
  resolveAuthProfileOrder: () => [],
  isProfileInCooldown: () => false,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async (payload: { method: string }) => {
    if (payload.method === "agent") {
      return { runId: "run-1" };
    }
    return { status: "ok" };
  }),
}));

import { callGateway } from "../../gateway/call.js";

describe("sessions_spawn idempotency (contract)", () => {
  it("honors provided idempotencyKey", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });
    const idemProvided = "idem-fixed";
    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue("idem-random");

    await tool.execute(
      "tool-1",
      {
        task: "do work",
        label: "job",
        idempotencyKey: idemProvided,
      },
      undefined,
      undefined,
    );

    const agentCall = vi
      .mocked(callGateway)
      .mock.calls.map((call) => call?.[0])
      .find((call) => call?.method === "agent");
    const params = agentCall?.params as Record<string, unknown> | undefined;
    expect(params?.idempotencyKey).toBe(idemProvided);

    uuidSpy.mockRestore();
  });
});
