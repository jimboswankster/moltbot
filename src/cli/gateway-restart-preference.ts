import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const OPENCLAW_GATEWAY_RESTART_RE =
  /^(?:(?:pnpm|npm|bunx|npx)\s+)?openclaw(?:\s+--profile(?:=|\s+)\S+|\s+--dev)*\s+gateway\s+restart(?=\s|$)(.*)$/;

export type HydraGatewayRestartInvocation = {
  command: string;
  args: string[];
};

function isHydraRestartDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.OPENCLAW_PREFER_HYDRA_RESTART?.trim() === "0";
}

function resolveHydraScriptPath(env: NodeJS.ProcessEnv): string | null {
  const stateDir = resolveStateDir(env, os.homedir);
  const scriptPath = path.join(stateDir, "workspace", "scripts", "hydra");
  return fs.existsSync(scriptPath) ? scriptPath : null;
}

export function resolveHydraGatewayRestartInvocation(
  env: NodeJS.ProcessEnv = process.env,
): HydraGatewayRestartInvocation | null {
  // Backward-compat guard: environments that do not include the private Hydra
  // workspace keep using the public OpenClaw daemon restart path unchanged.
  if (isHydraRestartDisabled(env)) {
    return null;
  }
  const hydraScript = resolveHydraScriptPath(env);
  if (!hydraScript) {
    return null;
  }
  return {
    command: process.execPath,
    args: [hydraScript, "gateway", "restart"],
  };
}

export function rewriteGatewayRestartCommandForHydra(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Keep legacy command text unless we can prove Hydra is locally available.
  // This avoids suggesting a command that would fail in standard OSS installs.
  if (isHydraRestartDisabled(env)) {
    return command;
  }
  if (!resolveHydraScriptPath(env)) {
    return command;
  }
  const match = command.match(OPENCLAW_GATEWAY_RESTART_RE);
  if (!match) {
    return command;
  }
  const suffix = match[1] ?? "";
  return `hydra gateway restart${suffix}`;
}
