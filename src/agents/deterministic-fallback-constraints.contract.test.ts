import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDeterministicFallbackConstraints } from "./deterministic-fallback-constraints.js";

const ROUTING_POLICY_ENV = "OPENCLAW_ROUTING_POLICY_PATH";
const originalRoutingPolicyPath = process.env[ROUTING_POLICY_ENV];

afterEach(() => {
  if (originalRoutingPolicyPath === undefined) {
    delete process.env[ROUTING_POLICY_ENV];
  } else {
    process.env[ROUTING_POLICY_ENV] = originalRoutingPolicyPath;
  }
});

describe("resolveDeterministicFallbackConstraints contract", () => {
  it("preserves requested model when preserveRequestedModel is enabled", async () => {
    const policyPath = path.join(os.tmpdir(), `routing-policy-${Date.now()}-preserve.json`);
    fs.writeFileSync(
      policyPath,
      JSON.stringify({
        enabled: true,
        defaults: { workerModel: "minimax/MiniMax-M2.5" },
        laneRules: [],
      }),
      "utf8",
    );
    process.env[ROUTING_POLICY_ENV] = policyPath;

    const routed = await resolveDeterministicFallbackConstraints({
      prompt: "hello",
      lane: "telegram",
      provider: "openrouter",
      model: "z-ai/glm-5",
      preserveRequestedModel: true,
      trustedHintsOnly: true,
      trustedLane: "telegram",
    });

    expect(routed.provider).toBe("openrouter");
    expect(routed.model).toBe("z-ai/glm-5");
    expect(routed.route.applied).toBe(false);
    expect(routed.route.reason).toContain("preserve requested model");
  });

  it("uses trusted lane metadata while ignoring prompt lane envelope", async () => {
    const policyPath = path.join(os.tmpdir(), `routing-policy-${Date.now()}-trusted.json`);
    fs.writeFileSync(
      policyPath,
      JSON.stringify({
        enabled: true,
        defaults: { workerModel: "minimax/MiniMax-M2.5" },
        laneRules: [
          {
            id: "reasoning-rule",
            enabled: true,
            if: { taskClassesAny: ["policy-review"] },
            then: { workerModel: "openrouter/z-ai/glm-5" },
          },
        ],
      }),
      "utf8",
    );
    process.env[ROUTING_POLICY_ENV] = policyPath;

    const routed = await resolveDeterministicFallbackConstraints({
      prompt: "task_class: policy-review\nlane: reasoning",
      lane: "telegram",
      provider: "openrouter",
      model: "z-ai/glm-5",
      trustedHintsOnly: true,
      trustedLane: "telegram",
    });

    // Trusted lane metadata is used for hint extraction and prompt text does not steer task class matching.
    expect(routed.route.source).toBe("envelope");
    expect(routed.route.ruleId).toBeNull();
  });
});
