import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "../model-selection.js";

type RouteState = {
  routeId?: string;
  provider?: string;
  breakerState?: "closed" | "open" | "half_open" | string;
  success?: number;
  failure?: number;
  consecutiveFailures?: number;
  avgLatencyMs?: number;
  inferredCooldownUntil?: number | null;
};

type KloopState = {
  routes?: Record<string, RouteState>;
};

type CachedState = {
  path: string;
  loadedAt: number;
  mtimeMs: number;
  state: KloopState | null;
};

let cache: CachedState | null = null;

function resolveKloopStatePath(): string {
  const envPath = process.env.OPENCLAW_KLOOP_STATE_PATH?.trim();
  if (envPath) {
    return envPath;
  }
  return path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    "os",
    "config",
    "free-engine-kloop-state.json",
  );
}

function loadKloopState(): KloopState | null {
  const filePath = resolveKloopStatePath();
  const now = Date.now();
  const ttlMs = 2000;

  try {
    if (!fs.existsSync(filePath)) {
      cache = { path: filePath, loadedAt: now, mtimeMs: 0, state: null };
      return null;
    }
    const st = fs.statSync(filePath);
    const mtimeMs = st.mtimeMs || 0;

    if (
      cache &&
      cache.path === filePath &&
      now - cache.loadedAt < ttlMs &&
      cache.mtimeMs === mtimeMs
    ) {
      return cache.state;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as KloopState;
    const state = parsed && typeof parsed === "object" ? parsed : null;
    cache = { path: filePath, loadedAt: now, mtimeMs, state };
    return state;
  } catch {
    cache = { path: filePath, loadedAt: now, mtimeMs: 0, state: null };
    return null;
  }
}

function resolveRouteState(provider: string, profileId: string): RouteState | null {
  const state = loadKloopState();
  const routes = state?.routes;
  if (!routes || typeof routes !== "object") {
    return null;
  }

  const providerKey = normalizeProviderId(provider);
  const routeId = profileId.startsWith(`${providerKey}:`)
    ? profileId.slice(providerKey.length + 1)
    : profileId;
  const directKeys = [`${providerKey}:${profileId}`, `${providerKey}:${routeId}`];

  for (const key of directKeys) {
    const hit = routes[key];
    if (hit) {
      return hit;
    }
  }

  for (const route of Object.values(routes)) {
    if (!route || typeof route !== "object") {
      continue;
    }
    if (normalizeProviderId(String(route.provider || "")) !== providerKey) {
      continue;
    }
    const candidateRouteId = String(route.routeId || "");
    if (!candidateRouteId) {
      continue;
    }
    if (candidateRouteId === profileId || candidateRouteId === routeId) {
      return route;
    }
  }

  return null;
}

function scoreRoute(route: RouteState, now: number): number {
  const success = Math.max(0, Number(route.success || 0));
  const failure = Math.max(0, Number(route.failure || 0));
  const total = success + failure;
  const successRate = total > 0 ? success / total : 0.5;
  const latencyMs = Math.max(0, Number(route.avgLatencyMs || 0));
  const latencyPenalty = latencyMs > 0 ? Math.min(0.3, latencyMs / 120000) : 0;
  const failPenalty = Math.min(0.5, Math.max(0, Number(route.consecutiveFailures || 0)) * 0.1);
  const breaker = String(route.breakerState || "closed");
  const breakerPenalty = breaker === "open" ? 1 : breaker === "half_open" ? 0.25 : 0;
  const cooldownUntil = Number(route.inferredCooldownUntil || 0);
  const cooldownPenalty = cooldownUntil > now ? 1 : 0;
  return successRate - latencyPenalty - failPenalty - breakerPenalty - cooldownPenalty;
}

export function isProfileBlockedByKloop(provider: string, profileId: string): boolean {
  const route = resolveRouteState(provider, profileId);
  if (!route) {
    return false;
  }
  const now = Date.now();
  const breaker = String(route.breakerState || "closed");
  const cooldownUntil = Number(route.inferredCooldownUntil || 0);
  return breaker === "open" && cooldownUntil > now;
}

export function getKloopProfileScore(provider: string, profileId: string): number | null {
  const route = resolveRouteState(provider, profileId);
  if (!route) {
    return null;
  }
  return scoreRoute(route, Date.now());
}

export function getKloopProfileCooldownUntil(provider: string, profileId: string): number | null {
  const route = resolveRouteState(provider, profileId);
  if (!route) {
    return null;
  }
  const cooldownUntil = Number(route.inferredCooldownUntil || 0);
  return cooldownUntil > 0 ? cooldownUntil : null;
}

export function resetKloopPolicyCacheForTest(): void {
  cache = null;
}
