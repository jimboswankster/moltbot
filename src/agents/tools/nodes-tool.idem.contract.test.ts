import { describe, expect, it, vi } from "vitest";
import { createNodesTool } from "./nodes-tool.js";

const gatewayMock = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMock.callGatewayTool,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: vi.fn(async () => "node-1"),
  resolveNodeIdFromList: vi.fn(() => "node-1"),
  listNodes: vi.fn(async () => [
    {
      nodeId: "node-1",
      connected: true,
      commands: ["system.run"],
      caps: [],
    },
  ]),
}));

describe("nodes tool idempotency (contract)", () => {
  it("honors provided idempotencyKey for notify", async () => {
    const tool = createNodesTool();

    await tool.execute(
      "tool-1",
      {
        action: "notify",
        node: "node-1",
        title: "Hello",
        idempotencyKey: "idem-node",
      },
      undefined,
      undefined,
    );

    const params = gatewayMock.callGatewayTool.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params?.idempotencyKey).toBe("idem-node");
  });
});
