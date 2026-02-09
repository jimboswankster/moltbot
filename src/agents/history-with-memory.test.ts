/**
 * Unit Test: limitHistoryTurnsWithMemory (graduated safety guard)
 *
 * Protocol: TEST-UNIT v1.0.0
 * SUT: limitHistoryTurnsWithMemory from history-with-memory.ts
 *
 * Tests the graduated safety guard (H-3) that replaces binary
 * "never drop" with a 4-tier degradation response.
 */
import { describe, expect, it } from "vitest";
import type { SessionMemory } from "./session-memory.js";
import { limitHistoryTurnsWithMemory } from "./history-with-memory.js";
import {
  buildConversation,
  makeUser,
  makeAssistant,
  makeMemoryWithEntries,
  makeEmptyMemory,
} from "./test-helpers/memory-companion-fixtures.js";

// ─── No memory → delegates to original behavior ────────────────────────────

describe("limitHistoryTurnsWithMemory — no memory", () => {
  it("delegates to original limitHistoryTurns when memory is undefined", () => {
    const msgs = buildConversation(10); // 40 messages (4 per turn)
    const result = limitHistoryTurnsWithMemory(msgs, 5, undefined);
    // Should keep last 5 user turns (20 messages)
    expect(result.degradationTier).toBe("normal");
    // Messages should be reduced
    const userMsgs = result.messages.filter((m) => (m as Record<string, unknown>).role === "user");
    expect(userMsgs.length).toBeLessThanOrEqual(5);
  });

  it("returns all messages when limit is undefined", () => {
    const msgs = buildConversation(10);
    const result = limitHistoryTurnsWithMemory(msgs, undefined, undefined);
    expect(result.messages).toHaveLength(msgs.length);
    expect(result.degradationTier).toBe("normal");
  });

  it("handles empty memory entries same as no memory", () => {
    const msgs = buildConversation(10);
    const result = limitHistoryTurnsWithMemory(msgs, 5, makeEmptyMemory());
    expect(result.degradationTier).toBe("normal");
    const userMsgs = result.messages.filter((m) => (m as Record<string, unknown>).role === "user");
    expect(userMsgs.length).toBeLessThanOrEqual(5);
  });
});

// ─── Normal tier: all turns summarized ──────────────────────────────────────

describe("limitHistoryTurnsWithMemory — normal tier", () => {
  it("drops summarized turns and returns normal tier when all caught up", () => {
    // 10 turns, all summarized (memory covers turns 0-9)
    const msgs = buildConversation(10);
    const memory = makeMemoryWithEntries(2, 5); // 2 entries: [0-4], [5-9]

    const result = limitHistoryTurnsWithMemory(msgs, 5, memory);
    expect(result.degradationTier).toBe("normal");
    // Should have session_memory string
    expect(result.sessionMemory).toBeDefined();
    expect(result.sessionMemory!.length).toBeGreaterThan(0);
  });
});

// ─── Caution tier: 1-20 turns behind ────────────────────────────────────────

describe("limitHistoryTurnsWithMemory — caution tier", () => {
  it("returns caution when companion is 1-20 turns behind", () => {
    // 25 turns, only first 10 summarized → 15 turns behind
    const msgs = buildConversation(25);
    const memory = makeMemoryWithEntries(2, 5); // covers 0-9

    const result = limitHistoryTurnsWithMemory(msgs, 5, memory);
    expect(result.degradationTier).toBe("caution");
  });
});

// ─── Warning tier: 20-50 turns behind ───────────────────────────────────────

describe("limitHistoryTurnsWithMemory — warning tier", () => {
  it("returns warning when companion is 20-50 turns behind", () => {
    // 40 turns, only first 10 summarized → 30 turns behind
    const msgs = buildConversation(40);
    const memory = makeMemoryWithEntries(2, 5); // covers 0-9

    const result = limitHistoryTurnsWithMemory(msgs, 5, memory);
    expect(result.degradationTier).toBe("warning");
  });
});

// ─── Emergency tier: 50+ turns behind ───────────────────────────────────────

describe("limitHistoryTurnsWithMemory — emergency tier", () => {
  it("returns emergency when companion is 50+ turns behind", () => {
    // 70 turns, only first 10 summarized → 60 turns behind
    const msgs = buildConversation(70);
    const memory = makeMemoryWithEntries(2, 5); // covers 0-9

    const result = limitHistoryTurnsWithMemory(msgs, 5, memory);
    expect(result.degradationTier).toBe("emergency");
  });
});

// ─── Return structure ───────────────────────────────────────────────────────

describe("limitHistoryTurnsWithMemory — return structure", () => {
  it("always returns degradation tier alongside messages", () => {
    const msgs = buildConversation(5);
    const result = limitHistoryTurnsWithMemory(msgs, 3, makeEmptyMemory());
    expect(result).toHaveProperty("messages");
    expect(result).toHaveProperty("degradationTier");
    expect(["normal", "caution", "warning", "emergency"]).toContain(result.degradationTier);
  });

  it("limit undefined + memory present → no dropping", () => {
    const msgs = buildConversation(20);
    const memory = makeMemoryWithEntries(4, 5); // covers 0-19
    const result = limitHistoryTurnsWithMemory(msgs, undefined, memory);
    // No limit → keep all messages
    expect(result.messages).toHaveLength(msgs.length);
    expect(result.degradationTier).toBe("normal");
  });
});
