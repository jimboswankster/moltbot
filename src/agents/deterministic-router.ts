import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordRuntimeTelemetryEvent } from "../infra/runtime-telemetry.js";
import { logWarn } from "../logger.js";

type Tier = "W1A" | "W1B" | "V2" | "E3";

type LaneRule = {
  id: string;
  enabled?: boolean;
  if?: {
    taskClassesAny?: string[];
  };
  then?: {
    lane?: string;
    workerTier?: Tier;
    workerModel?: string;
    strictFallbackProviderFamily?: boolean;
    allowedFallbackProviders?: string[];
  };
};

type RoutingPolicy = {
  enabled?: boolean;
  defaults?: {
    lane?: string;
    workerTier?: Tier;
    workerModel?: string;
    strictFallbackProviderFamily?: boolean;
    allowedFallbackProviders?: string[];
  };
  laneRules?: LaneRule[];
};

export type RoutingHints = {
  taskClass?: string;
  lane?: string;
  source: "envelope" | "keyword" | "default";
};

export type RoutingDecision = {
  applied: boolean;
  policyPath: string | null;
  ruleId: string | null;
  source: RoutingHints["source"];
  lane: string | null;
  tier: Tier | null;
  modelRef: string | null;
  provider: string | null;
  model: string | null;
  strictFallbackProviderFamily: boolean;
  allowedFallbackProviders: string[];
  reason: string;
};

const ROUTING_POLICY_ENV = "OPENCLAW_ROUTING_POLICY_PATH";
const ROUTING_POLICY_ERROR_COOLDOWN_MS = 10 * 60 * 1000;
let lastRoutingPolicyLoadErrorAt: number | null = null;

function defaultRoutingPolicyPath(): string {
  return path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    "os",
    "config",
    "routing-policy.v1.json",
  );
}

function normalize(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function shouldBypassDeterministicRouting(hints: RoutingHints): boolean {
  const lane = normalize(hints.lane);
  if (!lane) return false;
  return lane.startsWith("fallback:") || lane.startsWith("auth-probe:");
}

function parseModelRef(modelRef: string): { provider: string; model: string } | null {
  const raw = String(modelRef).trim();
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash >= raw.length - 1) return null;
  const provider = raw.slice(0, slash).trim();
  const model = raw.slice(slash + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

function normalizeProviderList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalize(raw);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseRoutingEnvelope(text: string): Partial<RoutingHints> {
  const out: Partial<RoutingHints> = {};
  const normalized = String(text);
  const taskClassMatch =
    normalized.match(/(?:^|\n)\s*task_class\s*[:=]\s*([a-zA-Z0-9._-]+)/i) ||
    normalized.match(/\[task_class\s*[:=]\s*([a-zA-Z0-9._-]+)\]/i);
  if (taskClassMatch) out.taskClass = taskClassMatch[1];
  const laneMatch =
    normalized.match(/(?:^|\n)\s*lane\s*[:=]\s*([a-zA-Z0-9._-]+)/i) ||
    normalized.match(/\[lane\s*[:=]\s*([a-zA-Z0-9._-]+)\]/i);
  if (laneMatch) out.lane = laneMatch[1];
  return out;
}

function inferTaskClassFromKeywords(text: string): string | undefined {
  const t = normalize(text);
  if (!t) return undefined;
  if (
    t.includes("policy") ||
    t.includes("protocol") ||
    t.includes("architecture") ||
    t.includes("tradeoff") ||
    t.includes("reasoning") ||
    t.includes("risk")
  ) {
    return "policy-review";
  }
  if (
    t.includes("code") ||
    t.includes("refactor") ||
    t.includes("implement") ||
    t.includes("bugfix") ||
    t.includes("test")
  ) {
    return "implementation";
  }
  return undefined;
}

export function extractRoutingHints(params: {
  prompt: string;
  extraSystemPrompt?: string;
  lane?: string;
}): RoutingHints {
  const envelopePrompt = parseRoutingEnvelope(params.prompt);
  const envelopeSystem = parseRoutingEnvelope(params.extraSystemPrompt ?? "");
  const taskClass = envelopePrompt.taskClass || envelopeSystem.taskClass;
  const lane = envelopePrompt.lane || envelopeSystem.lane || params.lane;
  if (taskClass || lane) {
    return {
      taskClass: taskClass ? normalize(taskClass) : undefined,
      lane: lane ? normalize(lane) : undefined,
      source: "envelope",
    };
  }

  const inferredTaskClass = inferTaskClassFromKeywords(
    `${params.prompt}\n${params.extraSystemPrompt ?? ""}`,
  );
  if (inferredTaskClass || params.lane) {
    return {
      taskClass: inferredTaskClass,
      lane: params.lane ? normalize(params.lane) : undefined,
      source: "keyword",
    };
  }

  return { source: "default" };
}

export async function loadRoutingPolicy(): Promise<{
  policy: RoutingPolicy | null;
  policyPath: string | null;
}> {
  const policyPath = process.env[ROUTING_POLICY_ENV]?.trim() || defaultRoutingPolicyPath();
  try {
    const raw = await fs.readFile(policyPath, "utf8");
    const parsed = JSON.parse(raw) as RoutingPolicy;
    if (!parsed || parsed.enabled !== true) {
      return { policy: null, policyPath };
    }
    return { policy: parsed, policyPath };
  } catch (err) {
    const code =
      err && typeof err === "object" ? String((err as { code?: unknown }).code ?? "") : "";
    // Missing policy file is expected for deployments that don't use deterministic routing.
    if (code !== "ENOENT") {
      const now = Date.now();
      const shouldWarn =
        !lastRoutingPolicyLoadErrorAt ||
        now - lastRoutingPolicyLoadErrorAt >= ROUTING_POLICY_ERROR_COOLDOWN_MS;
      if (shouldWarn) {
        lastRoutingPolicyLoadErrorAt = now;
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`deterministic routing policy load failed (${policyPath}): ${message}`);
        recordRuntimeTelemetryEvent({
          event: "agent.model_route_policy_load_failed",
          subsystem: "agent-routing",
          severity: "warning",
          status: "degraded",
          details: {
            policyPath,
            code: code || null,
            message,
          },
        });
      }
    }
    return { policy: null, policyPath };
  }
}

function chooseRule(policy: RoutingPolicy, hints: RoutingHints): LaneRule | null {
  const rules = Array.isArray(policy.laneRules) ? policy.laneRules : [];
  const hintTask = normalize(hints.taskClass);
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const taskClasses = (rule.if?.taskClassesAny ?? []).map((v) => normalize(v));
    if (!taskClasses.length) continue;
    if (hintTask && taskClasses.includes(hintTask)) return rule;
  }
  return null;
}

