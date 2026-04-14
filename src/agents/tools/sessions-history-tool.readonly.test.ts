import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true } },
      }) as never,
  };
});

import { createSessionsHistoryTool } from "./sessions-history-tool.js";

describe("sessions_history read-only behavior", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "chat.history") {
        return { messages: [{ role: "assistant", content: "hello" }] };
      }
      return {};
    });
  });

  it("uses only read-only history access for same-agent lookups", async () => {
    const tool = createSessionsHistoryTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      sessionKey: "agent:main:main",
      limit: 1,
    });

    expect(result.details).toMatchObject({
      sessionKey: "agent:main:main",
      messages: [{ role: "assistant", content: "hello" }],
    });

    const methods = callGatewayMock.mock.calls.map((call) => call?.[0]?.method);
    expect(methods).toEqual(["chat.history"]);
    expect(methods).not.toContain("agent");
    expect(methods).not.toContain("sessions.send");
  });
});
