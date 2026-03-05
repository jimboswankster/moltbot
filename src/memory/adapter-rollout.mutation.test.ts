import { describe, expect, it, vi } from "vitest";
import { routeMemorySearch } from "./adapter-rollout.js";

describe("routeMemorySearch mutation guards", () => {
  it("must not call adapter probe in off mode", async () => {
    const probe = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const legacySearch = vi.fn(async () => []);
    const result = await routeMemorySearch({
      query: "q",
      agentId: "main",
      stateOverride: { mode: "off", rollout_percent: 0, legacy_fallback_hot: true },
      adapterProbe: probe,
      legacySearch,
    });
    expect(probe).toHaveBeenCalledTimes(0);
    expect(result.decision.reason).toBe("rollout_off");
    expect(result.chosenBackend).toBe("legacy");
  });

  it("must not call adapter probe in shadow mode", async () => {
    const probe = vi.fn(async () => null);
    const legacySearch = vi.fn(async () => []);
    const result = await routeMemorySearch({
      query: "q",
      agentId: "main",
      stateOverride: { mode: "shadow", rollout_percent: 10, legacy_fallback_hot: true },
      adapterProbe: probe,
      legacySearch,
    });
    expect(probe).toHaveBeenCalledTimes(0);
    expect(result.decision.reason).toBe("shadow_mode");
    expect(result.chosenBackend).toBe("legacy");
  });

  it("must fail closed to summary_only when adapter path degrades", async () => {
    const longSnippet = "x".repeat(1200);
    const result = await routeMemorySearch({
      query: "q",
      agentId: "main",
      sessionKey: "s",
      stateOverride: { mode: "default_prefer", rollout_percent: 100, legacy_fallback_hot: true },
      adapterSearch: async () => {
        throw new Error("adapter down");
      },
      legacySearch: async () => [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.4,
          snippet: longSnippet,
          source: "memory" as const,
        },
      ],
    });
    expect(result.degradationMode).toBe("summary_only");
    expect(result.results.length).toBe(1);
    expect(String(result.results[0]?.snippet || "").length).toBeLessThanOrEqual(323);
  });

  it("must return empty summary_only when adapter and fallback both fail", async () => {
    const result = await routeMemorySearch({
      query: "q",
      agentId: "main",
      sessionKey: "s",
      stateOverride: { mode: "default_prefer", rollout_percent: 100, legacy_fallback_hot: true },
      adapterSearch: async () => {
        throw new Error("adapter down");
      },
      legacySearch: async () => {
        throw new Error("legacy down");
      },
    });
    expect(result.chosenBackend).toBe("legacy");
    expect(result.degradationMode).toBe("summary_only");
    expect(result.results).toEqual([]);
  });
});
