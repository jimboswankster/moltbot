import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type TacLike = {
  makeCacheKey: (input: {
    toolName: string;
    params: Record<string, unknown>;
    toolVersion?: string;
  }) => string;
  get: (cacheKey: string) => Record<string, unknown> | null;
  set: (input: Record<string, unknown>) => Record<string, unknown> | null;
};

type Mode = "shadow" | "primary";

type BridgeState = {
  enabled: boolean;
  mode: Mode;
  cache: TacLike | null;
};

const statePromise: Promise<BridgeState> = initBridge();

type TacOutcomeInput = {
  toolName: string;
  operation: "read" | "write";
  outcome: "hit" | "miss" | "stored" | "policy_denied_or_rejected";
  provider?: string;
  model?: string;
};

function resolveDefaults() {
  const home = process.env.HOME || "";
  const workspace = path.join(home, ".openclaw", "workspace");
  const adapterPath = path.join(
    workspace,
    "os",
    "extensions",
    "tool-artifact-cache",
    "adapter.mjs",
  );
  const policyModulePath = path.join(
    workspace,
    "os",
    "extensions",
    "tool-artifact-cache",
    "policy.mjs",
  );
  const policyPath = path.join(workspace, "os", "config", "tool-artifact-policy.json");
  const storePath = path.join(workspace, "os", "state", "tool-artifact-cache.json");
  return { adapterPath, policyModulePath, policyPath, storePath };
}

function parseEnabled(raw: string | undefined): boolean {
  const value = (raw || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function parseMode(raw: string | undefined): Mode {
  const value = (raw || "").trim().toLowerCase();
  return value === "primary" ? "primary" : "shadow";
}

function resolveTelemetryEventsPath(): string | null {
  const explicitPath = process.env.OPENCLAW_TOOL_TELEMETRY_EVENTS_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (!workspaceDir) {
    return null;
  }
  const day = new Date().toISOString().slice(0, 10);
  return path.join(
    workspaceDir,
    "os",
    "data-telemetry",
    "audits",
    "tool-telemetry",
    "events",
    `tool-telemetry-${day}.jsonl`,
  );
}

function emitTacOutcome(input: TacOutcomeInput): void {
  const outPath = resolveTelemetryEventsPath();
  if (!outPath) return;
  const record = {
    ts: new Date().toISOString(),
    hook: "tool_artifact_cache_outcome",
    toolName: input.toolName,
    operation: input.operation,
    cacheOutcome: input.outcome,
    provider: input.provider,
    model: input.model,
  };
  void fsPromises
    .mkdir(path.dirname(outPath), { recursive: true })
    .then(() => fsPromises.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8"))
    .catch(() => {
      // Fail-open: cache bridge should not fail tool execution on telemetry writes.
    });
}

async function initBridge(): Promise<BridgeState> {
  if (!parseEnabled(process.env.OPENCLAW_TOOL_ARTIFACT_CACHE_ENABLED)) {
    return { enabled: false, mode: "shadow", cache: null };
  }

  const defaults = resolveDefaults();
  const adapterPath = process.env.OPENCLAW_TOOL_ARTIFACT_CACHE_ADAPTER_PATH || defaults.adapterPath;
  const policyModulePath =
    process.env.OPENCLAW_TOOL_ARTIFACT_POLICY_MODULE_PATH || defaults.policyModulePath;
  const policyPath = process.env.OPENCLAW_TOOL_ARTIFACT_POLICY_PATH || defaults.policyPath;
  const storePath = process.env.OPENCLAW_TOOL_ARTIFACT_CACHE_STORE_PATH || defaults.storePath;
  const mode = parseMode(process.env.OPENCLAW_TOOL_ARTIFACT_CACHE_MODE);

  try {
    const adapterMod = (await import(pathToFileURL(adapterPath).href)) as Record<string, unknown>;
    const createCache =
      (adapterMod.createToolArtifactCache as
        | ((input: Record<string, unknown>) => TacLike)
        | undefined) ??
      (adapterMod.default as ((input: Record<string, unknown>) => TacLike) | undefined);
    if (typeof createCache !== "function") {
      throw new Error("Tool artifact cache adapter export missing createToolArtifactCache/default");
    }

    let policyResolver: ((input: Record<string, unknown>) => Record<string, unknown>) | null = null;
    try {
      const policyMod = (await import(pathToFileURL(policyModulePath).href)) as Record<
        string,
        unknown
      >;
      const createPolicyResolverFromFile =
        (policyMod.createPolicyResolverFromFile as
          | ((p: string) => (input: Record<string, unknown>) => Record<string, unknown>)
          | undefined) ?? null;
      if (createPolicyResolverFromFile) {
        policyResolver = createPolicyResolverFromFile(policyPath);
      }
    } catch {
      // Optional; adapter can run without policy resolver.
    }

    const cache = createCache({
      cacheFilePath: storePath,
      policyResolver,
    });
    return { enabled: true, mode, cache };
  } catch (error) {
    console.warn(`[tool-artifact-cache] disabled due to init error: ${String(error)}`);
    return { enabled: false, mode: "shadow", cache: null };
  }
}

export async function readFromToolArtifactCache(input: {
  toolName: string;
  cacheParams: Record<string, unknown>;
  provider?: string;
  model?: string;
}): Promise<{ value: Record<string, unknown>; cacheKey: string } | null> {
  const state = await statePromise;
  if (!state.enabled || !state.cache || state.mode !== "primary") {
    return null;
  }

  const cacheKey = state.cache.makeCacheKey({
    toolName: input.toolName,
    params: input.cacheParams,
    toolVersion: "v1",
  });
  const hit = state.cache.get(cacheKey);
  const value = (hit?.payloadRef as Record<string, unknown> | undefined) ?? null;
  if (!value) {
    emitTacOutcome({
      toolName: input.toolName,
      operation: "read",
      outcome: "miss",
      provider: input.provider,
      model: input.model,
    });
    return null;
  }
  emitTacOutcome({
    toolName: input.toolName,
    operation: "read",
    outcome: "hit",
    provider: input.provider,
    model: input.model,
  });
  return { value, cacheKey };
}

export async function writeToToolArtifactCache(input: {
  toolName: string;
  provider?: string;
  model?: string;
  providerHints?: Record<string, unknown>;
  artifactClass: string;
  cacheParams: Record<string, unknown>;
  value: Record<string, unknown>;
  ttlMs?: number;
  summary?: string;
  frozenCandidate?: boolean;
}): Promise<void> {
  const state = await statePromise;
  if (!state.enabled || !state.cache) {
    return;
  }

  const cacheKey = state.cache.makeCacheKey({
    toolName: input.toolName,
    params: input.cacheParams,
    toolVersion: "v1",
  });

  const now = Date.now();
  const expiresAt =
    typeof input.ttlMs === "number" && input.ttlMs > 0 ? now + input.ttlMs : undefined;

  const writeResult = state.cache.set({
    cacheKey,
    toolName: input.toolName,
    provider: input.provider,
    model: input.model,
    artifactClass: input.artifactClass,
    frozenCandidate: input.frozenCandidate === true,
    summary: input.summary ?? "",
    payloadRef: input.value,
    providerHints: input.providerHints,
    estimatedChars: JSON.stringify(input.value).length,
    expiresAt,
  });
  emitTacOutcome({
    toolName: input.toolName,
    operation: "write",
    outcome: writeResult ? "stored" : "policy_denied_or_rejected",
    provider: input.provider,
    model: input.model,
  });
}
