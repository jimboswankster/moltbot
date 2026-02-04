import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxContext, SandboxWorkspaceInfo } from "./types.js";
import { DEFAULT_BROWSER_EVALUATE_ENABLED } from "../../browser/constants.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { syncSkillsToWorkspace } from "../skills.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { ensureSandboxContainer } from "./docker.js";
import { maybePruneSandboxes } from "./prune.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";
import { ensureSandboxWorkspace } from "./workspace.js";

export async function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const rawSessionKey = params.sessionKey?.trim();
  console.log(`[sandbox] resolveSandboxContext start sessionKey=${rawSessionKey ?? "(none)"}`);
  if (!rawSessionKey) {
    console.log(`[sandbox] no sessionKey, returning null`);
    return null;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: rawSessionKey,
  });
  console.log(
    `[sandbox] runtime status: sandboxed=${runtime.sandboxed} mode=${runtime.mode} sessionKey=${runtime.sessionKey}`,
  );
  if (!runtime.sandboxed) {
    console.log(`[sandbox] not sandboxed, returning null`);
    return null;
  }

  const cfg = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  console.log(`[sandbox] config resolved, pruning sandboxes...`);

  await maybePruneSandboxes(cfg);
  console.log(`[sandbox] prune complete`);

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
  console.log(
    `[sandbox] workspaceDirs resolved: sandboxWorkspaceDir=${sandboxWorkspaceDir} workspaceDir=${workspaceDir}`,
  );
  if (workspaceDir === sandboxWorkspaceDir) {
    console.log(`[sandbox] ensuring sandbox workspace...`);
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
    );
    console.log(`[sandbox] sandbox workspace ensured`);
    if (cfg.workspaceAccess !== "rw") {
      console.log(`[sandbox] syncing skills...`);
      try {
        await syncSkillsToWorkspace({
          sourceWorkspaceDir: agentWorkspaceDir,
          targetWorkspaceDir: sandboxWorkspaceDir,
          config: params.config,
        });
        console.log(`[sandbox] skills synced`);
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
        console.log(`[sandbox] skills sync failed: ${message}`);
      }
    }
  } else {
    console.log(`[sandbox] creating workspaceDir...`);
    await fs.mkdir(workspaceDir, { recursive: true });
    console.log(`[sandbox] workspaceDir created`);
  }

  console.log(`[sandbox] ensuring Docker container...`);
  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg,
  });
  console.log(`[sandbox] Docker container ready: ${containerName ?? "(none)"}`);

  const evaluateEnabled =
    params.config?.browser?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;
  console.log(`[sandbox] ensuring browser...`);
  const browser = await ensureSandboxBrowser({
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg,
    evaluateEnabled,
  });
  console.log(`[sandbox] browser ready`);

  return {
    enabled: true,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    workspaceAccess: cfg.workspaceAccess,
    containerName,
    containerWorkdir: cfg.docker.workdir,
    docker: cfg.docker,
    tools: cfg.tools,
    browserAllowHostControl: cfg.browser.allowHostControl,
    browser: browser ?? undefined,
  };
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: rawSessionKey,
  });
  if (!runtime.sandboxed) {
    return null;
  }

  const cfg = resolveSandboxConfigForAgent(params.config, runtime.agentId);

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
    );
    if (cfg.workspaceAccess !== "rw") {
      try {
        await syncSkillsToWorkspace({
          sourceWorkspaceDir: agentWorkspaceDir,
          targetWorkspaceDir: sandboxWorkspaceDir,
          config: params.config,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
      }
    }
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  return {
    workspaceDir,
    containerWorkdir: cfg.docker.workdir,
  };
}
