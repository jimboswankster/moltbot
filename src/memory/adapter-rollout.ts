import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { MemorySearchResult } from "./types.js";
import { recordRuntimeTelemetryEvent } from "../infra/runtime-telemetry.js";

export type MemoryBrokerRolloutMode = "off" | "shadow" | "canary" | "default_prefer" | "hardened";

export type MemoryBrokerRolloutState = {
  mode: MemoryBrokerRolloutMode;
  rollout_percent: number;
  legacy_fallback_hot: boolean;
};

export type MemoryBrokerRouteDecision = {
  backend: "legacy" | "adapter";
  reason:
    | "rollout_off"
    | "shadow_mode"
    | "non_canary_mode"
    | "canary_bucket_hit"
    | "canary_bucket_miss"
    | "adapter_unavailable";
  bucket: number;
  key: string;
};

type AdapterRunner = {
  search: (
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ) => Promise<MemorySearchResult[]>;
};

type RouteMemorySearchParams = {
  query: string;
  sessionKey?: string;
  maxResults?: number;
  minScore?: number;
  agentId: string;
  legacySearch: (opts: {
    query: string;
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  }) => Promise<MemorySearchResult[]>;
  // Test seam.
  adapterSearch?: (opts: {
    query: string;
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  }) => Promise<MemorySearchResult[]>;
  // Test seam.
  stateOverride?: MemoryBrokerRolloutState;
  // Test seam.
  adapterProbe?: () => Promise<AdapterRunner | null>;
};

type RouteMemorySearchResult = {
  results: MemorySearchResult[];
  chosenBackend: "legacy" | "adapter";
  decision: MemoryBrokerRouteDecision;
  degradationMode: "none" | "summary_only" | "fallback_mit";
};

let cachedAdapterRunner: AdapterRunner | null = null;
let cachedAdapterKey = "";

function resolveDefaultRolloutStatePath(): string {
  const configured = process.env.OPENCLAW_MEMORY_BROKER_ROLLOUT_STATE_FILE?.trim();
  if (configured) return path.resolve(configured);
  const home = process.env.HOME || "/Users/basecamp";
  return path.join(
    home,
    ".openclaw",
    "workspace",
    "os",
    "data",
    "memory-broker",
    "runtime",
    "rollout-state.json",
  );
}

function resolveTelemetryPath(kind: "query" | "errors"): string {
  const specific =
    kind === "query"
      ? process.env.OPENCLAW_MEMORY_BROKER_QUERY_TELEMETRY_FILE?.trim()
      : process.env.OPENCLAW_MEMORY_BROKER_ERROR_TELEMETRY_FILE?.trim();
  if (specific) return path.resolve(specific);

  const home = process.env.HOME || "/Users/basecamp";
  const day = new Date().toISOString().slice(0, 10);
  const file =
    kind === "query"
      ? `${day}-memory-broker-query-outcome.jsonl`
      : `${day}-memory-broker-errors.jsonl`;
  return path.join(
    home,
    ".openclaw",
    "workspace",
    "os",
    "data-telemetry",
    "memory-broker",
    kind,
    file,
  );
}

