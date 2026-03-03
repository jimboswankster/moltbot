import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordRuntimeTelemetryEvent } from "./runtime-telemetry.js";

const originalHome = process.env.HOME;
const originalTarget = process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
const originalLegacy = process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTarget === undefined) delete process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
  else process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = originalTarget;
  if (originalLegacy === undefined) delete process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY;
  else process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = originalLegacy;
});

describe("runtime telemetry sink routing", () => {
  it("writes to legacy sink by default", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rt-"));
    process.env.HOME = home;
    delete process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "1";

    recordRuntimeTelemetryEvent({
      event: "test.event",
      subsystem: "test",
      details: { marker: "legacy-default" },
    });

    const canonical = path.join(
      home,
      ".openclaw",
      "workspace",
      "os",
      "data-telemetry",
      "audits",
      "telemetry",
      "events",
      "runtime-telemetry.jsonl",
    );
    const legacy = path.join(home, ".openclaw", "logs", "runtime-telemetry.jsonl");

    expect(fs.existsSync(canonical)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
    const row = JSON.parse(fs.readFileSync(legacy, "utf8").trim()) as {
      event?: string;
      details?: Record<string, unknown>;
    };
    expect(row.event).toBe("test.event");
    expect(row.details?.marker).toBe("legacy-default");
  });

  it("supports explicit telemetry file override with no legacy mirror when disabled", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rt-override-"));
    process.env.HOME = home;
    const explicit = path.join(home, "custom", "runtime.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = explicit;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";

    recordRuntimeTelemetryEvent({
      event: "test.override",
      subsystem: "test",
      details: { marker: "override" },
    });

    expect(fs.existsSync(explicit)).toBe(true);
    const row = JSON.parse(fs.readFileSync(explicit, "utf8").trim()) as {
      event?: string;
      details?: Record<string, unknown>;
    };
    expect(row.event).toBe("test.override");
    expect(row.details?.marker).toBe("override");
  });

  it("supports explicit canonical path with legacy compatibility mirror", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rt-canon-"));
    process.env.HOME = home;
    const canonical = path.join(
      home,
      ".openclaw",
      "workspace",
      "os",
      "data-telemetry",
      "audits",
      "telemetry",
      "events",
      "runtime-telemetry.jsonl",
    );
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = canonical;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "1";

    recordRuntimeTelemetryEvent({
      event: "test.canonical",
      subsystem: "test",
      details: { marker: "canonical-with-mirror" },
    });

    const legacy = path.join(home, ".openclaw", "logs", "runtime-telemetry.jsonl");
    expect(fs.existsSync(canonical)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
  });
});
