import { beforeEach, describe, expect, it, vi } from "vitest";
import { startTelegramWebhook } from "./webhook.js";

const handlerSpy = vi.fn(
  (_req: unknown, res: { writeHead: (status: number) => void; end: (body?: string) => void }) => {
    res.writeHead(200);
    res.end("ok");
  },
);
const setWebhookSpy = vi.fn();
const stopSpy = vi.fn();

const createTelegramBotSpy = vi.fn(() => ({
  api: { setWebhook: setWebhookSpy },
  stop: stopSpy,
}));

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return { ...actual, webhookCallback: () => handlerSpy };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (...args: unknown[]) => createTelegramBotSpy(...args),
}));

describe("startTelegramWebhook", () => {
  beforeEach(() => {
    handlerSpy.mockClear();
    createTelegramBotSpy.mockClear();
    setWebhookSpy.mockReset().mockResolvedValue(undefined);
    stopSpy.mockReset();
  });

  it("starts server, registers webhook, and serves health", async () => {
    const cfg = { bindings: [] };
    const { server, stop } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0, // random free port
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no address");
    }
    const url = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(setWebhookSpy).toHaveBeenCalled();

    await stop();
  });

  it("invokes webhook handler on matching path", async () => {
    const cfg = { bindings: [] };
    const { server, stop } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      path: "/hook",
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    await fetch(`http://127.0.0.1:${addr.port}/hook`, { method: "POST" });
    expect(handlerSpy).toHaveBeenCalled();
    await stop();
  });

  it("acquires the OS ingress lease before registration and releases it on stop", async () => {
    const events: string[] = [];
    const release = vi.fn(async () => {
      events.push("release");
    });
    const acquire = vi.fn(async () => {
      events.push("acquire");
      return { release };
    });
    setWebhookSpy.mockImplementation(async () => {
      events.push("setWebhook");
    });

    const { stop } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: { bindings: [] },
      port: 0,
      ingressPolicy: {
        runtimeProfileId: "openclaw-primary",
        adapter: { acquire },
      },
    });

    expect(acquire).toHaveBeenCalledWith({
      target: "openclaw",
      runtimeProfileId: "openclaw-primary",
      accountId: "opie",
      mode: "webhook",
    });
    expect(events.slice(0, 2)).toEqual(["acquire", "setWebhook"]);
    await stop();
    expect(release).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe("release");
  });

  it("fails before webhook registration when the OS ingress lease is denied", async () => {
    const acquire = vi.fn(async () => {
      throw new Error("INGRESS_LEASE_HELD");
    });

    await expect(
      startTelegramWebhook({
        token: "tok",
        accountId: "opie",
        config: { bindings: [] },
        port: 0,
        ingressPolicy: {
          runtimeProfileId: "openclaw-primary",
          adapter: { acquire },
        },
      }),
    ).rejects.toThrow("INGRESS_LEASE_HELD");
    expect(setWebhookSpy).not.toHaveBeenCalled();
  });

  it("releases the OS ingress lease when webhook registration fails", async () => {
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ release }));
    setWebhookSpy.mockRejectedValueOnce(new Error("registration refused"));

    await expect(
      startTelegramWebhook({
        token: "tok",
        accountId: "opie",
        config: { bindings: [] },
        port: 0,
        ingressPolicy: {
          runtimeProfileId: "openclaw-primary",
          adapter: { acquire },
        },
      }),
    ).rejects.toThrow("Telegram webhook registration failed");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
