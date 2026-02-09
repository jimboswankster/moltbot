// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

export type SystemEvent = { text: string; ts: number };

const MAX_EVENTS = 20;

/** Time window for content-based deduplication (default 10 minutes). */
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

type SessionQueue = {
  queue: SystemEvent[];
  lastText: string | null;
  lastContextKey: string | null;
  /** Content hash → enqueue timestamp. Survives drains so that the next
   *  heartbeat cycle still knows what was recently sent. */
  recentHashes: Map<string, number>;
};

const queues = new Map<string, SessionQueue>();

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
};

function requireSessionKey(key?: string | null): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  if (!key) {
    return null;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  const key = requireSessionKey(options?.sessionKey);
  const entry =
    queues.get(key) ??
    (() => {
      const created: SessionQueue = {
        queue: [],
        lastText: null,
        lastContextKey: null,
        recentHashes: new Map(),
      };
      queues.set(key, created);
      return created;
    })();
  const cleaned = text.trim();
  if (!cleaned) {
    return;
  }
  entry.lastContextKey = normalizeContextKey(options?.contextKey);

  // --- Time-windowed content dedup ---
  const now = Date.now();

  // Prune expired entries from recentHashes
  for (const [h, ts] of entry.recentHashes) {
    if (now - ts > DEDUP_WINDOW_MS) {
      entry.recentHashes.delete(h);
    }
  }

  // Use the cleaned text itself as the hash key (system events are short)
  if (entry.recentHashes.has(cleaned)) {
    return; // identical text was enqueued within the dedup window
  }

  entry.recentHashes.set(cleaned, now);
  // --- End dedup ---

  entry.lastText = cleaned;
  entry.queue.push({ text: cleaned, ts: now });
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.slice();
  entry.queue.length = 0;
  entry.lastText = null;
  entry.lastContextKey = null;
  // Preserve recentHashes so that the dedup window survives across drains.
  // Only delete the session queue if hashes are also empty (fully expired).
  if (entry.recentHashes.size === 0) {
    queues.delete(key);
  }
  return out;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEvents(sessionKey: string): string[] {
  const key = requireSessionKey(sessionKey);
  return queues.get(key)?.queue.map((e) => e.text) ?? [];
}

export function hasSystemEvents(sessionKey: string) {
  const key = requireSessionKey(sessionKey);
  return (queues.get(key)?.queue.length ?? 0) > 0;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
