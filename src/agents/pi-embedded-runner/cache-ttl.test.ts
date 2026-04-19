/**
 * Unit Test: isCacheTtlEligibleProvider + readLastCacheTtlTimestamp
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: cache-ttl.ts functions
 * Purpose: Verify cache-ttl pruning eligibility + timestamp reading works correctly.
 *          Tests edge cases that upstream fix (a327b6750d) addresses.
 */
import { describe, expect, it, vi } from "vitest";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  // -- Function identity --

  it("is a function with arity 2 (provider, modelId)", () => {
    // Observable: function signature
    expect(typeof isCacheTtlEligibleProvider).toBe("function");
    expect(isCacheTtlEligibleProvider.length).toBe(2);
    expect(isCacheTtlEligibleProvider.name).toBe("isCacheTtlEligibleProvider");
  });

  // -- Eligible providers (positive cases) --

  it("returns true for anthropic provider", () => {
    // Observable: return value from isCacheTtlEligibleProvider
    expect(isCacheTtlEligibleProvider("anthropic", "claude-3-5-sonnet")).toBe(true);
  });

  it("returns true for Anthropic (case insensitive)", () => {
    // Observable: return value — case normalization
    expect(isCacheTtlEligibleProvider("Anthropic", "claude-3-5-sonnet")).toBe(true);
    expect(isCacheTtlEligibleProvider("ANTHROPIC", "claude-3-5-sonnet")).toBe(true);
  });

  it("returns true for google provider (E-005 P0-CE fix)", () => {
    // Observable: return value — Google pruning gate enabled
    // This is the 1-line fix that prevents Gemini context explosion.
    expect(isCacheTtlEligibleProvider("google", "gemini-3-pro-preview")).toBe(true);
  });

  it("returns true for Google (case insensitive)", () => {
    // Observable: return value — case normalization for Google
    expect(isCacheTtlEligibleProvider("Google", "gemini-3-pro-preview")).toBe(true);
    expect(isCacheTtlEligibleProvider("GOOGLE", "gemini-2.5-flash")).toBe(true);
  });

  it("returns true for openrouter with anthropic model prefix", () => {
    // Observable: return value — openrouter + anthropic/ prefix triggers eligibility
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-3-5-sonnet")).toBe(true);
  });

  // -- Ineligible providers (negative cases) --

  it("returns false for openrouter with non-anthropic model", () => {
    // Observable: return value — non-anthropic openrouter models are ineligible
    expect(isCacheTtlEligibleProvider("openrouter", "google/gemini-pro")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "meta-llama/llama-3")).toBe(false);
  });

  it("returns false for openai provider", () => {
    // Observable: return value — openai is not eligible
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
  });

  it("returns false for ollama provider", () => {
    // Observable: return value — local providers are not eligible
    expect(isCacheTtlEligibleProvider("ollama", "llama3.1:8b")).toBe(false);
  });

  it("returns false for unknown providers", () => {
    // Observable: return value — unknown strings default to ineligible
    expect(isCacheTtlEligibleProvider("unknown", "some-model")).toBe(false);
  });

  it("returns false for empty string inputs", () => {
    // Observable: return value — empty strings do not match any provider
    expect(isCacheTtlEligibleProvider("", "")).toBe(false);
    expect(isCacheTtlEligibleProvider("", "claude-3")).toBe(false);
  });
});

// =============================================================================
// readLastCacheTtlTimestamp - Chaos Engineering Tests
// =============================================================================

