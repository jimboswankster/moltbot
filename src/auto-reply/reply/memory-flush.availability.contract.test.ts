/**
 * REMEDIATION CONTRACT TESTS — H-5: Memory Flush Availability Gate
 *
 * These tests define CORRECT behavior. They are RED until fix H-5 lands.
 * After the fix, they become permanent regression tests.
 *
 * Hardening area: H-5
 * Source: src/auto-reply/reply/memory-flush.ts
 * Correct behavior: availability-aware decision returns false when no viable model exists
 * Paired characterization: memory-flush.availability.characterization.test.ts
 * Status: RED -> GREEN when fix H-5 lands
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 2: Remediation Contract)
 */

import { describe, it, expect } from "vitest";
import { shouldRunMemoryFlush } from "./memory-flush.js";

describe("shouldRunMemoryFlush availability remediation contract", () => {
  it("returns false when tokens exceed threshold but no model is available", () => {
    // Expected contract: new availability-aware gate prevents flush
    const result = shouldRunMemoryFlush({
      entry: { totalTokens: 90_000, compactionCount: 1, memoryFlushCompactionCount: 0 },
      contextWindowTokens: 100_000,
      reserveTokensFloor: 5_000,
      softThresholdTokens: 4_000,
      isAnyModelAvailable: false,
    });

    expect(result).toBe(false);
  });
});
