import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "./gateway";

vi.mock("./device-auth", () => ({
  clearDeviceAuthToken: vi.fn(),
  loadDeviceAuthToken: vi.fn(() => null),
  storeDeviceAuthToken: vi.fn(),
}));

vi.mock("./device-identity", () => ({
  loadOrCreateDeviceIdentity: vi.fn(async () => ({
    deviceId: "dev-1",
    publicKey: "pk",
    privateKey: "sk",
  })),
  signDevicePayload: vi.fn(async () => "sig"),
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(public readonly url: string) {
    mockSockets.push(this);
  }

  addEventListener(type: string, handler: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, wasClean: true });
  }

  emit(type: string, event: any) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }

  message(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) });
  }
}

const mockSockets: MockWebSocket[] = [];

describe("GatewayBrowserClient handshake order", () => {
  beforeEach(() => {
    mockSockets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends connect as first outbound frame", async () => {
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:44892" });
    client.start();

    const socket = mockSockets[0];
    expect(socket).toBeDefined();
    socket.open();

    expect(socket.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(750);

    expect(socket.sent.length).toBeGreaterThan(0);
    const first = JSON.parse(socket.sent[0] ?? "{}");
    expect(first.type).toBe("req");
    expect(first.method).toBe("connect");

    client.stop();
  });

  it("queues non-connect requests until connect hello-ok", async () => {
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:44892" });
    client.start();

    const socket = mockSockets[0];
    expect(socket).toBeDefined();
    socket.open();

    const queued = client.request("chat.history", { sessionKey: "agent:main:main" });

    await vi.advanceTimersByTimeAsync(750);
    expect(socket.sent.length).toBe(1);

    const connectFrame = JSON.parse(socket.sent[0] ?? "{}");
    expect(connectFrame.method).toBe("connect");

    socket.message({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: { type: "hello-ok", protocol: 3 },
    });

    await Promise.resolve();
    expect(socket.sent.length).toBe(2);
    const second = JSON.parse(socket.sent[1] ?? "{}");
    expect(second.method).toBe("chat.history");

    socket.message({
      type: "res",
      id: second.id,
      ok: true,
      payload: { items: [] },
    });

    await expect(queued).resolves.toEqual({ items: [] });
    client.stop();
  });
});