function appendJsonl(filePath: string, row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function safeTelemetryWrite(kind: "query" | "errors", row: Record<string, unknown>): void {
  if (String(process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY ?? "1").trim() === "0") {
    return;
  }
  try {
    appendJsonl(resolveTelemetryPath(kind), row);
  } catch {
    // Never destabilize tool path.
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

// SHA-256 first 32-bit window for deterministic, stable canary cohorting.
function stableHash32(input: string): number {
  const digest = createHash("sha256").update(input, "utf8").digest();
  return digest.readUInt32BE(0) >>> 0;
}

export function memoryBrokerCanaryBucket(key: string): number {
  const normalized =
    String(key || "")
      .trim()
      .toLowerCase() || "default";
  return stableHash32(normalized) % 100;
}

export function readMemoryBrokerRolloutState(
  filePath = resolveDefaultRolloutStatePath(),
): MemoryBrokerRolloutState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const mode = String(raw.mode || "off").toLowerCase();
    const mappedMode: MemoryBrokerRolloutMode =
      mode === "shadow" || mode === "canary" || mode === "default_prefer" || mode === "hardened"
        ? mode
        : "off";
    return {
      mode: mappedMode,
      rollout_percent: clampPercent(Number(raw.rollout_percent || 0)),
      legacy_fallback_hot: Boolean(raw.legacy_fallback_hot ?? true),
    };
  } catch {
    return {
      mode: "off",
      rollout_percent: 0,
      legacy_fallback_hot: true,
    };
  }
}

export function decideMemoryBrokerRoute(params: {
  state: MemoryBrokerRolloutState;
  routingKey: string;
  adapterAvailable: boolean;
}): MemoryBrokerRouteDecision {
  const key = String(params.routingKey || "").trim() || "default";
  const bucket = memoryBrokerCanaryBucket(key);
  const mode = params.state.mode;
  const pct = clampPercent(params.state.rollout_percent);

  if (mode === "off") {
    return {
      backend: "legacy",
      reason: "rollout_off",
      bucket,
      key,
    };
  }
  if (mode === "shadow") {
    return {
      backend: "legacy",
      reason: "shadow_mode",
      bucket,
      key,
    };
  }
  if (!params.adapterAvailable) {
    return {
      backend: "legacy",
      reason: "adapter_unavailable",
      bucket,
      key,
    };
  }
  if (mode === "canary") {
    if (bucket < pct) {
      return {
        backend: "adapter",
        reason: "canary_bucket_hit",
        bucket,
        key,
      };
    }
    return {
      backend: "legacy",
      reason: "canary_bucket_miss",
      bucket,
      key,
    };
  }
  return {
    backend: "adapter",
    reason: "non_canary_mode",
    bucket,
    key,
  };
}

function resolveAdapterModulePath(): string {
  const configured = process.env.OPENCLAW_MEMORY_ADAPTER_MODULE?.trim();
  if (configured) return path.resolve(configured);
  const home = process.env.HOME || "/Users/basecamp";
  return path.join(
    home,
    ".openclaw",
    "workspace",
    "os",
    "extensions",
    "memory-broker",
    "adapter-candidate-runner.ts",
  );
}

function resolveAdapterAllowedRoot(): string {
  const configured = process.env.OPENCLAW_MEMORY_ADAPTER_ALLOWED_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const home = process.env.HOME || "/Users/basecamp";
  return path.join(home, ".openclaw", "workspace", "os", "extensions", "memory-broker");
}

export function isAdapterModulePathAllowed(modulePath: string): boolean {
  try {
    const target = fs.realpathSync(path.resolve(modulePath));
    const allowedRoot = fs.realpathSync(resolveAdapterAllowedRoot());
    const rel = path.relative(allowedRoot, target);
    if (!rel || rel === ".") return false;
    const underRoot = !rel.startsWith("..") && !path.isAbsolute(rel);
    if (!underRoot) return false;
    const lower = target.toLowerCase();
    const validExt =
      lower.endsWith(".ts") ||
      lower.endsWith(".mts") ||
      lower.endsWith(".js") ||
      lower.endsWith(".mjs");
    return validExt;
  } catch {
    return false;
  }
}

async function getAdapterRunner(): Promise<AdapterRunner | null> {
  const modulePath = resolveAdapterModulePath();
  if (!fs.existsSync(modulePath)) {
    return null;
  }
  if (!isAdapterModulePathAllowed(modulePath)) {
    return null;
  }
  if (cachedAdapterRunner && cachedAdapterKey === modulePath) {
    return cachedAdapterRunner;
  }

  const runtimeDir = path.resolve(
    process.env.OPENCLAW_MEMORY_ADAPTER_RUNTIME_DIR?.trim() || process.cwd(),
  );
  const require = createRequire(import.meta.url);
  const jitiFactory = require("jiti");
  const jiti = jitiFactory(runtimeDir, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".js", ".mjs"],
  });
  const mod = await jiti.import(modulePath);
  const createRunner =
    mod?.createCandidateRunner || mod?.createMemoryCandidateRunner || mod?.default;
  if (typeof createRunner !== "function") {
    return null;
  }
  const runner = (await createRunner({ runtimeDir })) as AdapterRunner;
  if (!runner || typeof runner.search !== "function") {
    return null;
  }
  cachedAdapterKey = modulePath;
  cachedAdapterRunner = runner;
  return runner;
}

