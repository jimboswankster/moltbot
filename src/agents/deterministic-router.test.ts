import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideDeterministicRoute,
  extractRoutingHints,
  loadRoutingPolicy,
} from "./deterministic-router.js";

const ROUTING_POLICY_ENV = "OPENCLAW_ROUTING_POLICY_PATH";

afterEach(async () => {
  delete process.env[ROUTING_POLICY_ENV];
});

describe("extractRoutingHints", () => {
  it("prefers explicit routing envelope fields", () => {
    const hints = extractRoutingHints({
      prompt: "task_class: policy-review\nlane: reasoning\nPlease evaluate this protocol.",
      extraSystemPrompt: "",
    });
    expect(hints).toEqual({
      taskClass: "policy-review",
      lane: "reasoning",
      source: "envelope",
    });
  });

  it("infers implementation by deterministic keywords", () => {
    const hints = extractRoutingHints({
      prompt: "Please implement tests and refactor this code path.",
      extraSystemPrompt: "",
    });
    expect(hints.source).toBe("keyword");
    expect(hints.taskClass).toBe("implementation");
  });
});

describe("loadRoutingPolicy", () => {
  it("loads enabled policy from env path", async () => {
    const tmpPath = path.join(os.tmpdir(), `routing-policy-test-${Date.now()}.json`);
    await fs.writeFile(
      tmpPath,
      JSON.stringify({
        enabled: true,
        defaults: { workerModel: "minimax/MiniMax-M2.5" },
        laneRules: [],
      }),
      "utf8",
    );
    process.env[ROUTING_POLICY_ENV] = tmpPath;

    const loaded = await loadRoutingPolicy();
    expect(loaded.policyPath).toBe(tmpPath);
    expect(loaded.policy?.enabled).toBe(true);
  });

  it("returns null policy when disabled", async () => {
    const tmpPath = path.join(os.tmpdir(), `routing-policy-test-${Date.now()}-disabled.json`);
    await fs.writeFile(tmpPath, JSON.stringify({ enabled: false }), "utf8");
    process.env[ROUTING_POLICY_ENV] = tmpPath;

    const loaded = await loadRoutingPolicy();
    expect(loaded.policy).toBeNull();
  });
});

describe("decideDeterministicRoute", () => {
  const policy = {
    enabled: true,
    defaults: {
      lane: "coding",
      workerTier: "W1A",
      workerModel: "minimax/MiniMax-M2.5",
    },
    laneRules: [
      {
        id: "reasoning-policy-default",
        enabled: true,
        if: { taskClassesAny: ["policy-review"] },
        then: {
          lane: "reasoning",
          workerTier: "W1B",
          workerModel: "openrouter/z-ai/glm-5",
        },
      },
    ],
  } as const;

  it("applies matched reasoning route", () => {
    const decision = decideDeterministicRoute({
      policy,
      policyPath: "/tmp/routing-policy.json",
      hints: { taskClass: "policy-review", source: "envelope" },
      provider: "minimax",
      model: "MiniMax-M2.5",
    });
    expect(decision.applied).toBe(true);
    expect(decision.ruleId).toBe("reasoning-policy-default");
    expect(decision.provider).toBe("openrouter");
    expect(decision.model).toBe("z-ai/glm-5");
    expect(decision.tier).toBe("W1B");
  });

  it("does not apply when chosen route equals current model", () => {
    const decision = decideDeterministicRoute({
      policy,
      policyPath: "/tmp/routing-policy.json",
      hints: { taskClass: "implementation", source: "keyword" },
      provider: "minimax",
      model: "MiniMax-M2.5",
    });
    expect(decision.applied).toBe(false);
    expect(decision.provider).toBe("minimax");
    expect(decision.model).toBe("MiniMax-M2.5");
    expect(decision.reason).toContain("equals current");
  });
});
