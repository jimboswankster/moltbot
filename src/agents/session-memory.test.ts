import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Unit Test: session-memory
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: readSessionMemory, appendSessionMemory, renderSessionMemoryForPrompt,
 *      countSummarizedUserTurns, compactSessionMemory from session-memory.ts
 *
 * Purpose: Verify session memory storage, retrieval, rendering, and epoch compaction.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSessionMemory,
  compactSessionMemory,
  countSummarizedUserTurns,
  readSessionMemory,
  renderSessionMemoryForPrompt,
  type SessionMemory,
  type SessionMemoryEntry,
} from "./session-memory.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpSessionFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-memory-test-"));
  return path.join(dir, "test-session.jsonl");
}

function makeEntry(
  start: number,
  end: number,
  quality: "llm" | "deterministic" | "epoch" = "llm",
  summary?: string,
): SessionMemoryEntry {
  return {
    turnRange: [start, end],
    summary: summary ?? `Summary of turns ${start}-${end}: topic discussed, decision made.`,
    generatedBy:
      quality === "llm"
        ? "gemini-2.0-flash"
        : quality === "deterministic"
          ? "deterministic-fallback"
          : "epoch-compaction",
    generatedAt: Date.now(),
    quality,
  };
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const p of cleanupPaths) {
    try {
      const dir = path.dirname(p);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  cleanupPaths.length = 0;
});

// ─── readSessionMemory ──────────────────────────────────────────────────────

describe("readSessionMemory", () => {
  it("returns empty memory for missing file", () => {
    const sessionFile = "/tmp/nonexistent-session-12345.jsonl";
    const mem = readSessionMemory(sessionFile);
    expect(mem.entries).toEqual([]);
    expect(mem.lastSummarizedTurn).toBe(-1);
  });

  it("returns empty memory for empty file", () => {
    const sessionFile = tmpSessionFile();
    cleanupPaths.push(sessionFile);
    // Create the .memory.json file (empty)
    const memFile = sessionFile.replace(/\.jsonl$/, ".memory.json");
    fs.writeFileSync(memFile, "", "utf-8");
    const mem = readSessionMemory(sessionFile);
    expect(mem.entries).toEqual([]);
    expect(mem.lastSummarizedTurn).toBe(-1);
  });

  it("returns empty memory for malformed JSON (graceful recovery)", () => {
    const sessionFile = tmpSessionFile();
    cleanupPaths.push(sessionFile);
    const memFile = sessionFile.replace(/\.jsonl$/, ".memory.json");
    fs.writeFileSync(memFile, "{ this is not valid json !!!", "utf-8");
    const mem = readSessionMemory(sessionFile);
    expect(mem.entries).toEqual([]);
    expect(mem.lastSummarizedTurn).toBe(-1);
  });
});

// ─── appendSessionMemory ────────────────────────────────────────────────────

describe("appendSessionMemory", () => {
  it("write + read roundtrip preserves data", () => {
    const sessionFile = tmpSessionFile();
    cleanupPaths.push(sessionFile);

    const entry = makeEntry(0, 4);
    appendSessionMemory(sessionFile, entry);

    const mem = readSessionMemory(sessionFile);
    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0].turnRange).toEqual([0, 4]);
    expect(mem.entries[0].summary).toContain("Summary of turns 0-4");
    expect(mem.entries[0].quality).toBe("llm");
    expect(mem.lastSummarizedTurn).toBe(4);
  });

  it("appends multiple entries in order", () => {
    const sessionFile = tmpSessionFile();
    cleanupPaths.push(sessionFile);

    appendSessionMemory(sessionFile, makeEntry(0, 4));
    appendSessionMemory(sessionFile, makeEntry(5, 9));
    appendSessionMemory(sessionFile, makeEntry(10, 14));

    const mem = readSessionMemory(sessionFile);
    expect(mem.entries).toHaveLength(3);
    expect(mem.entries[0].turnRange).toEqual([0, 4]);
    expect(mem.entries[1].turnRange).toEqual([5, 9]);
    expect(mem.entries[2].turnRange).toEqual([10, 14]);
    expect(mem.lastSummarizedTurn).toBe(14);
  });

  it("survives simulated restart (read after close/reopen)", () => {
    const sessionFile = tmpSessionFile();
    cleanupPaths.push(sessionFile);

    appendSessionMemory(sessionFile, makeEntry(0, 4));
    appendSessionMemory(sessionFile, makeEntry(5, 9));

    // Simulate "restart" — just read again (file should be persisted)
    const mem = readSessionMemory(sessionFile);
    expect(mem.entries).toHaveLength(2);
    expect(mem.lastSummarizedTurn).toBe(9);
  });
});

// ─── renderSessionMemoryForPrompt ───────────────────────────────────────────

