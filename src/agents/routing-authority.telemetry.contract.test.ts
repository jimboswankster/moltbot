import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDeterministicFallbackConstraints } from "./deterministic-fallback-constraints.js";
import { runWithModelFallback } from "./model-fallback.js";

const originalTelemetryFile = process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
const originalLegacyMirror = process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY;
const originalRoutingPolicyPath = process.env.OPENCLAW_ROUTING_POLICY_PATH;
const originalRoutingPolicyOverride = process.env.OPENCLAW_ROUTING_POLICY_ALLOW_ENV_OVERRIDE;

afterEach(() => {
  if (originalTelemetryFile === undefined) delete process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
  else process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = originalTelemetryFile;
  if (originalLegacyMirror === undefined)
    delete process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY;
  else process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = originalLegacyMirror;
  if (originalRoutingPolicyPath === undefined) delete process.env.OPENCLAW_ROUTING_POLICY_PATH;
  else process.env.OPENCLAW_ROUTING_POLICY_PATH = originalRoutingPolicyPath;
  if (originalRoutingPolicyOverride === undefined)
    delete process.env.OPENCLAW_ROUTING_POLICY_ALLOW_ENV_OVERRIDE;
  else process.env.OPENCLAW_ROUTING_POLICY_ALLOW_ENV_OVERRIDE = originalRoutingPolicyOverride;
});

function readTelemetryRows(
  telemetryPath: string,
): Array<{ event?: string; details?: Record<string, unknown> }> {
  const raw = fs.readFileSync(telemetryPath, "utf8").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { event?: string; details?: Record<string, unknown> });
}

describe("routing authority telemetry contract", () => {
  it("emits chain fields on deterministic route constraints", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-route-telemetry-"));
    const telemetryPath = path.join(root, "runtime-telemetry.jsonl");
    const policyPath = path.join(root, "routing-policy.json");
    fs.writeFileSync(
      policyPath,
      JSON.stringify({
        enabled: true,
        defaults: { workerModel: "minimax/MiniMax-M2.5" },
        laneRules: [],
      }),
      "utf8",
    );
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";
    process.env.OPENCLAW_ROUTING_POLICY_PATH = policyPath;
    process.env.OPENCLAW_ROUTING_POLICY_ALLOW_ENV_OVERRIDE = "1";

    await resolveDeterministicFallbackConstraints({
      prompt: "hello",
      provider: "openrouter",
      model: "z-ai/glm-5",
    });

    const rows = readTelemetryRows(telemetryPath);
    const row = rows.find((entry) => entry.event === "agent.model_route_constraints");
    expect(row).toBeDefined();
    expect(row?.details?.intended_model).toBe("openrouter/z-ai/glm-5");
    expect(row?.details?.selected_model).toBe("minimax/MiniMax-M2.5");
    expect(row?.details?.effective_model).toBe("minimax/MiniMax-M2.5");
    expect(row?.details?.policy_authority).toBe(policyPath);
    expect(Array.isArray(row?.details?.override_chain)).toBe(true);
    expect(row?.details?.override_chain).toEqual(["requested", "deterministic_route"]);
    expect(row?.details?.mismatch_reason).toBe("deterministic_route_applied");
  });

  it("emits chain fields on fallback success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fallback-telemetry-"));
    const telemetryPath = path.join(root, "runtime-telemetry.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";

    await runWithModelFallback({
      provider: "openrouter",
      model: "z-ai/glm-5",
      telemetryContext: {
        policyAuthority: "routing-policy.v1.json#test",
        policyVersion: 1,
      },
      run: async () => ({
        payloads: [],
        meta: {
          agentMeta: {
            provider: "openrouter",
            model: "z-ai/glm-5",
          },
        },
      }),
    });

    const rows = readTelemetryRows(telemetryPath);
    const row = rows.find((entry) => entry.event === "agent.model_fallback_succeeded");
    expect(row).toBeDefined();
    expect(row?.details?.intended_model).toBe("openrouter/z-ai/glm-5");
    expect(row?.details?.selected_model).toBe("openrouter/z-ai/glm-5");
    expect(row?.details?.effective_model).toBe("openrouter/z-ai/glm-5");
    expect(row?.details?.policy_authority).toBe("routing-policy.v1.json#test");
    expect(row?.details?.policy_version).toBe(1);
    expect(Array.isArray(row?.details?.override_chain)).toBe(true);
    expect(row?.details?.override_chain).toEqual(["requested", "selected_candidate", "effective"]);
    expect(row?.details?.mismatch_reason).toBeNull();
  });

  it("records fallback mismatch reason when effective metadata diverges", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fallback-mismatch-"));
    const telemetryPath = path.join(root, "runtime-telemetry.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";

    await runWithModelFallback({
      provider: "openrouter",
      model: "z-ai/glm-5",
      telemetryContext: {
        policyAuthority: "routing-policy.v1.json#test",
        policyVersion: 1,
      },
      run: async () => ({
        payloads: [],
        meta: {
          agentMeta: {
            provider: "minimax",
            model: "MiniMax-M2.5",
          },
        },
      }),
    });

    const rows = readTelemetryRows(telemetryPath);
    const row = rows.find((entry) => entry.event === "agent.model_fallback_succeeded");
    expect(row).toBeDefined();
    expect(row?.details?.policy_authority).toBe("routing-policy.v1.json#test");
    expect(row?.details?.policy_version).toBe(1);
    expect(row?.details?.mismatch_reason).toBe("effective_model_metadata_mismatch");
  });
});
