import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import { createBrowserTool } from "./browser-tool.js";

const gatewayMock = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({
    payload: { result: { ok: true } },
  })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMock.callGatewayTool,
}));

const nodesState = vi.hoisted(() => ({
  nodes: [
    {
      nodeId: "node-1",
      connected: true,
      caps: ["browser"],
      commands: [],
      displayName: "Browser Node",
    },
  ],
}));

vi.mock("./nodes-utils.js", () => ({
  listNodes: vi.fn(async () => nodesState.nodes),
  resolveNodeIdFromList: () => "node-1",
}));

const configState = vi.hoisted(() => ({
  storePath: "",
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({
    browser: { enabled: true },
    session: { store: configState.storePath },
  }),
}));

vi.mock("../../browser/client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../browser/client.js")>("../../browser/client.js");
  return {
    ...actual,
    browserStatus: vi.fn(async () => ({ ok: true })),
  };
});

describe("browser tool idempotency (contract)", () => {
  it("forwards idempotencyKey to node browser proxy", async () => {
    nodesState.nodes = [
      {
        nodeId: "node-1",
        connected: true,
        caps: ["browser"],
        commands: [],
        displayName: "Browser Node",
      },
    ];
    const tool = createBrowserTool();

    await tool.execute(
      "tool-1",
      {
        action: "status",
        target: "node",
        idempotencyKey: "idem-node",
      },
      undefined,
      undefined,
    );

    const params = gatewayMock.callGatewayTool.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params?.idempotencyKey).toBe("idem-node");
  });

  it("expects durable ledger behavior (fails until ledger implemented)", async () => {
    nodesState.nodes = [];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-"));
    const storePath = path.join(dir, "sessions.json");
    configState.storePath = storePath;

    const sessionKey = "agent:main:main";
    await saveSessionStore(storePath, {
      [sessionKey]: { sessionId: "sess-1", updatedAt: Date.now() },
    });

    const tool = createBrowserTool({ agentSessionKey: sessionKey });

    await tool.execute(
      "tool-1",
      {
        action: "status",
        idempotencyKey: "idem-ledger",
      },
      undefined,
      undefined,
    );

    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[sessionKey];
    expect(entry?.browserIdempotencyLedger?.["idem-ledger"]).toBeDefined();
  });
});
