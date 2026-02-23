import type { CronJobCreate, CronJobPatch } from "./types.js";
import { sanitizeAgentId } from "../routing/session-key.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { migrateLegacyCronPayload } from "./payload-migration.js";

type UnknownRecord = Record<string, unknown>;

type NormalizeOptions = {
  applyDefaults?: boolean;
};

const DEFAULT_OPTIONS: NormalizeOptions = {
  applyDefaults: false,
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceSchedule(schedule: UnknownRecord) {
  const next: UnknownRecord = { ...schedule };
  const kind = typeof schedule.kind === "string" ? schedule.kind : undefined;
  const atMsRaw = schedule.atMs;
  const atRaw = schedule.at;
  const parsedAtMs =
    typeof atMsRaw === "string"
      ? parseAbsoluteTimeMs(atMsRaw)
      : typeof atRaw === "string"
        ? parseAbsoluteTimeMs(atRaw)
        : null;

  if (!kind) {
    if (
      typeof schedule.atMs === "number" ||
      typeof schedule.at === "string" ||
      typeof schedule.atMs === "string"
    ) {
      next.kind = "at";
    } else if (typeof schedule.everyMs === "number") {
      next.kind = "every";
    } else if (typeof schedule.expr === "string") {
      next.kind = "cron";
    }
  }

  if (typeof schedule.atMs !== "number" && parsedAtMs !== null) {
    next.atMs = parsedAtMs;
  }

  if ("at" in next) {
    delete next.at;
  }

  return next;
}

function coercePayload(payload: UnknownRecord) {
  const next: UnknownRecord = { ...payload };
  // Back-compat: older configs used `provider` for delivery channel.
  migrateLegacyCronPayload(next);
  return next;
}

function coerceMainDeliveryStrategyWithDefaults(
  existing: unknown,
  options: { sessionTarget: unknown; payload: unknown; applyDefaults: boolean },
) {
  if (typeof existing === "string") {
    const normalized = existing.trim().toLowerCase();
    if (
      normalized === "desk" ||
      normalized === "main-session" ||
      normalized === "external-channel"
    ) {
      return normalized;
    }
  }
  if (!options.applyDefaults) {
    return undefined;
  }
  const isMainSystemEvent =
    options.sessionTarget === "main" &&
    isRecord(options.payload) &&
    options.payload.kind === "systemEvent";
  if (!isMainSystemEvent) {
    return undefined;
  }
  return "desk";
}

function coerceIsolationWithDefaults(
  existing: unknown,
  options: { sessionTarget: unknown; payload: unknown; applyDefaults: boolean },
): UnknownRecord | undefined {
  const normalized = isRecord(existing) ? { ...existing } : undefined;
  if (!options.applyDefaults) {
    return normalized;
  }
  const isIsolatedAgentTurn =
    options.sessionTarget === "isolated" &&
    isRecord(options.payload) &&
    options.payload.kind === "agentTurn";
  if (!isIsolatedAgentTurn) {
    return normalized;
  }
  const next = normalized ?? {};
  if (typeof next.postbackStrategy !== "string") {
    next.postbackStrategy = "desk";
  }
  return next;
}

function unwrapJob(raw: UnknownRecord) {
  if (isRecord(raw.data)) {
    return raw.data;
  }
  if (isRecord(raw.job)) {
    return raw.job;
  }
  return raw;
}

export function normalizeCronJobInput(
  raw: unknown,
  options: NormalizeOptions = DEFAULT_OPTIONS,
): UnknownRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const base = unwrapJob(raw);
  const next: UnknownRecord = { ...base };

  if ("agentId" in base) {
    const agentId = base.agentId;
    if (agentId === null) {
      next.agentId = null;
    } else if (typeof agentId === "string") {
      const trimmed = agentId.trim();
      if (trimmed) {
        next.agentId = sanitizeAgentId(trimmed);
      } else {
        delete next.agentId;
      }
    }
  }

  if ("enabled" in base) {
    const enabled = base.enabled;
    if (typeof enabled === "boolean") {
      next.enabled = enabled;
    } else if (typeof enabled === "string") {
      const trimmed = enabled.trim().toLowerCase();
      if (trimmed === "true") {
        next.enabled = true;
      }
      if (trimmed === "false") {
        next.enabled = false;
      }
    }
  }

  if (isRecord(base.schedule)) {
    next.schedule = coerceSchedule(base.schedule);
  }

  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  if (options.applyDefaults) {
    if (!next.wakeMode) {
      next.wakeMode = "next-heartbeat";
    }
    if (!next.sessionTarget && isRecord(next.payload)) {
      const kind = typeof next.payload.kind === "string" ? next.payload.kind : "";
      if (kind === "systemEvent") {
        next.sessionTarget = "main";
      }
      if (kind === "agentTurn" || kind === "command") {
        next.sessionTarget = "isolated";
      }
    }
  }

  const isolation = coerceIsolationWithDefaults(base.isolation, {
    sessionTarget: next.sessionTarget,
    payload: next.payload,
    applyDefaults: options.applyDefaults ?? false,
  });
  if (isolation) {
    next.isolation = isolation;
  }

  const mainDeliveryStrategy = coerceMainDeliveryStrategyWithDefaults(base.mainDeliveryStrategy, {
    sessionTarget: next.sessionTarget,
    payload: next.payload,
    applyDefaults: options.applyDefaults ?? false,
  });
  if (mainDeliveryStrategy) {
    next.mainDeliveryStrategy = mainDeliveryStrategy;
  }

  return next;
}

export function normalizeCronJobCreate(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobCreate | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: true,
    ...options,
  }) as CronJobCreate | null;
}

export function normalizeCronJobPatch(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobPatch | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: false,
    ...options,
  }) as CronJobPatch | null;
}
