import { beforeEach, describe, expect, it, vi } from "vitest";

let lastClientOptions: {
  url?: string;
  token?: string;
  password?: string;
  disableStoredDeviceToken?: boolean;
  onHelloOk?: () => void | Promise<void>;
} | null = null;
const requestedMethods: string[] = [];

vi.mock("./client.js", () => ({
  GatewayClient: class {
    constructor(opts: {
      url?: string;
      token?: string;
      password?: string;
      disableStoredDeviceToken?: boolean;
      onHelloOk?: () => void | Promise<void>;
    }) {
      lastClientOptions = opts;
    }
    start() {
      void lastClientOptions?.onHelloOk?.();
    }
    stop() {}
    async request(method: string) {
      requestedMethods.push(method);
      if (method === "system-presence") {
        return [];
      }
      return {};
    }
  },
}));

const { probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  beforeEach(() => {
    lastClientOptions = null;
    requestedMethods.length = 0;
  });

  it("disables cached device-token auth for deterministic probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "explicit-token" },
      timeoutMs: 1000,
    });

    expect(lastClientOptions?.disableStoredDeviceToken).toBe(true);
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(result.ok).toBe(true);
    expect(requestedMethods).toEqual(["health", "status", "system-presence", "config.get"]);
  });
});
