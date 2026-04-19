import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHydraGatewayRestartInvocation,
  rewriteGatewayRestartCommandForHydra,
} from "./gateway-restart-preference.js";

function createHydraFixture(): { stateDir: string; scriptPath: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hydra-pref-"));
  const scriptPath = path.join(stateDir, "workspace", "scripts", "hydra");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");
  return { stateDir, scriptPath };
}

describe("gateway restart hydra preference", () => {
  it("resolves hydra invocation when workspace hydra exists", () => {
    const { stateDir, scriptPath } = createHydraFixture();
    const invocation = resolveHydraGatewayRestartInvocation({
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    });
    expect(invocation).toEqual({
      command: process.execPath,
      args: [scriptPath, "gateway", "restart"],
    });
  });

  it("keeps original restart command when hydra is unavailable", () => {
    const rewritten = rewriteGatewayRestartCommandForHydra("openclaw gateway restart", {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "missing-hydra-fixture"),
    });
    expect(rewritten).toBe("openclaw gateway restart");
  });

  it("rewrites restart command with profile flags and preserves extra args", () => {
    const { stateDir } = createHydraFixture();
    const rewritten = rewriteGatewayRestartCommandForHydra(
      "openclaw --profile work gateway restart --json",
      {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
    );
    expect(rewritten).toBe("hydra gateway restart --json");
  });

  it("supports explicit disable flag for backward compatibility", () => {
    const { stateDir } = createHydraFixture();
    const rewritten = rewriteGatewayRestartCommandForHydra("openclaw gateway restart", {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_PREFER_HYDRA_RESTART: "0",
    });
    expect(rewritten).toBe("openclaw gateway restart");
    expect(
      resolveHydraGatewayRestartInvocation({
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_PREFER_HYDRA_RESTART: "0",
      }),
    ).toBeNull();
  });

  it("keeps Hydra as the only restart authority in managed workspaces", () => {
    const registerPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "gateway-cli",
      "register.ts",
    );
    const registerSource = fs.readFileSync(registerPath, "utf8");
    expect(registerSource).toContain("refusing fallback to direct daemon restart");
    expect(registerSource).not.toContain("falling back to daemon restart");
  });
});
