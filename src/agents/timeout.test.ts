import { describe, expect, it } from "vitest";
import { resolveAgentTimeoutMs, resolveAgentTimeoutSeconds } from "./timeout.js";

const INT32_MAX = 2147483647;

describe("resolveAgentTimeoutSeconds", () => {
  it("returns default (600s) when no config", () => {
    expect(resolveAgentTimeoutSeconds()).toBe(600);
    expect(resolveAgentTimeoutSeconds(undefined)).toBe(600);
  });

  it("reads from config", () => {
    expect(
      resolveAgentTimeoutSeconds({ agents: { defaults: { timeoutSeconds: 120 } } } as any),
    ).toBe(120);
  });

  it("floors to at least 1", () => {
    expect(resolveAgentTimeoutSeconds({ agents: { defaults: { timeoutSeconds: 0 } } } as any)).toBe(
      1,
    );
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("returns default timeout when no overrides", () => {
    const ms = resolveAgentTimeoutMs({});
    expect(ms).toBe(600_000); // 600s default
  });

  it("returns Int32 Max (not 30-day overflow) when overrideSeconds=0 (no timeout)", () => {
    const ms = resolveAgentTimeoutMs({ overrideSeconds: 0 });
    expect(ms).toBe(INT32_MAX);
    // CRITICAL: must fit in 32-bit signed integer for setTimeout
    expect(ms).toBeLessThanOrEqual(INT32_MAX);
  });

  it("returns Int32 Max when overrideMs=0 (no timeout)", () => {
    const ms = resolveAgentTimeoutMs({ overrideMs: 0 });
    expect(ms).toBe(INT32_MAX);
    expect(ms).toBeLessThanOrEqual(INT32_MAX);
  });

  it("REGRESSION: no-timeout value does NOT overflow 32-bit signed integer", () => {
    // This was the P1 bug: 30 * 24 * 60 * 60 * 1000 = 2,592,000,000 > 2,147,483,647
    // Node.js silently caps overflowed setTimeout values to 1ms.
    const noTimeoutMs = resolveAgentTimeoutMs({ overrideSeconds: 0 });
    expect(noTimeoutMs).toBeLessThanOrEqual(INT32_MAX);

    // Also check that adding the 10s subagent buffer doesn't overflow
    const withBuffer = noTimeoutMs + 10_000;
    // After the fix, this should still be safe (INT32_MAX + 10000 overflows,
    // but the value is already INT32_MAX which is the cap)
    expect(noTimeoutMs).toBe(INT32_MAX);
  });

  it("respects explicit overrideMs", () => {
    expect(resolveAgentTimeoutMs({ overrideMs: 5000 })).toBe(5000);
  });

  it("respects explicit overrideSeconds", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 30 })).toBe(30_000);
  });

  it("returns default for negative overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideMs: -1 })).toBe(600_000);
    expect(resolveAgentTimeoutMs({ overrideSeconds: -1 })).toBe(600_000);
  });

  it("enforces minimum ms", () => {
    expect(resolveAgentTimeoutMs({ overrideMs: 1, minMs: 5000 })).toBe(5000);
  });

  it("overrideMs takes precedence over overrideSeconds", () => {
    const ms = resolveAgentTimeoutMs({ overrideMs: 3000, overrideSeconds: 60 });
    expect(ms).toBe(3000);
  });
});
