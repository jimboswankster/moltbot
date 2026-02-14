import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { migrateLegacyCronPayload } from "../payload-migration.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { inferLegacyName, normalizeOptionalText } from "./normalize.js";

const storeCache = new Map<string, { version: 1; jobs: CronJob[] }>();

function ensureDeskPostbackForIsolatedAgentTurn(raw: Record<string, unknown>) {
  const sessionTarget = raw.sessionTarget;
  const payload = raw.payload;
  if (sessionTarget !== "isolated") {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  if ((payload as { kind?: unknown }).kind !== "agentTurn") {
    return false;
  }
  const isolationRaw = raw.isolation;
  if (!isolationRaw || typeof isolationRaw !== "object" || Array.isArray(isolationRaw)) {
    raw.isolation = { postbackStrategy: "desk" };
    return true;
  }
  const isolation = isolationRaw as Record<string, unknown>;
  if (typeof isolation.postbackStrategy !== "string") {
    isolation.postbackStrategy = "desk";
    return true;
  }
  return false;
}

/**
 * Reload jobs from disk, clearing any in-memory cache. Use after external edits to
 * jobs.json so new/updated/removed jobs are picked up without a gateway restart.
 */
export async function reloadFromDisk(state: CronServiceState) {
  storeCache.delete(state.deps.storePath);
  state.store = null;
  await ensureLoaded(state);
}

export async function ensureLoaded(state: CronServiceState) {
  if (state.store) {
    return;
  }
  const cached = storeCache.get(state.deps.storePath);
  if (cached) {
    state.store = cached;
    return;
  }
  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as Array<Record<string, unknown>>;
  let mutated = false;
  for (const raw of jobs) {
    const nameRaw = raw.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      raw.name = inferLegacyName({
        schedule: raw.schedule as never,
        payload: raw.payload as never,
      });
      mutated = true;
    } else {
      raw.name = nameRaw.trim();
    }

    const desc = normalizeOptionalText(raw.description);
    if (raw.description !== desc) {
      raw.description = desc;
      mutated = true;
    }

    const payload = raw.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      if (migrateLegacyCronPayload(payload as Record<string, unknown>)) {
        mutated = true;
      }
    }
    if (ensureDeskPostbackForIsolatedAgentTurn(raw)) {
      mutated = true;
    }
  }
  state.store = { version: 1, jobs: jobs as unknown as CronJob[] };
  storeCache.set(state.deps.storePath, state.store);
  if (mutated) {
    await persist(state);
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storePath, state.store);
}
