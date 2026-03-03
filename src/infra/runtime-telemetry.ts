import fs from "node:fs";
import path from "node:path";

export type RuntimeTelemetryEvent = {
  ts?: string;
  event: string;
  subsystem: string;
  severity?: "info" | "warning" | "error";
  status?: "ok" | "degraded" | "failed";
  details?: Record<string, unknown>;
};

function resolveRuntimeTelemetryPath(): string {
  const configured = process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE?.trim();
  if (configured) {
    return configured;
  }
  return resolveLegacyRuntimeTelemetryPath();
}

function resolveLegacyRuntimeTelemetryPath(): string {
  const home = process.env.HOME || "/Users/basecamp";
  return path.join(home, ".openclaw", "logs", "runtime-telemetry.jsonl");
}

export function recordRuntimeTelemetryEvent(event: RuntimeTelemetryEvent): void {
  const target = resolveRuntimeTelemetryPath();
  const legacy = resolveLegacyRuntimeTelemetryPath();
  const writeLegacyCompat =
    String(process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY ?? "1").trim() !== "0";
  const row = {
    ts: event.ts || new Date().toISOString(),
    event: event.event,
    subsystem: event.subsystem,
    severity: event.severity || "info",
    status: event.status || "ok",
    details: event.details || {},
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(row)}\n`, "utf8");
    // Compatibility mirror for legacy readers until explicit cutover.
    if (writeLegacyCompat && legacy !== target) {
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.appendFileSync(legacy, `${JSON.stringify(row)}\n`, "utf8");
    }
  } catch {
    // Best-effort only: runtime telemetry must never destabilize gateway paths.
  }
}