export async function routeMemorySearch(
  params: RouteMemorySearchParams,
): Promise<RouteMemorySearchResult> {
  const state = params.stateOverride || readMemoryBrokerRolloutState();
  const routingKey = `${params.agentId}:${params.sessionKey || params.query.slice(0, 80)}`;
  let adapterAvailable = typeof params.adapterSearch === "function";
  if (
    !adapterAvailable &&
    (state.mode === "canary" || state.mode === "default_prefer" || state.mode === "hardened")
  ) {
    try {
      const runner = params.adapterProbe ? await params.adapterProbe() : await getAdapterRunner();
      adapterAvailable = Boolean(runner);
    } catch {
      adapterAvailable = false;
    }
  }
  const decision = decideMemoryBrokerRoute({ state, routingKey, adapterAvailable });
  const startedAt = Date.now();

  const telemetryBase = {
    mode: state.mode,
    rollout_percent: state.rollout_percent,
    legacy_fallback_hot: state.legacy_fallback_hot,
    bucket: decision.bucket,
    reason: decision.reason,
    routing_key_hash: memoryBrokerCanaryBucket(routingKey),
    agent_id: params.agentId,
    has_session_key: Boolean(params.sessionKey),
  };

  try {
    if (decision.backend === "adapter") {
      const searchFn =
        params.adapterSearch ||
        (async (opts: {
          query: string;
          maxResults?: number;
          minScore?: number;
          sessionKey?: string;
        }) => {
          const runner = await getAdapterRunner();
          if (!runner) {
            throw new Error("adapter runner unavailable");
          }
          return await runner.search(opts.query, {
            maxResults: opts.maxResults,
            minScore: opts.minScore,
            sessionKey: opts.sessionKey,
          });
        });
      const results = await searchFn({
        query: params.query,
        maxResults: params.maxResults,
        minScore: params.minScore,
        sessionKey: params.sessionKey,
      });
      const latencyMs = Date.now() - startedAt;
      const row = {
        ts: new Date().toISOString(),
        event: "memory.broker.query.outcome",
        status: "ok",
        details: {
          ...telemetryBase,
          chosen_backend: "adapter",
          degradation_mode: "none",
          contradiction: false,
          stale: false,
          result_count: Array.isArray(results) ? results.length : 0,
          latency_ms: latencyMs,
        },
      };
      safeTelemetryWrite("query", row);
      recordRuntimeTelemetryEvent({
        event: "memory.broker.query.outcome",
        subsystem: "memory",
        status: "ok",
        details: row.details as Record<string, unknown>,
      });
      return {
        results,
        chosenBackend: "adapter",
        decision,
        degradationMode: "none",
      };
    }

    const results = await params.legacySearch({
      query: params.query,
      maxResults: params.maxResults,
      minScore: params.minScore,
      sessionKey: params.sessionKey,
    });
    const latencyMs = Date.now() - startedAt;
    const row = {
      ts: new Date().toISOString(),
      event: "memory.broker.query.outcome",
      status: "ok",
      details: {
        ...telemetryBase,
        chosen_backend: "legacy",
        degradation_mode: "none",
        contradiction: false,
        stale: false,
        result_count: Array.isArray(results) ? results.length : 0,
        latency_ms: latencyMs,
      },
    };
    safeTelemetryWrite("query", row);
    recordRuntimeTelemetryEvent({
      event: "memory.broker.query.outcome",
      subsystem: "memory",
      status: "ok",
      details: row.details as Record<string, unknown>,
    });
    return {
      results,
      chosenBackend: "legacy",
      decision,
      degradationMode: "none",
    };
  } catch (error) {
    if (decision.backend !== "adapter") {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const latencyMs = Date.now() - startedAt;
    const errorRow = {
      ts: new Date().toISOString(),
      event: "memory.broker.error",
      status: "failed",
      details: {
        ...telemetryBase,
        attempted_backend: decision.backend,
        fallback_backend: "legacy",
        error: message,
        latency_ms: latencyMs,
        phase: "primary_search",
      },
    };
    safeTelemetryWrite("errors", errorRow);
    recordRuntimeTelemetryEvent({
      event: "memory.broker.error",
      subsystem: "memory",
      status: "failed",
      severity: "warning",
      details: errorRow.details as Record<string, unknown>,
    });
    try {
      const fallbackResults = await params.legacySearch({
        query: params.query,
        maxResults: params.maxResults,
        minScore: params.minScore,
        sessionKey: params.sessionKey,
      });
      const summaryOnly = summarizeMemoryResults(fallbackResults);
      safeTelemetryWrite("query", {
        ts: new Date().toISOString(),
        event: "memory.broker.query.outcome",
        status: "degraded",
        details: {
          ...telemetryBase,
          chosen_backend: "legacy",
          degradation_mode: "summary_only",
          contradiction: false,
          stale: true,
          result_count: Array.isArray(summaryOnly) ? summaryOnly.length : 0,
          latency_ms: latencyMs,
        },
      });
      return {
        results: summaryOnly,
        chosenBackend: "legacy",
        decision,
        degradationMode: "summary_only",
      };
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      safeTelemetryWrite("errors", {
        ts: new Date().toISOString(),
        event: "memory.broker.error",
        status: "failed",
        details: {
          ...telemetryBase,
          attempted_backend: "legacy",
          fallback_backend: "none",
          error: fallbackMessage,
          latency_ms: Date.now() - startedAt,
          phase: "legacy_fallback",
        },
      });
      safeTelemetryWrite("query", {
        ts: new Date().toISOString(),
        event: "memory.broker.query.outcome",
        status: "degraded",
        details: {
          ...telemetryBase,
          chosen_backend: "legacy",
          degradation_mode: "summary_only",
          contradiction: false,
          stale: true,
          result_count: 0,
          latency_ms: Date.now() - startedAt,
        },
      });
      return {
        results: [],
        chosenBackend: "legacy",
        decision,
        degradationMode: "summary_only",
      };
    }
  }
}

function summarizeMemoryResults(results: MemorySearchResult[]): MemorySearchResult[] {
  if (!Array.isArray(results) || results.length === 0) return [];
  const first = results[0];
  const snippet = String(first?.snippet || "");
  const maxChars = 320;
  return [
    {
      ...first,
      snippet: snippet.length <= maxChars ? snippet : `${snippet.slice(0, maxChars)}...`,
    },
  ];
}
