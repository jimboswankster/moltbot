/**
 * Unit Test: isCacheTtlEligibleProvider
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: isCacheTtlEligibleProvider() from cache-ttl.ts
 * Purpose: Verify cache-ttl pruning eligibility gate returns correct boolean
 *          for each provider. Google support (E-005 P0-CE fix) is critical.
 */
import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

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
