import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSimonSwitchboardBridgeContext } from "./simon-switchboard-bridge.js";

const tempDirs: string[] = [];
const prevEnabled = process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_ENABLED;

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-simon-bridge-"));
  tempDirs.push(dir);
  return dir;
}

function writeContracts(workspaceDir: string, hydration: Record<string, unknown>) {
  const contractDir = path.join(workspaceDir, "os", "coordination", "mission-control", "contracts");
  fs.mkdirSync(contractDir, { recursive: true });
  fs.writeFileSync(
    path.join(contractDir, "simon-orchestration-path-contract.v1.json"),
    JSON.stringify({ schema_version: "simon.orchestration.path.contract.v1" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(contractDir, "simon-switchboard-cli-hydration-contract.v1.json"),
    JSON.stringify(hydration, null, 2),
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (prevEnabled === undefined) {
    delete process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_ENABLED;
  } else {
    process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_ENABLED = prevEnabled;
  }
});

describe("buildSimonSwitchboardBridgeContext", () => {
  it("injects deterministic bridge context when contracts are valid", () => {
    process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_ENABLED = "true";
    const workspaceDir = makeTempWorkspace();
    writeContracts(workspaceDir, {
      schema_version: "simon.switchboard.cli.hydration.contract.v1",
      cli_hydration: {
        banner: "Simon orchestration context loaded",
        required_decision_order: [
          "discover_reuse_existing",
          "add_recipe_to_existing_protocol",
          "new_loop_package",
        ],
        required_evidence_keys: [
          "branch",
          "decision",
          "selected_command",
          "required_args",
          "artifact_hint",
        ],
      },
    });
    const result = buildSimonSwitchboardBridgeContext({ workspaceDir, modeRaw: "enforce" });
    expect(result?.prependContext).toContain("deterministic decision order");
    expect(result?.prependContext).toContain("delegate-first invariant");
  });

  it("throws in enforce mode when hydration contract is invalid", () => {
    process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_ENABLED = "true";
    const workspaceDir = makeTempWorkspace();
    writeContracts(workspaceDir, {
      schema_version: "simon.switchboard.cli.hydration.contract.v1",
      cli_hydration: {
        banner: "",
        required_decision_order: ["discover_reuse_existing"],
        required_evidence_keys: ["branch"],
      },
    });
    expect(() => buildSimonSwitchboardBridgeContext({ workspaceDir, modeRaw: "enforce" })).toThrow(
      /simon switchboard bridge blocked/i,
    );
  });

  it("degrades in canary mode when hydration contract is invalid", () => {
    process.env.OPENCLAW_SIMON_SWITCHBOARD_BRIDGE_ENABLED = "true";
    const workspaceDir = makeTempWorkspace();
    writeContracts(workspaceDir, {
      schema_version: "simon.switchboard.cli.hydration.contract.v1",
      cli_hydration: {
        banner: "",
        required_decision_order: ["discover_reuse_existing"],
        required_evidence_keys: ["branch"],
      },
    });
    const result = buildSimonSwitchboardBridgeContext({ workspaceDir, modeRaw: "canary" });
    expect(result?.prependContext).toContain("Bridge findings");
  });
});
