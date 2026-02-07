import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadStreamBufferAdapter } from "./stream-buffer-adapter.js";

function writeAdapter(tempDir: string): string {
  const filePath = path.join(tempDir, "adapter.mjs");
  fs.writeFileSync(
    filePath,
    "export default function adapter(input){ return { allow: true, stage: 'none' }; }\n",
    "utf-8",
  );
  return filePath;
}

describe("stream buffer adapter loader", () => {
  it("returns null when disabled", async () => {
    const adapter = await loadStreamBufferAdapter({
      extensions: { streamBuffer: { enabled: false } },
    });
    expect(adapter).toBeNull();
  });

  it("returns null when enabled but adapterPath missing", async () => {
    const adapter = await loadStreamBufferAdapter({
      extensions: { streamBuffer: { enabled: true } },
    });
    expect(adapter).toBeNull();
  });

  it("loads adapter function from path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-buffer-"));
    const adapterPath = writeAdapter(tempDir);
    const adapter = await loadStreamBufferAdapter({
      extensions: { streamBuffer: { enabled: true, adapterPath } },
    });
    expect(adapter).toBeTypeOf("function");
    const decision = adapter?.({
      sessionKey: "s",
      runId: "r",
      seq: 1,
      text: "hi",
      timestamp: Date.now(),
    });
    expect(decision?.allow).toBe(true);
  });

  it("loads workspace adapter when present", async () => {
    const workspaceRoot =
      process.env.OPENCLAW_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");
    const adapterPath = path.join(
      workspaceRoot,
      "os",
      "extensions",
      "rate-limiting-buffer",
      "adapter.mjs",
    );
    if (!fs.existsSync(adapterPath)) {
      return;
    }
    const adapter = await loadStreamBufferAdapter({
      extensions: { streamBuffer: { enabled: true, adapterPath } },
    });
    expect(adapter).toBeTypeOf("function");
  });
});