export function decideDeterministicRoute(params: {
  policy: RoutingPolicy | null;
  policyPath: string | null;
  hints: RoutingHints;
  provider: string;
  model: string;
}): RoutingDecision {
  if (shouldBypassDeterministicRouting(params.hints)) {
    return {
      applied: false,
      policyPath: params.policyPath,
      ruleId: null,
      source: params.hints.source,
      lane: params.hints.lane ?? null,
      tier: null,
      modelRef: null,
      provider: params.provider,
      model: params.model,
      strictFallbackProviderFamily: false,
      allowedFallbackProviders: [],
      reason: "deterministic routing bypassed for explicit fallback/probe lane",
    };
  }
  if (!params.policy) {
    return {
      applied: false,
      policyPath: params.policyPath,
      ruleId: null,
      source: params.hints.source,
      lane: null,
      tier: null,
      modelRef: null,
      provider: null,
      model: null,
      strictFallbackProviderFamily: false,
      allowedFallbackProviders: [],
      reason: "routing policy unavailable or disabled",
    };
  }

  const matched = chooseRule(params.policy, params.hints);
  const defaults = params.policy.defaults;
  const strictFallbackProviderFamily =
    matched?.then?.strictFallbackProviderFamily ?? defaults?.strictFallbackProviderFamily ?? false;
  const allowedFallbackProviders = normalizeProviderList(
    matched?.then?.allowedFallbackProviders ?? defaults?.allowedFallbackProviders,
  );
  const modelRef = matched?.then?.workerModel || defaults?.workerModel || null;
  const parsedRef = modelRef ? parseModelRef(modelRef) : null;
  if (!parsedRef) {
    return {
      applied: false,
      policyPath: params.policyPath,
      ruleId: matched?.id ?? null,
      source: params.hints.source,
      lane: matched?.then?.lane || defaults?.lane || null,
      tier: matched?.then?.workerTier || defaults?.workerTier || null,
      modelRef,
      provider: null,
      model: null,
      strictFallbackProviderFamily,
      allowedFallbackProviders,
      reason: "no valid model ref in matched/default route",
    };
  }

  const chosenProvider = parsedRef.provider;
  const chosenModel = parsedRef.model;
  const sameAsCurrent =
    normalize(chosenProvider) === normalize(params.provider) &&
    normalize(chosenModel) === normalize(params.model);

  return {
    applied: !sameAsCurrent,
    policyPath: params.policyPath,
    ruleId: matched?.id ?? null,
    source: params.hints.source,
    lane: matched?.then?.lane || defaults?.lane || null,
    tier: matched?.then?.workerTier || defaults?.workerTier || null,
    modelRef,
    provider: chosenProvider,
    model: chosenModel,
    strictFallbackProviderFamily,
    allowedFallbackProviders,
    reason: sameAsCurrent
      ? "matched route equals current provider/model"
      : "applied deterministic route",
  };
}
