import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type GatewayShutdownIntent = {
  version: 1;
  ts: string;
  pid: number;
  initiator: string;
  action: "stop" | "restart";
  reason?: string;
  details?: Record<string, unknown>;
};

const INTENT_FILENAME = "gateway-shutdown-intent.json";

export function resolveGatewayShutdownIntentPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), INTENT_FILENAME);
}

export function readGatewayShutdownIntentSync(
  env: NodeJS.ProcessEnv = process.env,
): GatewayShutdownIntent | null {
  const filePath = resolveGatewayShutdownIntentPath(env);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as GatewayShutdownIntent | null;
    if (!parsed || parsed.version !== 1 || !parsed.ts || !parsed.initiator || !parsed.action) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeGatewayShutdownIntentSync(
  payload: Omit<GatewayShutdownIntent, "version" | "ts" | "pid"> & {
    ts?: string;
    pid?: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = resolveGatewayShutdownIntentPath(env);
  const data: GatewayShutdownIntent = {
    version: 1,
    ts: payload.ts || new Date().toISOString(),
    pid: payload.pid ?? process.pid,
    initiator: payload.initiator,
    action: payload.action,
    reason: payload.reason,
    details: payload.details || {},
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return filePath;
}

export function consumeRecentGatewayShutdownIntentSync(opts?: {
  env?: NodeJS.ProcessEnv;
  maxAgeMs?: number;
  nowMs?: number;
}): GatewayShutdownIntent | null {
  const env = opts?.env || process.env;
  const maxAgeMs = Math.max(0, opts?.maxAgeMs ?? 60_000);
  const nowMs = opts?.nowMs ?? Date.now();
  const filePath = resolveGatewayShutdownIntentPath(env);
  const parsed = readGatewayShutdownIntentSync(env);
  if (!parsed) {
    return null;
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best-effort consumption
  }
  const tsMs = Date.parse(parsed.ts);
  if (!Number.isFinite(tsMs)) {
    return null;
  }
  if (Math.abs(nowMs - tsMs) > maxAgeMs) {
    return null;
  }
  return parsed;
}
