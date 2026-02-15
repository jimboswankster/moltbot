import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProfileOverQuotaByPolicy,
  isProviderAllowedByBudget,
  resetQuotaPolicyCacheForTest,
  updateQuotaWindows,
} from "./auth-profiles.js";

describe("quota policy", () => {
  const originalPolicyPath = process.env.OPENCLAW_ROUTING_POLICY_PATH;

  afterEach(() => {
    if (originalPolicyPath === undefined) {
      delete process.env.OPENCLAW_ROUTING_POLICY_PATH;
    } else {
      process.env.OPENCLAW_ROUTING_POLICY_PATH = originalPolicyPath;
    }
    resetQuotaPolicyCacheForTest();
  });

  it("updates rolling quota windows on successful usage", () => {
    const now = Date.now();
    const next = updateQuotaWindows({
      stats: {},
      now,
      tokensUsed: 1234,
    });
    expect(next.quotaWindows?.minute?.requests).toBe(1);
    expect(next.quotaWindows?.minute?.tokens).toBe(1234);
    expect(next.quotaWindows?.hour?.requests).toBe(1);
    expect(next.quotaWindows?.day?.requests).toBe(1);
    expect(next.quotaWindows?.month?.requests).toBe(1);
  });

  it("enforces provider caps from routing policy", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routing-policy-"));
    const policyPath = path.join(tempDir, "routing-budget-policy.json");
    const now = Date.now();
    await fs.writeFile(
      policyPath,
      JSON.stringify(
        {
          enabled: true,
          providerCaps: {
            groq: { rpm: 1, tpm: 10 },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.OPENCLAW_ROUTING_POLICY_PATH = policyPath;
    resetQuotaPolicyCacheForTest();

    const over = isProfileOverQuotaByPolicy({
      provider: "groq",
      profileId: "groq:default",
      store: {
        version: 1,
        profiles: {
          "groq:default": { type: "api_key", provider: "groq", key: "sk" },
        },
        usageStats: {
          "groq:default": {
            quotaWindows: {
              minute: { windowStart: new Date(now).setSeconds(0, 0), requests: 1, tokens: 11 },
            },
          },
        },
      },
      now,
    });
    expect(over).toBe(true);
  });

  it("blocks paid providers when activeTier is free", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routing-policy-"));
    const policyPath = path.join(tempDir, "routing-budget-policy.json");
    await fs.writeFile(
      policyPath,
      JSON.stringify(
        {
          enabled: true,
          activeTier: "free",
          providerTiers: {
            groq: "free",
            openai: "frontier",
            cerebras: "paid",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.OPENCLAW_ROUTING_POLICY_PATH = policyPath;
    resetQuotaPolicyCacheForTest();

    expect(isProviderAllowedByBudget("groq")).toBe(true);
    expect(isProviderAllowedByBudget("cerebras")).toBe(false);
    expect(isProviderAllowedByBudget("openai")).toBe(false);
  });
});
