/**
 * Unit Test: resolveAgentTimeoutMs / resolveAgentTimeoutSeconds
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: resolveAgentTimeoutMs(), resolveAgentTimeoutSeconds() from timeout.ts
 * Purpose: Verify timeout resolution respects Int32 bounds (P1 overflow fix),
 *          config precedence, and minimum enforcement.
 */
import { describe, expect, it } from "vitest";
import { resolveAgentTimeoutMs, resolveAgentTimeoutSeconds } from "./timeout.js";

const INT32_MAX = 2147483647;

describe("resolveAgentTimeoutSeconds", () => {
  it("is a function with arity 1 (cfg)", () => {
    // Observable: function signature
    expect(typeof resolveAgentTimeoutSeconds).toBe("function");
    expect(resolveAgentTimeoutSeconds.name).toBe("resolveAgentTimeoutSeconds");
  });

  it("returns default 600s when no config provided", () => {
    // Observable: return value from resolveAgentTimeoutSeconds
    expect(resolveAgentTimeoutSeconds()).toBe(600);
    expect(resolveAgentTimeoutSeconds(undefined)).toBe(600);
  });

  it("reads timeoutSeconds from config", () => {
    // Observable: return value — config value propagated
    const cfg = { agents: { defaults: { timeoutSeconds: 120 } } } as any;
    expect(resolveAgentTimeoutSeconds(cfg)).toBe(120);
  });

  it("floors to minimum of 1 second", () => {
    // Observable: return value — zero clamped to 1
    const cfg = { agents: { defaults: { timeoutSeconds: 0 } } } as any;
    expect(resolveAgentTimeoutSeconds(cfg)).toBe(1);
  });

  it("caps telegram timeout to 120s by default when global timeout is higher", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 240 } } } as any;
    expect(resolveAgentTimeoutSeconds(cfg, { channel: "telegram" })).toBe(120);
  });

  it("supports explicit per-channel timeout override", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 240, timeoutSecondsByChannel: { telegram: 90 } } },
    } as any;
    expect(resolveAgentTimeoutSeconds(cfg, { channel: "telegram" })).toBe(90);
  });

  it("detects telegram context from session key when channel is absent", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 240 } } } as any;
    expect(
      resolveAgentTimeoutSeconds(cfg, { sessionKey: "agent:main:telegram:group:-100123:topic:99" }),
    ).toBe(120);
  });

  it("does not increase timeout when global default is already lower than telegram cap", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 75 } } } as any;
    expect(resolveAgentTimeoutSeconds(cfg, { channel: "telegram" })).toBe(75);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("is a function with arity 1 (opts)", () => {
    // Observable: function signature
    expect(typeof resolveAgentTimeoutMs).toBe("function");
    expect(resolveAgentTimeoutMs.name).toBe("resolveAgentTimeoutMs");
  });

  it("returns default timeout (600_000ms) when no overrides", () => {
    // Observable: return value from resolveAgentTimeoutMs
    const ms = resolveAgentTimeoutMs({});
    expect(ms).toBe(600_000);
  });

  // -- P1 Regression: Int32 overflow --

  it("REGRESSION: overrideSeconds=0 returns Int32 Max (not 30-day overflow)", () => {
    // Observable: return value — must be Int32 Max, not 2,592,000,000 (old 30-day value)
    // The old value (30 * 24 * 60 * 60 * 1000 = 2,592,000,000) exceeds Int32 Max (2,147,483,647).
    // Node.js silently caps overflowed setTimeout values to 1ms, causing instant timeout.
    const ms = resolveAgentTimeoutMs({ overrideSeconds: 0 });
    expect(ms).toBe(INT32_MAX);
    expect(ms).toBeLessThanOrEqual(INT32_MAX);
  });

  it("REGRESSION: overrideMs=0 returns Int32 Max (not overflow)", () => {
    // Observable: return value — ms path also caps correctly
    const ms = resolveAgentTimeoutMs({ overrideMs: 0 });
    expect(ms).toBe(INT32_MAX);
    expect(ms).toBeLessThanOrEqual(INT32_MAX);
  });

  it("REGRESSION: no-timeout value fits in 32-bit signed integer for setTimeout", () => {
    // Observable: return value — the value passed to setTimeout must not overflow
    const noTimeoutMs = resolveAgentTimeoutMs({ overrideSeconds: 0 });
    expect(noTimeoutMs).toBeLessThanOrEqual(INT32_MAX);
    expect(noTimeoutMs).toBeGreaterThan(0);
    // Verify it's exactly Int32 Max (not some arbitrary large number)
    expect(noTimeoutMs).toBe(2_147_483_647);
  });

  // -- Override precedence --

  it("respects explicit overrideMs value", () => {
    // Observable: return value — overrideMs propagated
    expect(resolveAgentTimeoutMs({ overrideMs: 5000 })).toBe(5000);
  });

  it("respects explicit overrideSeconds value", () => {
    // Observable: return value — overrideSeconds converted to ms
    expect(resolveAgentTimeoutMs({ overrideSeconds: 30 })).toBe(30_000);
  });

  it("overrideMs takes precedence over overrideSeconds", () => {
    // Observable: return value — ms override wins when both provided
    const ms = resolveAgentTimeoutMs({ overrideMs: 3000, overrideSeconds: 60 });
    expect(ms).toBe(3000);
  });

  // -- Negative / invalid inputs --

  it("returns default for negative overrideMs", () => {
    // Observable: return value — negative treated as "use default"
    expect(resolveAgentTimeoutMs({ overrideMs: -1 })).toBe(600_000);
  });

  it("returns default for negative overrideSeconds", () => {
    // Observable: return value — negative treated as "use default"
    expect(resolveAgentTimeoutMs({ overrideSeconds: -1 })).toBe(600_000);
  });

  it("enforces minimum ms floor", () => {
    // Observable: return value — small override clamped to minMs
    expect(resolveAgentTimeoutMs({ overrideMs: 1, minMs: 5000 })).toBe(5000);
  });

  it("ignores non-finite overrides", () => {
    // Observable: return value — NaN/Infinity treated as missing
    expect(resolveAgentTimeoutMs({ overrideMs: NaN })).toBe(600_000);
    expect(resolveAgentTimeoutMs({ overrideMs: Infinity })).toBe(600_000);
    expect(resolveAgentTimeoutMs({ overrideSeconds: NaN })).toBe(600_000);
  });

  it("uses telegram-scoped default when channel is telegram", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 240 } } } as any;
    expect(resolveAgentTimeoutMs({ cfg, channel: "telegram" })).toBe(120_000);
  });

  it("keeps explicit override precedence over telegram-scoped default", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 240 } } } as any;
    expect(resolveAgentTimeoutMs({ cfg, channel: "telegram", overrideSeconds: 300 })).toBe(300_000);
  });
});
