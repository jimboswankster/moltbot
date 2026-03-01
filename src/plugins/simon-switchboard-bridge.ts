import fs from "node:fs";
import path from "node:path";
import type { PluginHookBeforeAgentStartResult } from "./types";

type BridgeMode = "shadow" | "canary" | "enforce";

type HydrationContract = {
  schema_version?: string;
  cli_hydration?: {
    banner?: string;
    required_decision_order?: string[];
    required_evidence_keys?: string[];
  };
};

type PathContract = {
  schema_version?: string;
};

const REQUIRED_ORDER = [
  "discover_reuse_existing",
  "add_recipe_to_existing_protocol",
  "new_loop_package",
];

const REQUIRED_EVIDENCE_KEYS = [
  "branch",
  "decision",
  "selected_command",
  "required_args",
  "artifact_hint",
];

function toMode(raw: string | undefined): BridgeMode {
  const token = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (token === "shadow" || token === "canary" || token === "enforce") return token;
  return "canary";
}

function resolveWorkspaceRoot(explicitWorkspaceDir?: string): string {
  if (explicitWorkspaceDir && explicitWorkspaceDir.trim()) return explicitWorkspaceDir;
  const envWorkspace = process.env.OPENCLAW_WORKSPACE_ROOT?.trim();
  if (envWorkspace) return envWorkspace;
  return path.join(process.env.HOME || "", ".openclaw", "workspace");
}

function readJson<T>(absPath: string): T {
  return JSON.parse(fs.readFileSync(absPath, "utf8")) as T;
}

function validateContracts(input: {
  pathContract: PathContract;
  hydrationContract: HydrationContract;
}): string[] {
  const findings: string[] = [];
  if (input.pathContract.schema_version !== "simon.orchestration.path.contract.v1") {
    findings.push(
      `invalid_path_contract_schema:${String(input.pathContract.schema_version ?? "")}`,
    );
  }
  if (input.hydrationContract.schema_version !== "simon.switchboard.cli.hydration.contract.v1") {
    findings.push(
      `invalid_hydration_contract_schema:${String(input.hydrationContract.schema_version ?? "")}`,
    );
  }
  const cliHydration = input.hydrationContract.cli_hydration ?? {};
  const order = Array.isArray(cliHydration.required_decision_order)
    ? cliHydration.required_decision_order
    : [];
  for (const expected of REQUIRED_ORDER) {
    if (!order.includes(expected)) findings.push(`missing_decision_order:${expected}`);
  }
  const keys = Array.isArray(cliHydration.required_evidence_keys)
    ? cliHydration.required_evidence_keys
    : [];
  for (const key of REQUIRED_EVIDENCE_KEYS) {
    if (!keys.includes(key)) findings.push(`missing_evidence_key:${key}`);
  }
  return findings;
}

export function buildSimonSwitchboardBridgeContext(input: {
  workspaceDir?: string;
  modeRaw?: string;
}): PluginHookBeforeAgentStartResult | undefined {
  const enabled =
    String(process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_ENABLED ?? "")
      .trim()
      .toLowerCase() === "true";
  if (!enabled) return undefined;
  const mode = toMode(input.modeRaw ?? process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_MODE);
  const workspaceRoot = resolveWorkspaceRoot(input.workspaceDir);
  const osRoot = path.join(workspaceRoot, "os");
  const pathContractPath = path.join(
    osRoot,
    "coordination",
    "mission-control",
    "contracts",
    "simon-orchestration-path-contract.v1.json",
  );
  const hydrationContractPath = path.join(
    osRoot,
    "coordination",
    "mission-control",
    "contracts",
    "simon-switchboard-cli-hydration-contract.v1.json",
  );

  try {
    const pathContract = readJson<PathContract>(pathContractPath);
    const hydrationContract = readJson<HydrationContract>(hydrationContractPath);
    const findings = validateContracts({ pathContract, hydrationContract });
    if (findings.length > 0 && mode === "enforce") {
      throw new Error(`simon switchboard bridge blocked: ${findings.join(",")}`);
    }
    const banner = String(
      hydrationContract.cli_hydration?.banner ?? "Simon orchestration context loaded",
    );
    const order = (hydrationContract.cli_hydration?.required_decision_order ?? REQUIRED_ORDER).join(
      " -> ",
    );
    const evidence = (
      hydrationContract.cli_hydration?.required_evidence_keys ?? REQUIRED_EVIDENCE_KEYS
    ).join(", ");
    const warning = findings.length > 0 ? `\nBridge findings: ${findings.join("; ")}` : "";
    return {
      prependContext: [
        `[SIMON SWITCHBOARD BRIDGE] ${banner}`,
        `delegate-first invariant is active; use switchboard delegation path before manual execution when task is delegatable.`,
        `deterministic decision order: ${order}`,
        `required evidence keys: ${evidence}`,
        warning,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (mode === "enforce") throw error;
    return {
      prependContext: `[SIMON SWITCHBOARD BRIDGE] degraded: ${detail}`,
    };
  }
}