describe("renderSessionMemoryForPrompt", () => {
  it("renders entries as human-readable text with turn ranges", () => {
    const mem: SessionMemory = {
      entries: [
        makeEntry(
          0,
          4,
          "llm",
          "User discussed boot optimization. Decided to migrate SOUL.md to RAG.",
        ),
        makeEntry(5, 9, "llm", "Fixed agent_toolkit env loading. RAG index rebuilt."),
      ],
      lastSummarizedTurn: 9,
    };

    const text = renderSessionMemoryForPrompt(mem);
    expect(text).toContain("[Turns 0-4]");
    expect(text).toContain("boot optimization");
    expect(text).toContain("[Turns 5-9]");
    expect(text).toContain("agent_toolkit");
  });

  it("returns empty string for empty memory", () => {
    const mem: SessionMemory = { entries: [], lastSummarizedTurn: -1 };
    expect(renderSessionMemoryForPrompt(mem)).toBe("");
  });

  it("includes epoch markers for compacted sections", () => {
    const mem: SessionMemory = {
      entries: [
        makeEntry(0, 19, "epoch", "Epoch: boot optimization, toolkit fix, TBAS testing."),
        makeEntry(20, 24, "llm", "Recent: companion validation results."),
      ],
      lastSummarizedTurn: 24,
    };

    const text = renderSessionMemoryForPrompt(mem);
    expect(text).toContain("[Epoch");
    expect(text).toContain("0-19");
    expect(text).toContain("[Turns 20-24]");
  });
});

// ─── countSummarizedUserTurns ───────────────────────────────────────────────

describe("countSummarizedUserTurns", () => {
  it("returns 0 for empty memory", () => {
    const mem: SessionMemory = { entries: [], lastSummarizedTurn: -1 };
    expect(countSummarizedUserTurns(mem)).toBe(0);
  });

  it("counts turns from entry ranges", () => {
    const mem: SessionMemory = {
      entries: [makeEntry(0, 4), makeEntry(5, 9)],
      lastSummarizedTurn: 9,
    };
    // Turns 0-4 = 5 turns, 5-9 = 5 turns, total = 10
    expect(countSummarizedUserTurns(mem)).toBe(10);
  });

  it("handles epoch entries spanning large ranges", () => {
    const mem: SessionMemory = {
      entries: [makeEntry(0, 19, "epoch"), makeEntry(20, 24)],
      lastSummarizedTurn: 24,
    };
    expect(countSummarizedUserTurns(mem)).toBe(25);
  });
});

// ─── compactSessionMemory ───────────────────────────────────────────────────

describe("compactSessionMemory", () => {
  it("does not compact when under maxTokens", () => {
    const mem: SessionMemory = {
      entries: [makeEntry(0, 4)],
      lastSummarizedTurn: 4,
    };
    const result = compactSessionMemory(mem, 50000);
    expect(result.needsCompaction).toBe(false);
    expect(result.memory.entries).toHaveLength(1);
  });

  it("marks compaction needed when entries exceed maxTokens", () => {
    // Create 40 entries with substantial text (~100 chars each ≈ 25 tokens)
    const entries: SessionMemoryEntry[] = [];
    for (let i = 0; i < 40; i++) {
      entries.push(
        makeEntry(
          i * 5,
          i * 5 + 4,
          "llm",
          `Summary batch ${i}: discussed topic ${i}, decided to ${i % 2 === 0 ? "proceed" : "refactor"}. Files changed: src/module-${i}.ts.`,
        ),
      );
    }
    const mem: SessionMemory = { entries, lastSummarizedTurn: 199 };

    // Set low maxTokens to trigger compaction
    const result = compactSessionMemory(mem, 200);
    expect(result.needsCompaction).toBe(true);
    expect(result.entriesToCompact.length).toBeGreaterThan(0);
    expect(result.entriesToCompact.length).toBeLessThanOrEqual(20); // oldest 50%
  });

  it("selects oldest 50% of entries for compaction", () => {
    const entries: SessionMemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry(i * 5, i * 5 + 4));
    }
    const mem: SessionMemory = { entries, lastSummarizedTurn: 49 };

    const result = compactSessionMemory(mem, 10); // Very low max to force
    expect(result.needsCompaction).toBe(true);
    expect(result.entriesToCompact).toHaveLength(5); // 50% of 10
    // Should be the OLDEST entries
    expect(result.entriesToCompact[0].turnRange[0]).toBe(0);
    expect(result.entriesToCompact[4].turnRange[0]).toBe(20);
  });

  it("preserves recent entries (not selected for compaction)", () => {
    const entries: SessionMemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry(i * 5, i * 5 + 4));
    }
    const mem: SessionMemory = { entries, lastSummarizedTurn: 49 };

    const result = compactSessionMemory(mem, 10);
    // Recent entries should be preserved
    expect(result.recentEntries).toHaveLength(5);
    expect(result.recentEntries[0].turnRange[0]).toBe(25);
  });

  it("replaceWithEpoch creates correct epoch entry", () => {
    const entries: SessionMemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry(i * 5, i * 5 + 4));
    }
    const mem: SessionMemory = { entries, lastSummarizedTurn: 49 };

    const result = compactSessionMemory(mem, 10);
    const epochEntry = result.replaceWithEpoch(
      "Epoch summary: covered topics 0-24, key decisions made.",
    );

    expect(epochEntry.quality).toBe("epoch");
    expect(epochEntry.turnRange[0]).toBe(0);
    expect(epochEntry.turnRange[1]).toBe(24);
    expect(epochEntry.summary).toContain("Epoch summary");

    // Apply the compaction
    const compacted: SessionMemory = {
      entries: [epochEntry, ...result.recentEntries],
      lastSummarizedTurn: mem.lastSummarizedTurn,
    };
    expect(compacted.entries).toHaveLength(6); // 1 epoch + 5 recent
  });
});
