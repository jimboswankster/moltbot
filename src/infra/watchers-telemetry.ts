type WatcherDisabledEntry = {
  id: string;
  reason: string;
  firstAt: number;
  lastAt: number;
  occurrences: number;
};

const watcherDisabled = new Map<string, WatcherDisabledEntry>();

export function recordWatcherDisabled(id: string, reason: string) {
  const now = Date.now();
  const existing = watcherDisabled.get(id);
  if (existing) {
    watcherDisabled.set(id, {
      ...existing,
      reason,
      lastAt: now,
      occurrences: existing.occurrences + 1,
    });
    return;
  }
  watcherDisabled.set(id, {
    id,
    reason,
    firstAt: now,
    lastAt: now,
    occurrences: 1,
  });
}

export function getWatcherTelemetry() {
  const disabled = Array.from(watcherDisabled.values()).toSorted((a, b) => b.lastAt - a.lastAt);
  return {
    disabledCount: disabled.length,
    disabled,
  };
}
