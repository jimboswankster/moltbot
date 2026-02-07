/**
 * CHARACTERIZATION TESTS — H-5: Memory Flush Availability Gate
 *
 * These tests pin CURRENT (broken) behavior for safe refactoring.
 * They are NOT correctness tests. They WILL be deleted/updated
 * when the corresponding fix lands.
 *
 * Hardening area: H-5
 * Source: src/auto-reply/reply/memory-flush.ts
 * Broken behavior: shouldRunMemoryFlush ignores model availability
 * Paired remediation contract: memory-flush.availability.contract.test.ts
 * Lifecycle: DELETE after fix H-5 commits
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 1: Characterization)
 */

import { describe, it, expect } from "vitest";
import { shouldRunMemoryFlush } from "./memory-flush.js";

describe("shouldRunMemoryFlush availability characterization", () => {
  it("returns true based purely on token math (no availability check)", () => {
    const result = shouldRunMemoryFlush({
      entry: { totalTokens: 90_000, compactionCount: 1, memoryFlushCompactionCount: 0 },
      contextWindowTokens: 100_000,
      reserveTokensFloor: 5_000,
      softThresholdTokens: 4_000,
    });

    expect(result).toBe(true);
  });
});