describe("readLastCacheTtlTimestamp", () => {
  // -- Happy path --

  it("returns numeric timestamp when valid entry exists", () => {
    // Observable: return value from readLastCacheTtlTimestamp
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: 1713532800000 } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBe(1713532800000);
  });

  it("returns last valid entry when multiple entries exist", () => {
    // Observable: returns LAST valid entry in array order (not highest)
    // This is correct - the "last" entry is the most recently written
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: 1000 } },
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: 3000 } },
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: 2000 } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBe(2000);
  });

  // -- Edge cases: null/undefined --

  it("returns null when timestamp is null", () => {
    // Observable: null timestamp should return null (not crash)
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: null } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  it("returns null when timestamp is undefined", () => {
    // Observable: undefined timestamp should return null
    const mockSm = {
      getEntries: () => [{ type: "custom", customType: "openclaw.cache-ttl", data: {} }],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  // -- Edge cases: wrong types --

  it("returns null when timestamp is a string (ISO date)", () => {
    // ⚠️ THIS IS THE UPSTREAM BUG - string timestamps not handled
    // Observable: string timestamps should be handled or return null
    const mockSm = {
      getEntries: () => [
        {
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: { timestamp: "2026-04-19T17:00:00Z" },
        },
      ],
    };
    const result = readLastCacheTtlTimestamp(mockSm as any);
    // Currently returns null (string is not a number) - could be improved
    expect(result).toBeNull();
  });

  it("returns null when timestamp is a number string", () => {
    // ⚠️ Edge case: "12345" string vs 12345 number
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: "1713532800000" } },
      ],
    };
    const result = readLastCacheTtlTimestamp(mockSm as any);
    // Currently returns null - string is not typeof "number"
    expect(result).toBeNull();
  });

  // -- Edge cases: non-finite numbers --

  it("returns null when timestamp is Infinity", () => {
    // Observable: Infinity should be filtered out
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: Infinity } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  it("returns null when timestamp is NaN", () => {
    // Observable: NaN should be filtered out
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: NaN } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  it("returns null when timestamp is negative number", () => {
    // Observable: negative timestamps should be filtered (not finite)
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: -1000 } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  // -- Edge cases: wrong entry types --

  it("skips entries with wrong customType", () => {
    // Observable: should find the valid entry, skip invalid
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "other-type", data: { timestamp: 1000 } },
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: 2000 } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBe(2000);
  });

  it("skips entries with wrong type field", () => {
    // Observable: type must be "custom"
    const mockSm = {
      getEntries: () => [
        { type: "message", customType: "openclaw.cache-ttl", data: { timestamp: 1000 } },
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: 2000 } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBe(2000);
  });

  it("returns null when no entries exist", () => {
    // Observable: empty array should return null
    const mockSm = { getEntries: () => [] };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  // -- Error handling --

  it("returns null when session manager is null", () => {
    // Observable: null input should return null
    expect(readLastCacheTtlTimestamp(null)).toBeNull();
  });

  it("returns null when session manager is undefined", () => {
    // Observable: undefined input should return null
    expect(readLastCacheTtlTimestamp(undefined)).toBeNull();
  });

  it("returns null when session manager has no getEntries", () => {
    // Observable: missing getEntries should return null
    expect(readLastCacheTtlTimestamp({})).toBeNull();
  });

  it("returns null when getEntries throws", () => {
    // Observable: exceptions should be caught, return null
    const mockSm = {
      getEntries: () => {
        throw new Error("Simulated failure");
      },
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  it("returns last valid timestamp even if earlier entries are invalid", () => {
    // Observable: scans backwards, finds first valid
    const mockSm = {
      getEntries: () => [
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: null } },
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: undefined } },
        { type: "custom", customType: "openclaw.cache-ttl", data: { timestamp: 2000 } },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBe(2000);
  });

  // -- Data structure edge cases --

  it("returns null when data is null", () => {
    // Observable: null data should not crash
    const mockSm = {
      getEntries: () => [{ type: "custom", customType: "openclaw.cache-ttl", data: null }],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  it("returns null when data is undefined", () => {
    // Observable: undefined data should not crash
    const mockSm = {
      getEntries: () => [{ type: "custom", customType: "openclaw.cache-ttl" }],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });

  it("returns null when entry is completely malformed", () => {
    // Observable: garbage in, null out (no crash)
    const mockSm = {
      getEntries: () => [
        "not an object",
        null,
        undefined,
        { type: "custom" },
        { customType: "openclaw.cache-ttl" },
      ],
    };
    expect(readLastCacheTtlTimestamp(mockSm as any)).toBeNull();
  });
});
