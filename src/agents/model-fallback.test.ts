import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { getFallbackTelemetry, resetFallbackTelemetry } from "../infra/fallback-telemetry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { resetKloopPolicyCacheForTest } from "./auth-profiles/kloop-policy.js";
import { resetQuotaPolicyCacheForTest } from "./auth-profiles/quota-policy.js";
import {
  resetModelCandidateCooldownsForTest,
  resolveFallbackCandidates,
  runWithModelFallback,
} from "./model-fallback.js";

function makeCfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-haiku-3-5"],
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("runWithModelFallback", () => {
  const originalStatePath = process.env.OPENCLAW_KLOOP_STATE_PATH;
  const originalRoutingPolicyPath = process.env.OPENCLAW_ROUTING_POLICY_PATH;

  beforeEach(() => {
    resetModelCandidateCooldownsForTest();
    resetKloopPolicyCacheForTest();
    resetQuotaPolicyCacheForTest();
  });

  afterEach(() => {
    resetModelCandidateCooldownsForTest();
    if (originalStatePath === undefined) {
      delete process.env.OPENCLAW_KLOOP_STATE_PATH;
    } else {
      process.env.OPENCLAW_KLOOP_STATE_PATH = originalStatePath;
    }
    if (originalRoutingPolicyPath === undefined) {
      delete process.env.OPENCLAW_ROUTING_POLICY_PATH;
    } else {
      process.env.OPENCLAW_ROUTING_POLICY_PATH = originalRoutingPolicyPath;
    }
    resetKloopPolicyCacheForTest();
    resetQuotaPolicyCacheForTest();
  });

  it("does not fall back on non-auth errors", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockRejectedValueOnce(new Error("bad request")).mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("bad request");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back on auth errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 401 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("adds non-ollama fallback candidate for ollama cloud models when available", () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "ollama/glm-5:cloud",
            fallbacks: [],
          },
          models: {
            "ollama/glm-5:cloud": { alias: "glm-5" },
            "openrouter/z-ai/glm-5": { alias: "glm-5-openrouter" },
          },
        },
      },
    });

    const candidates = resolveFallbackCandidates({
      cfg,
      provider: "ollama",
      model: "glm-5:cloud",
    });
    expect(candidates.slice(0, 2)).toEqual([
      { provider: "ollama", model: "glm-5:cloud" },
      { provider: "openrouter", model: "z-ai/glm-5" },
    ]);
  });

  it("falls back on 402 payment required", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("payment required"), { status: 402 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on billing errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "LLM request rejected: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        ),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on credential validation errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('No credentials found for profile "anthropic:default".'))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("skips providers when all profiles are in cooldown", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-test-${crypto.randomUUID()}`;
    const profileId = `${provider}:default`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider,
          key: "test-key",
        },
      },
      usageStats: {
        [profileId]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/m1`,
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (providerId, modelId) => {
      if (providerId === "fallback") {
        return "ok";
      }
      throw new Error(`unexpected provider: ${providerId}/${modelId}`);
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider,
        model: "m1",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toEqual([["fallback", "ok-model"]]);
      expect(result.attempts[0]?.reason).toBe("rate_limit");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips providers when all profiles are breaker-open in K-loop state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-kloop-"));
    const provider = `kloop-open-${crypto.randomUUID()}`;
    const profileA = `${provider}:default`;
    const profileB = `${provider}:route1`;
    const statePath = path.join(tempDir, "free-engine-kloop-state.json");
    const future = Date.now() + 60_000;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileA]: {
          type: "api_key",
          provider,
          key: "test-key-a",
        },
        [profileB]: {
          type: "api_key",
          provider,
          key: "test-key-b",
        },
      },
      order: {
        [provider]: [profileA, profileB],
      },
    };

    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          routes: {
            [`${provider}:default`]: {
              routeId: "default",
              provider,
              breakerState: "open",
              inferredCooldownUntil: future,
            },
            [`${provider}:route1`]: {
              routeId: "route1",
              provider,
              breakerState: "open",
              inferredCooldownUntil: future,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.OPENCLAW_KLOOP_STATE_PATH = statePath;
    resetKloopPolicyCacheForTest();

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/m1`,
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (providerId, modelId) => {
      if (providerId === "fallback") {
        return "ok";
      }
      throw new Error(`unexpected provider: ${providerId}/${modelId}`);
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider,
        model: "m1",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toEqual([["fallback", "ok-model"]]);
      expect(result.attempts[0]?.reason).toBe("rate_limit");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not skip when any profile is available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-mixed-${crypto.randomUUID()}`;
    const profileA = `${provider}:a`;
    const profileB = `${provider}:b`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileA]: {
          type: "api_key",
          provider,
          key: "key-a",
        },
        [profileB]: {
          type: "api_key",
          provider,
          key: "key-b",
        },
      },
      usageStats: {
        [profileA]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/m1`,
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (providerId) => {
      if (providerId === provider) {
        return "ok";
      }
      return "unexpected";
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider,
        model: "m1",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toEqual([[provider, "m1"]]);
      expect(result.attempts).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not append configured primary when fallbacksOverride is set", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockImplementation(() => Promise.reject(Object.assign(new Error("nope"), { status: 401 })));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: ["anthropic/claude-haiku-3-5"],
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4-5"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("uses fallbacksOverride instead of agents.defaults.model.fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as OpenClawConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    const res = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallbacksOverride: ["openai/gpt-4.1"],
      run: async (provider, model) => {
        calls.push({ provider, model });
        if (provider === "anthropic") {
          throw Object.assign(new Error("nope"), { status: 401 });
        }
        if (provider === "openai" && model === "gpt-4.1") {
          return "ok";
        }
        throw new Error(`unexpected candidate: ${provider}/${model}`);
      },
    });

    expect(res.result).toBe("ok");
    expect(calls).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "openai", model: "gpt-4.1" },
    ]);
  });

  it("skips a provider blocked by budget tier policy", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-budget-tier-"));
    const policyPath = path.join(tempDir, "routing-budget-policy.json");
    await fs.writeFile(
      policyPath,
      JSON.stringify(
        {
          enabled: true,
          activeTier: "free",
          providerTiers: {
            openai: "frontier",
            groq: "free",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.OPENCLAW_ROUTING_POLICY_PATH = policyPath;
    resetQuotaPolicyCacheForTest();

    const calls: Array<{ provider: string; model: string }> = [];
    const res = await runWithModelFallback({
      cfg: makeCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-4.1-mini",
              fallbacks: ["groq/llama-3.3-70b-versatile"],
            },
          },
        },
      }),
      provider: "openai",
      model: "gpt-4.1-mini",
      run: async (provider, model) => {
        calls.push({ provider, model });
        if (provider === "groq") return "ok";
        throw new Error(`blocked provider should not run: ${provider}/${model}`);
      },
    });

    expect(res.result).toBe("ok");
    expect(calls).toEqual([{ provider: "groq", model: "llama-3.3-70b-versatile" }]);
    expect(res.attempts[0]?.provider).toBe("openai");
    expect(res.attempts[0]?.reason).toBe("billing");
  });

  it("treats an empty fallbacksOverride as disabling global fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as OpenClawConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: [],
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw new Error("primary failed");
        },
      }),
    ).rejects.toThrow("primary failed");

    expect(calls).toEqual([{ provider: "anthropic", model: "claude-opus-4-5" }]);
  });

  it("defaults provider/model when missing (regression #946)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];

    const result = await runWithModelFallback({
      cfg,
      provider: undefined as unknown as string,
      model: undefined as unknown as string,
      run: async (provider, model) => {
        calls.push({ provider, model });
        return "ok";
      },
    });

    expect(result.result).toBe("ok");
    expect(calls).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);
  });

  it("falls back on missing API key errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("No API key found for profile openai."))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on lowercase credential errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("no api key found for profile openai"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on timeout abort errors", async () => {
    const cfg = makeCfg();
    const timeoutCause = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError", cause: timeoutCause }),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on abort errors with timeout reasons", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError", reason: "deadline exceeded" }),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back when message says aborted but error is a timeout", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("request aborted"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on provider abort errors with request-aborted messages", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Request was aborted"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("does not fall back on user aborts", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("appends the configured primary as a last fallback", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b:free",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
  });

  it("warns when fallback rate exceeds the pre-cascade threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-06T00:00:00.000Z"));
    resetFallbackTelemetry();
    resetSystemEventsForTest();

    const fallbacks = Array.from({ length: 10 }, (_, idx) => `anthropic/haiku-${idx + 1}`);
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks,
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("All models failed");

    const telemetry = getFallbackTelemetry();
    expect(telemetry.lastHourCount).toBe(11);
    expect(telemetry.warningCount).toBe(1);

    const sessionKey = resolveMainSessionKey(cfg);
    const events = peekSystemEvents(sessionKey);
    expect(events.some((event) => event.includes("Pre-cascade warning"))).toBe(true);

    vi.useRealTimers();
  });

  it("skips a rate-limited provider/model on subsequent runs even without auth profiles", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-flash-preview",
            fallbacks: ["ollama/kimi-k2.5:cloud"],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Quota exceeded for metric; Please retry in 24.572922388s. status=RESOURCE_EXHAUSTED",
        ),
      )
      .mockResolvedValue("ok");

    const first = await runWithModelFallback({
      cfg,
      provider: "google",
      model: "gemini-3-flash-preview",
      run,
    });
    expect(first.result).toBe("ok");
    expect(run.mock.calls).toEqual([
      ["google", "gemini-3-flash-preview"],
      ["ollama", "kimi-k2.5:cloud"],
    ]);

    run.mockClear();
    const second = await runWithModelFallback({
      cfg,
      provider: "google",
      model: "gemini-3-flash-preview",
      run,
    });
    expect(second.result).toBe("ok");
    expect(run.mock.calls).toEqual([["ollama", "kimi-k2.5:cloud"]]);
  });
});
