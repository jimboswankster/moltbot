import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireTelegramIngressPolicyLease,
  loadTelegramIngressPolicyAdapter,
} from "./telegram-ingress-policy-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function writeAdapter(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-ingress-policy-"));
  tempDirs.push(dir);
  const adapterPath = path.join(dir, "adapter.mjs");
  fs.writeFileSync(adapterPath, source, "utf8");
  return adapterPath;
}

describe("Telegram ingress policy adapter", () => {
  it("preserves incumbent behavior when omitted or disabled", async () => {
    await expect(loadTelegramIngressPolicyAdapter({})).resolves.toBeNull();
    await expect(loadTelegramIngressPolicyAdapter({
      extensions: { telegramIngressPolicy: { enabled: false } },
    } as never)).resolves.toBeNull();
  });

  it("fails closed when enabled configuration is incomplete", async () => {
    await expect(loadTelegramIngressPolicyAdapter({
      extensions: { telegramIngressPolicy: { enabled: true } },
    } as never)).rejects.toThrow("adapterPath is missing");
    await expect(loadTelegramIngressPolicyAdapter({
      extensions: { telegramIngressPolicy: { enabled: true, adapterPath: "/tmp/adapter.mjs" } },
    } as never)).rejects.toThrow("runtimeProfileId is missing");
  });

  it("loads the adapter and binds exact target, profile, account, and mode", async () => {
    const adapterPath = writeAdapter([
      "export function createTelegramIngressPolicyAdapter(deps) {",
      "  return {",
      "    async acquire(input) {",
      "      if (input.runtimeProfileId !== deps.runtimeProfileId) throw new Error('profile mismatch');",
      "      return { async release() {} };",
      "    },",
      "  };",
      "}",
    ].join("\n"));
    const loaded = await loadTelegramIngressPolicyAdapter({
      extensions: {
        telegramIngressPolicy: { enabled: true, adapterPath, runtimeProfileId: "openclaw-primary" },
      },
    } as never);
    const acquire = vi.spyOn(loaded!.adapter, "acquire");
    const handle = await acquireTelegramIngressPolicyLease({ loaded, accountId: "default", mode: "polling" });
    expect(acquire).toHaveBeenCalledWith({
      target: "openclaw",
      runtimeProfileId: "openclaw-primary",
      accountId: "default",
      mode: "polling",
    });
    await expect(handle?.release()).resolves.toBeUndefined();
  });

  it("rejects malformed adapter handles", async () => {
    const adapterPath = writeAdapter(
      "export function createTelegramIngressPolicyAdapter() { return { async acquire() { return {}; } }; }",
    );
    const loaded = await loadTelegramIngressPolicyAdapter({
      extensions: {
        telegramIngressPolicy: { enabled: true, adapterPath, runtimeProfileId: "openclaw-primary" },
      },
    } as never);
    await expect(acquireTelegramIngressPolicyLease({
      loaded,
      accountId: "default",
      mode: "webhook",
    })).rejects.toThrow("invalid lease handle");
  });
});
