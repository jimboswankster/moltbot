import { describe, expect, it, vi } from "vitest";
import { createCanvasTool } from "./canvas-tool.js";

const gatewayMock = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMock.callGatewayTool,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: vi.fn(async () => "node-1"),
}));

describe("canvas tool idempotency (contract)", () => {
  it("honors provided idempotencyKey", async () => {
    const tool = createCanvasTool();

    await tool.execute(
      "tool-1",
      {
        action: "hide",
        node: "node-1",
        idempotencyKey: "idem-canvas",
      },
      undefined,
      undefined,
    );

    const params = gatewayMock.callGatewayTool.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params?.idempotencyKey).toBe("idem-canvas");
  });
});
