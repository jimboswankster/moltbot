import { describe, expect, it, vi } from "vitest";
import { createBrowserTool } from "./browser-tool.js";

const gatewayMock = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({
    payload: { result: { ok: true } },
  })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMock.callGatewayTool,
}));

vi.mock("./nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    {
      nodeId: "node-1",
      connected: true,
      caps: ["browser"],
      commands: [],
      displayName: "Browser Node",
    },
  ]),
  resolveNodeIdFromList: () => "node-1",
}));

describe("browser tool idempotency (contract)", () => {
  it("forwards idempotencyKey to node browser proxy", async () => {
    const tool = createBrowserTool();

    await tool.execute(
      "tool-1",
      {
        action: "status",
        target: "node",
        idempotencyKey: "idem-browser",
      },
      undefined,
      undefined,
    );

    const params = gatewayMock.callGatewayTool.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params?.idempotencyKey).toBe("idem-browser");
  });
});
