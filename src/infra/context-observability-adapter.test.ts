import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContextObservabilityAdapter } from "./context-observability-adapter.js";

describe("loadContextObservabilityAdapter", () => {
  it("returns null when disabled", async () => {
    const adapter = await loadContextObservabilityAdapter({});
    expect(adapter).toBeNull();
  });

  it("loads an adapter from workspace path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-obsv-"));
    const adapterPath = path.join(tempDir, "adapter.mjs");
    fs.writeFileSync(
      adapterPath,
      [
        "export function createContextObservabilityAdapter() {",
        "  return { onTelegramContextComposed() {}, onAgentContextPrepared() {} };",
        "}",
      ].join("\n"),
      "utf8",
    );
    const adapter = await loadContextObservabilityAdapter({
      extensions: {
        contextObservability: {
          enabled: true,
          adapterPath,
        },
      },
    } as never);
    expect(adapter).not.toBeNull();
    expect(typeof adapter?.onTelegramContextComposed).toBe("function");
    expect(typeof adapter?.onAgentContextPrepared).toBe("function");
  });
});
