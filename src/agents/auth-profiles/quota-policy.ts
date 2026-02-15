import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import { normalizeProviderId } from "../model-selection.js";

type ProviderQuotaCaps = {
  rpm?: number;
  tpm?: number;
  rph?: number;
  tph?: number;
  rpd?: number;
  tpd?: number;
  rpmonth?: number;
  tpmonth?: number;
};

type RoutingBudgetPolicy = {
  enabled?: boolean;
  activeTier?: "free" | "paid" | "frontier" | "all";
  providerTiers?: Record<string, "free" | "paid" | "frontier">;
  providerCaps?: Record<string, ProviderQuotaCaps>;
};

type CachedPolicy = {
  path: string;
  loadedAt: number;
  mtimeMs: number;
  policy: RoutingBudgetPolicy | null;
};

let policyCache: CachedPolicy | null = null;

function resolveRoutingPolicyPath(): string {
  const envPath = process.env.OPENCLAW_ROUTING_POLICY_PATH?.trim();
  if (envPath) {
    return envPath;
  }
  return path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    "os",
    "config",
    "routing-budget-policy.json",
  );
}

function loadRoutingPolicy(): RoutingBudgetPolicy | null {
  const filePath = resolveRoutingPolicyPath();
  const now = Date.now();
  const ttlMs = 2000;

  try {
    if (!fs.existsSync(filePath)) {
      policyCache = { path: filePath, loadedAt: now, mtimeMs: 0, policy: null };
      return null;
    }
    const st = fs.statSync(filePath);
    const mtimeMs = st.mtimeMs || 0;

    if (
      policyCache &&
      policyCache.path === filePath &&
      now - policyCache.loadedAt < ttlMs &&
      policyCache.mtimeMs === mtimeMs
    ) {
      return policyCache.policy;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as RoutingBudgetPolicy;
    const policy = parsed && typeof parsed === "object" ? parsed : null;
    policyCache = { path: filePath, loadedAt: now, mtimeMs, policy };
    return policy;
  } catch {
    policyCache = { path: filePath, loadedAt: now, mtimeMs: 0, policy: null };
    return null;
  }
}

function isPolicyEnabled(policy: RoutingBudgetPolicy | null): boolean {
  const env = process.env.OPENCLAW_ROUTING_POLICY_ENABLED?.trim().toLowerCase();
  if (env === "1" || env === "true" || env === "yes") {
    return true;
  }
  return Boolean(policy?.enabled);
}

function resolveProviderCaps(provider: string): ProviderQuotaCaps | null {
  const policy = loadRoutingPolicy();
  if (!isPolicyEnabled(policy)) {
    return null;
  }
  if (!policy?.providerCaps || typeof policy.providerCaps !== "object") {
    return null;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [key, caps] of Object.entries(policy.providerCaps)) {
    if (normalizeProviderId(key) === providerKey && caps && typeof caps === "object") {
      return caps;
    }
  }
  return null;
}

function floorWindow(now: number, kind: "minute" | "hour" | "day" | "month"): number {
  const d = new Date(now);
  if (kind === "minute") {
    d.setSeconds(0, 0);
  } else if (kind === "hour") {
    d.setMinutes(0, 0, 0);
  } else if (kind === "day") {
    d.setHours(0, 0, 0, 0);
  } else {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  }
  return d.getTime();
}

function normalizeWindow(
  stats: ProfileUsageStats,
  kind: "minute" | "hour" | "day" | "month",
  now: number,
): { windowStart: number; requests: number; tokens: number } {
  const expectedStart = floorWindow(now, kind);
  const current = stats.quotaWindows?.[kind];
  if (!current || current.windowStart !== expectedStart) {
    return { windowStart: expectedStart, requests: 0, tokens: 0 };
  }
  return {
    windowStart: current.windowStart,
    requests: Math.max(0, Number(current.requests || 0)),
    tokens: Math.max(0, Number(current.tokens || 0)),
  };
}

export function updateQuotaWindows(params: {
  stats: ProfileUsageStats;
  now: number;
  tokensUsed: number;
}): ProfileUsageStats {
  const { stats, now, tokensUsed } = params;
  const minute = normalizeWindow(stats, "minute", now);
  const hour = normalizeWindow(stats, "hour", now);
  const day = normalizeWindow(stats, "day", now);
  const month = normalizeWindow(stats, "month", now);

  const safeTokens = Math.max(0, Math.round(tokensUsed));

  minute.requests += 1;
  minute.tokens += safeTokens;
  hour.requests += 1;
  hour.tokens += safeTokens;
  day.requests += 1;
  day.tokens += safeTokens;
  month.requests += 1;
  month.tokens += safeTokens;

  return {
    ...stats,
    quotaWindows: { minute, hour, day, month },
  };
}

export function isProfileOverQuotaByPolicy(params: {
  provider: string;
  profileId: string;
  store: AuthProfileStore;
  now?: number;
}): boolean {
  const caps = resolveProviderCaps(params.provider);
  if (!caps) {
    return false;
  }
  const now = params.now ?? Date.now();
  const stats = params.store.usageStats?.[params.profileId] ?? {};
  const minute = normalizeWindow(stats, "minute", now);
  const hour = normalizeWindow(stats, "hour", now);
  const day = normalizeWindow(stats, "day", now);
  const month = normalizeWindow(stats, "month", now);

  if (
    typeof caps.rpm === "number" &&
    Number.isFinite(caps.rpm) &&
    caps.rpm > 0 &&
    minute.requests >= caps.rpm
  )
    return true;
  if (
    typeof caps.tpm === "number" &&
    Number.isFinite(caps.tpm) &&
    caps.tpm > 0 &&
    minute.tokens >= caps.tpm
  )
    return true;
  if (
    typeof caps.rph === "number" &&
    Number.isFinite(caps.rph) &&
    caps.rph > 0 &&
    hour.requests >= caps.rph
  )
    return true;
  if (
    typeof caps.tph === "number" &&
    Number.isFinite(caps.tph) &&
    caps.tph > 0 &&
    hour.tokens >= caps.tph
  )
    return true;
  if (
    typeof caps.rpd === "number" &&
    Number.isFinite(caps.rpd) &&
    caps.rpd > 0 &&
    day.requests >= caps.rpd
  )
    return true;
  if (
    typeof caps.tpd === "number" &&
    Number.isFinite(caps.tpd) &&
    caps.tpd > 0 &&
    day.tokens >= caps.tpd
  )
    return true;
  if (
    typeof caps.rpmonth === "number" &&
    Number.isFinite(caps.rpmonth) &&
    caps.rpmonth > 0 &&
    month.requests >= caps.rpmonth
  )
    return true;
  if (
    typeof caps.tpmonth === "number" &&
    Number.isFinite(caps.tpmonth) &&
    caps.tpmonth > 0 &&
    month.tokens >= caps.tpmonth
  )
    return true;
  return false;
}

export function isProviderAllowedByBudget(provider: string): boolean {
  const policy = loadRoutingPolicy();
  if (!isPolicyEnabled(policy)) {
    return true;
  }
  if (!policy) {
    return true;
  }
  const activeTier = policy.activeTier ?? "all";
  if (activeTier === "all") {
    return true;
  }
  const tiers = policy.providerTiers ?? {};
  const providerKey = normalizeProviderId(provider);
  let providerTier: "free" | "paid" | "frontier" | null = null;
  for (const [key, tier] of Object.entries(tiers)) {
    if (normalizeProviderId(key) === providerKey) {
      providerTier = tier;
      break;
    }
  }
  if (!providerTier) {
    return true;
  }

  if (activeTier === "free") {
    return providerTier === "free";
  }
  if (activeTier === "paid") {
    return providerTier === "free" || providerTier === "paid";
  }
  if (activeTier === "frontier") {
    return true;
  }
  return true;
}

export function resetQuotaPolicyCacheForTest(): void {
  policyCache = null;
}
