import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("returns true for anthropic", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-3-5-sonnet")).toBe(true);
  });

  it("returns true for Anthropic (case insensitive)", () => {
    expect(isCacheTtlEligibleProvider("Anthropic", "claude-3-5-sonnet")).toBe(true);
    expect(isCacheTtlEligibleProvider("ANTHROPIC", "claude-3-5-sonnet")).toBe(true);
  });

  it("returns true for google", () => {
    expect(isCacheTtlEligibleProvider("google", "gemini-3-pro-preview")).toBe(true);
  });

  it("returns true for Google (case insensitive)", () => {
    expect(isCacheTtlEligibleProvider("Google", "gemini-3-pro-preview")).toBe(true);
    expect(isCacheTtlEligibleProvider("GOOGLE", "gemini-2.5-flash")).toBe(true);
  });

  it("returns true for openrouter with anthropic model prefix", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-3-5-sonnet")).toBe(true);
  });

  it("returns false for openrouter with non-anthropic model", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "google/gemini-pro")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "meta-llama/llama-3")).toBe(false);
  });

  it("returns false for openai", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
  });

  it("returns false for ollama", () => {
    expect(isCacheTtlEligibleProvider("ollama", "llama3.1:8b")).toBe(false);
  });

  it("returns false for unknown providers", () => {
    expect(isCacheTtlEligibleProvider("unknown", "some-model")).toBe(false);
    expect(isCacheTtlEligibleProvider("", "")).toBe(false);
  });
});
