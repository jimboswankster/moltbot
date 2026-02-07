type FallbackAttemptEntry = {
  provider: string;
  model: string;
  reason?: string;
  status?: number;
  code?: string;
  ts: number;
};

const FALLBACK_WINDOW_MS = 60 * 60 * 1000;
const FALLBACK_WARN_THRESHOLD = 10;
const FALLBACK_WARN_COOLDOWN_MS = 5 * 60 * 1000;

let warningCount = 0;
let lastWarningAt: number | null = null;
const fallbackAttempts: FallbackAttemptEntry[] = [];

function pruneAttempts(now: number) {
  const cutoff = now - FALLBACK_WINDOW_MS;
  while (fallbackAttempts.length > 0 && fallbackAttempts[0] && fallbackAttempts[0].ts < cutoff) {
    fallbackAttempts.shift();
  }
}

export function recordFallbackAttempt(params: {
  provider: string;
  model: string;
  reason?: string;
  status?: number;
  code?: string;
}): { countLastHour: number; warned: boolean } {
  const now = Date.now();
  fallbackAttempts.push({ ...params, ts: now });
  pruneAttempts(now);

  const countLastHour = fallbackAttempts.length;
  let warned = false;
  if (countLastHour >= FALLBACK_WARN_THRESHOLD) {
    if (!lastWarningAt || now - lastWarningAt >= FALLBACK_WARN_COOLDOWN_MS) {
      warningCount += 1;
      lastWarningAt = now;
      warned = true;
    }
  }

  return { countLastHour, warned };
}

export function getFallbackTelemetry() {
  const now = Date.now();
  pruneAttempts(now);
  const byProvider = new Map<string, number>();
  const byReason = new Map<string, number>();

  for (const entry of fallbackAttempts) {
    byProvider.set(entry.provider, (byProvider.get(entry.provider) ?? 0) + 1);
    if (entry.reason) {
      byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
    }
  }

  return {
    lastHourCount: fallbackAttempts.length,
    lastWarningAt,
    warningCount,
    warnThreshold: FALLBACK_WARN_THRESHOLD,
    byProvider: Array.from(byProvider.entries()).map(([provider, count]) => ({
      provider,
      count,
    })),
    byReason: Array.from(byReason.entries()).map(([reason, count]) => ({ reason, count })),
  };
}

export function resetFallbackTelemetry() {
  fallbackAttempts.length = 0;
  warningCount = 0;
  lastWarningAt = null;
}
