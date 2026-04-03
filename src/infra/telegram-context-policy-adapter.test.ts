import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTelegramContextPolicyAdapter } from "./telegram-context-policy-adapter.js";

const tempDirs: string[] = [];

function writeAdapter(dir: string) {
  const adapterPath = path.join(dir, "adapter.mjs");
  fs.writeFileSync(
    adapterPath,
    [
      "export function createTelegramContextPolicyAdapter() {",
      "  return {",
      "    shapeInboundContext(input) {",
      "      return { body: input.envelopeBody, untrustedContext: ['stub'] };",
      "    },",
      "  };",
      "}",
    ].join("\n"),
  );
  return adapterPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadTelegramContextPolicyAdapter", () => {
  it("returns null when disabled", async () => {
    const adapter = await loadTelegramContextPolicyAdapter({});
    expect(adapter).toBeNull();
  });

  it("loads an adapter when enabled", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-context-policy-"));
    tempDirs.push(tempDir);
    const adapterPath = writeAdapter(tempDir);
    const adapter = await loadTelegramContextPolicyAdapter({
      extensions: {
        telegramContextPolicy: {
          enabled: true,
          adapterPath,
        },
      },
    } as never);
    expect(adapter).not.toBeNull();
    const output = await adapter?.shapeInboundContext?.({
      sessionKey: "agent:main:test",
      chatId: "1",
      topicId: "237",
      historyLimit: 5,
      envelopeBody: "hello",
      pendingHistoryEntries: [],
    });
    expect(output).toEqual({ body: "hello", untrustedContext: ["stub"] });
  });
});
