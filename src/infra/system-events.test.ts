import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { prependSystemEvents } from "../auto-reply/reply/session-updates.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import {
  DEDUP_WINDOW_MS,
  enqueueSystemEvent,
  drainSystemEvents,
  drainSystemEventEntries,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

describe("system events (session routing)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("does not leak session-scoped events into main", async () => {
    enqueueSystemEvent("Discord reaction added: ✅", {
      sessionKey: "discord:group:123",
      contextKey: "discord:reaction:added:msg:user:✅",
    });

    expect(peekSystemEvents(mainKey)).toEqual([]);
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const main = await prependSystemEvents({
      cfg,
      sessionKey: mainKey,
      isMainSession: true,
      isNewSession: false,
      prefixedBodyBase: "hello",
    });
    expect(main).toBe("hello");
    expect(peekSystemEvents("discord:group:123")).toEqual(["Discord reaction added: ✅"]);

    const discord = await prependSystemEvents({
      cfg,
      sessionKey: "discord:group:123",
      isMainSession: false,
      isNewSession: false,
      prefixedBodyBase: "hi",
    });
    expect(discord).toMatch(/^System: \[[^\]]+\] Discord reaction added: ✅\n\nhi$/);
    expect(peekSystemEvents("discord:group:123")).toEqual([]);
  });

  it("requires an explicit session key", () => {
    expect(() => enqueueSystemEvent("Node: Mac Studio", { sessionKey: " " })).toThrow("sessionKey");
  });
});

