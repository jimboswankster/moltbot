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
  const home = process.env.HOME || "/Users/basecamp";
  return path.join(home, ".openclaw", "logs", "runtime-telemetry.jsonl");
}

export function recordRuntimeTelemetryEvent(event: RuntimeTelemetryEvent): void {
  const target = resolveRuntimeTelemetryPath();
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
  } catch {
    // Best-effort only: runtime telemetry must never destabilize gateway paths.
  }
}
