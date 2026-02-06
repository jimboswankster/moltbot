type A2AInboxFallbackEntry = {
  id: string;
  reason: string;
  firstAt: number;
  lastAt: number;
  occurrences: number;
};

const inboxDisplayFallback = new Map<string, A2AInboxFallbackEntry>();

export function recordA2AInboxDisplayFallback(id: string, reason: string) {
  const now = Date.now();
  const existing = inboxDisplayFallback.get(id);
  if (existing) {
    inboxDisplayFallback.set(id, {
      ...existing,
      reason,
      lastAt: now,
      occurrences: existing.occurrences + 1,
    });
    return;
  }
  inboxDisplayFallback.set(id, {
    id,
    reason,
    firstAt: now,
    lastAt: now,
    occurrences: 1,
  });
}

export function getA2ATelemetry() {
  const fallback = Array.from(inboxDisplayFallback.values()).toSorted(
    (a, b) => b.lastAt - a.lastAt,
  );
  return {
    inboxDisplayFallbackCount: fallback.length,
    inboxDisplayFallback: fallback,
  };
}

export function resetA2ATelemetry() {
  inboxDisplayFallback.clear();
}
