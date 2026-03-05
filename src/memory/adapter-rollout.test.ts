import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  decideMemoryBrokerRoute,
  isAdapterModulePathAllowed,
  memoryBrokerCanaryBucket,
  routeMemorySearch,
} from "./adapter-rollout.js";

describe("memory broker rollout routing", () => {
  it("uses deterministic canary bucket", () => {
    const a = memoryBrokerCanaryBucket("session:123");
    const b = memoryBrokerCanaryBucket("session:123");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it("routes to legacy in shadow mode", () => {
    const decision = decideMemoryBrokerRoute({
      state: { mode: "shadow", rollout_percent: 10, legacy_fallback_hot: true },
      routingKey: "k",
      adapterAvailable: true,
    });
    expect(decision.backend).toBe("legacy");
    expect(decision.reason).toBe("shadow_mode");
  });

  it("routes to adapter in default_prefer mode when adapter is available", () => {
    const decision = decideMemoryBrokerRoute({
      state: { mode: "default_prefer", rollout_percent: 10, legacy_fallback_hot: true },
      routingKey: "k",
      adapterAvailable: true,
    });
    expect(decision.backend).toBe("adapter");
  });

  it("enforces adapter module allowed-root boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-allowed-root-"));
    const allowedRoot = path.join(tmp, "allowed");
    const blockedRoot = path.join(tmp, "blocked");
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(blockedRoot, { recursive: true });
    const allowedFile = path.join(allowedRoot, "adapter-candidate-runner.ts");
    const blockedFile = path.join(blockedRoot, "adapter-candidate-runner.ts");
    fs.writeFileSync(allowedFile, "export default null;\n", "utf8");
    fs.writeFileSync(blockedFile, "export default null;\n", "utf8");
    const prev = process.env.OPENCLAW_MEMORY_ADAPTER_ALLOWED_ROOT;
    process.env.OPENCLAW_MEMORY_ADAPTER_ALLOWED_ROOT = allowedRoot;
    try {
      expect(isAdapterModulePathAllowed(allowedFile)).toBe(true);
      expect(isAdapterModulePathAllowed(blockedFile)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_MEMORY_ADAPTER_ALLOWED_ROOT;
      else process.env.OPENCLAW_MEMORY_ADAPTER_ALLOWED_ROOT = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("routeMemorySearch", () => {
  it("keeps legacy path when adapter probe throws in off mode", async () => {
    const prev = process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY;
    process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = "0";
    const legacySearch = vi.fn(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.5,
        snippet: "legacy",
        source: "memory" as const,
      },
    ]);
    try {
      const result = await routeMemorySearch({
        query: "q",
        agentId: "main",
        sessionKey: "s",
        stateOverride: {
          mode: "off",
          rollout_percent: 0,
          legacy_fallback_hot: true,
        },
        legacySearch,
        adapterProbe: async () => {
          throw new Error("adapter probe failed");
        },
      });
      expect(result.chosenBackend).toBe("legacy");
      expect(result.decision.reason).toBe("rollout_off");
      expect(legacySearch).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY;
      } else {
        process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = prev;
      }
    }
  });

  it("falls back to legacy and marks degradation when adapter fails", async () => {
    const prev = process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY;
    process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = "0";
    const legacySearch = vi.fn(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.5,
        snippet: "legacy",
        source: "memory" as const,
      },
    ]);
    const adapterSearch = vi.fn(async () => {
      throw new Error("adapter boom");
    });

    try {
      const result = await routeMemorySearch({
        query: "q",
        agentId: "main",
        sessionKey: "s",
        stateOverride: {
          mode: "default_prefer",
          rollout_percent: 100,
          legacy_fallback_hot: true,
        },
        legacySearch,
        adapterSearch,
      });

      expect(result.chosenBackend).toBe("legacy");
      expect(result.degradationMode).toBe("summary_only");
      expect(legacySearch).toHaveBeenCalledTimes(1);
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results[0]?.snippet).toBe("legacy");
      expect(result.results.length).toBe(1);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY;
      } else {
        process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = prev;
      }
    }
  });

  it("fails closed without throw when adapter and legacy fallback both fail", async () => {
    const prev = process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY;
    process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = "0";
    const legacySearch = vi.fn(async () => {
      throw new Error("legacy down");
    });
    const adapterSearch = vi.fn(async () => {
      throw new Error("adapter down");
    });
    try {
      const result = await routeMemorySearch({
        query: "q",
        agentId: "main",
        sessionKey: "s",
        stateOverride: {
          mode: "default_prefer",
          rollout_percent: 100,
          legacy_fallback_hot: true,
        },
        legacySearch,
        adapterSearch,
      });
      expect(result.chosenBackend).toBe("legacy");
      expect(result.degradationMode).toBe("summary_only");
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBe(0);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY;
      } else {
        process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = prev;
      }
    }
  });

  it("writes stale/contradiction signals to degraded query telemetry", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-rollout-telemetry-"));
    const prev = {
      enabled: process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY,
      query: process.env.OPENCLAW_MEMORY_BROKER_QUERY_TELEMETRY_FILE,
      errors: process.env.OPENCLAW_MEMORY_BROKER_ERROR_TELEMETRY_FILE,
    };
    const queryPath = path.join(tmp, "query.jsonl");
    const errorPath = path.join(tmp, "error.jsonl");
    process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = "1";
    process.env.OPENCLAW_MEMORY_BROKER_QUERY_TELEMETRY_FILE = queryPath;
    process.env.OPENCLAW_MEMORY_BROKER_ERROR_TELEMETRY_FILE = errorPath;
    try {
      await routeMemorySearch({
        query: "q",
        agentId: "main",
        sessionKey: "s",
        stateOverride: {
          mode: "default_prefer",
          rollout_percent: 100,
          legacy_fallback_hot: true,
        },
        legacySearch: async () => [],
        adapterSearch: async () => {
          throw new Error("adapter boom");
        },
      });
      const rows = fs
        .readFileSync(queryPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const degraded = rows.find((row) => String(row.status || "") === "degraded");
      expect(degraded).toBeTruthy();
      const details = (degraded?.details || {}) as Record<string, unknown>;
      expect(details.stale).toBe(true);
      expect(details.contradiction).toBe(false);
    } finally {
      if (prev.enabled === undefined) delete process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY;
      else process.env.OPENCLAW_MEMORY_BROKER_TELEMETRY = prev.enabled;
      if (prev.query === undefined) delete process.env.OPENCLAW_MEMORY_BROKER_QUERY_TELEMETRY_FILE;
      else process.env.OPENCLAW_MEMORY_BROKER_QUERY_TELEMETRY_FILE = prev.query;
      if (prev.errors === undefined) delete process.env.OPENCLAW_MEMORY_BROKER_ERROR_TELEMETRY_FILE;
      else process.env.OPENCLAW_MEMORY_BROKER_ERROR_TELEMETRY_FILE = prev.errors;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