describe("system events (time-windowed content dedup)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses identical events within the dedup window", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts);
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts);
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts);

    expect(peekSystemEvents("test:dedup")).toEqual(["[LEDGER POLL] Read docs/..."]);
  });

  it("allows different events through even when one is deduped", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts);
    enqueueSystemEvent("[BUDGET WARNING] 80% used", opts);
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts); // duplicate — suppressed

    expect(peekSystemEvents("test:dedup")).toEqual([
      "[LEDGER POLL] Read docs/...",
      "[BUDGET WARNING] 80% used",
    ]);
  });

  it("allows re-send after the dedup window expires", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts);
    expect(peekSystemEvents("test:dedup")).toEqual(["[LEDGER POLL] Read docs/..."]);

    // Drain to clear the queue (but recentHashes survive)
    drainSystemEvents("test:dedup");
    expect(peekSystemEvents("test:dedup")).toEqual([]);

    // Still within window — suppressed
    vi.advanceTimersByTime(DEDUP_WINDOW_MS - 1000);
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts);
    expect(peekSystemEvents("test:dedup")).toEqual([]);

    // Advance past the window — should now be accepted
    vi.advanceTimersByTime(2000); // total: DEDUP_WINDOW_MS + 1000
    enqueueSystemEvent("[LEDGER POLL] Read docs/...", opts);
    expect(peekSystemEvents("test:dedup")).toEqual(["[LEDGER POLL] Read docs/..."]);
  });

  it("dedup survives across drains", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("[LEDGER POLL] status check", opts);
    const drained = drainSystemEvents("test:dedup");
    expect(drained).toEqual(["[LEDGER POLL] status check"]);

    // Re-enqueue the same text — should be suppressed (within window)
    enqueueSystemEvent("[LEDGER POLL] status check", opts);
    expect(peekSystemEvents("test:dedup")).toEqual([]);
  });

  it("dedup is interleaving-resistant (not just consecutive)", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("A", opts);
    enqueueSystemEvent("B", opts);
    enqueueSystemEvent("A", opts); // would pass old consecutive dedup, blocked by window dedup

    expect(peekSystemEvents("test:dedup")).toEqual(["A", "B"]);
  });

  it("events with changed content pass dedup even if source is the same", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("[LEDGER POLL] status: WAITING_FOR_SIMON", opts);
    enqueueSystemEvent("[LEDGER POLL] status: COMPLETED", opts);

    expect(peekSystemEvents("test:dedup")).toEqual([
      "[LEDGER POLL] status: WAITING_FOR_SIMON",
      "[LEDGER POLL] status: COMPLETED",
    ]);
  });

  it("dedup does not cross sessions", () => {
    enqueueSystemEvent("[LEDGER POLL] same text", { sessionKey: "session:A" });
    enqueueSystemEvent("[LEDGER POLL] same text", { sessionKey: "session:B" });

    expect(peekSystemEvents("session:A")).toEqual(["[LEDGER POLL] same text"]);
    expect(peekSystemEvents("session:B")).toEqual(["[LEDGER POLL] same text"]);
  });

  it("trims whitespace before dedup comparison", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("  [LEDGER POLL] padded  ", opts);
    enqueueSystemEvent("[LEDGER POLL] padded", opts); // same after trim

    expect(peekSystemEvents("test:dedup")).toEqual(["[LEDGER POLL] padded"]);
  });

  it("hasSystemEvents returns false when all duplicates are suppressed", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("event A", opts);
    drainSystemEvents("test:dedup");

    // Re-enqueue within window — suppressed
    enqueueSystemEvent("event A", opts);
    expect(hasSystemEvents("test:dedup")).toBe(false);
  });

  it("drainSystemEventEntries returns proper SystemEvent objects", () => {
    const opts = { sessionKey: "test:dedup" };
    vi.setSystemTime(new Date("2026-02-09T12:00:00Z"));
    enqueueSystemEvent("first", opts);
    vi.advanceTimersByTime(5000);
    enqueueSystemEvent("second", opts);

    const entries = drainSystemEventEntries("test:dedup");
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe("first");
    expect(entries[1].text).toBe("second");
    expect(entries[1].ts - entries[0].ts).toBe(5000);
  });

  it("handles rapid-fire identical events (simulates 60s cron over 30 minutes)", () => {
    const opts = { sessionKey: "test:cron-sim" };
    // 30 firings, one per minute (60s cron over 30 minutes)
    for (let i = 0; i < 30; i++) {
      enqueueSystemEvent("[LEDGER POLL] Read docs/ledger/pending.md", opts);
      vi.advanceTimersByTime(60_000);
    }

    // Only one should get through (the first one). The rest are within
    // the 10-minute window of the previous accepted one. After 10 minutes
    // the hash expires so the 11th-minute firing gets through, etc.
    // At minute 0: accepted (queue=1)
    // Minutes 1-9: suppressed (within 10-min window of minute-0)
    // Minute 10: hash from minute-0 expired, accepted (queue=2)
    // Minutes 11-19: suppressed
    // Minute 20: accepted (queue=3)
    // Minutes 21-29: suppressed
    const events = peekSystemEvents("test:cron-sim");
    expect(events).toHaveLength(3);
    expect(events.every((e) => e === "[LEDGER POLL] Read docs/ledger/pending.md")).toBe(true);
  });

  it("empty text is still rejected (not just deduped)", () => {
    const opts = { sessionKey: "test:dedup" };
    enqueueSystemEvent("", opts);
    enqueueSystemEvent("   ", opts);
    expect(hasSystemEvents("test:dedup")).toBe(false);
  });

  it("contextKey is still updated even when event text is deduped", () => {
    const opts1 = { sessionKey: "test:dedup", contextKey: "ctx:old" };
    const opts2 = { sessionKey: "test:dedup", contextKey: "ctx:new" };

    enqueueSystemEvent("same text", opts1);
    // Same text, different context — text is deduped but contextKey should update
    enqueueSystemEvent("same text", opts2);

    // Only one event in queue
    expect(peekSystemEvents("test:dedup")).toEqual(["same text"]);
    // But context change should be detectable (isSystemEventContextChanged
    // compares against lastContextKey which was set before the dedup check)
    // After both calls, lastContextKey should be "ctx:new"
    expect(isSystemEventContextChanged("test:dedup", "ctx:new")).toBe(false);
    expect(isSystemEventContextChanged("test:dedup", "ctx:old")).toBe(true);
  });
});
