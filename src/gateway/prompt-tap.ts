/**
 * Prompt Tap — capture the exact prompt payload the model would see (dry-run).
 * Used by `openclaw debug prompt-snapshot` to write snapshot files into the workspace
 * for debugging context bloat and load order. Does not call the LLM provider.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import { resolveOpenClawDocsPath } from "../agents/docs-path.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { buildModelAliasLines } from "../agents/pi-embedded-runner/model.js";
import { buildEmbeddedSystemPrompt } from "../agents/pi-embedded-runner/system-prompt.js";
import { resolveSkillsPromptForRun } from "../agents/skills.js";
import { buildSystemPromptParams } from "../agents/system-prompt-params.js";
import { loadConfig } from "../config/config.js";
import { getMachineDisplayName } from "../infra/machine-name.js";

const SNAPSHOT_REL_DIR = path.join("os", "audits", "prompt-snapshots");

export type PromptSnapshotMode = "startup" | "query";

export type RunPromptSnapshotOptions = {
  mode: PromptSnapshotMode;
  /** Required when mode is "query". */
  message?: string;
};

export type RunPromptSnapshotResult = {
  ok: true;
  workspaceDir: string;
  snapshotDir: string;
  baseName: string;
  jsonPath: string;
  mdPath: string;
  model: string;
  sessionId: string;
};

/**
 * Generate a filesystem-safe timestamp: YYYYMMDDTHHMMSSZ
 * Exported for testing.
 */
export function snapshotTimestamp(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

/**
 * Split system prompt into harness (before "# Project Context") and workspace (from that header).
 * Exported for testing.
 */
export function splitSystemPrompt(systemPrompt: string): { harness: string; workspace: string } {
  const projectContextHeader = "# Project Context";
  const idx = systemPrompt.indexOf(projectContextHeader);
  if (idx < 0) {
    return { harness: systemPrompt, workspace: "" };
  }
  return {
    harness: systemPrompt.slice(0, idx).trimEnd(),
    workspace: systemPrompt.slice(idx).trim(),
  };
}

/**
 * Build snapshot payload and write JSON + MD to workspace.
 */
export async function runPromptSnapshot(
  opts: RunPromptSnapshotOptions,
): Promise<RunPromptSnapshotResult> {
  if (opts.mode === "query" && (opts.message == null || String(opts.message).trim() === "")) {
    throw new Error("--message is required when --mode is query");
  }

  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  if (!workspaceDir) {
    throw new Error("Could not resolve workspace directory for default agent");
  }

  const snapshotDir = path.join(workspaceDir, SNAPSHOT_REL_DIR);
  await fs.mkdir(snapshotDir, { recursive: true });

  const modelRef = resolveDefaultModelForAgent({ cfg, agentId });
  const modelLabel = `${modelRef.provider}/${modelRef.model}`;
  const sessionId = `prompt-tap-${Date.now()}`;
  const userMessage = opts.mode === "query" ? String(opts.message).trim() : "";

  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: cfg,
    agentId,
  });

  const machineName = await getMachineDisplayName();
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: cfg,
    agentId,
    workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: machineName,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: modelLabel,
      defaultModel: modelLabel,
    },
  });

  const skillsPrompt = resolveSkillsPromptForRun({
    workspaceDir,
    config: cfg,
  });

  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });

  const systemPrompt = buildEmbeddedSystemPrompt({
    workspaceDir,
    reasoningTagHint: false,
    promptMode: "full",
    runtimeInfo,
    tools: [],
    modelAliasLines: buildModelAliasLines(cfg),
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles,
    memoryCitationsMode: cfg?.memory?.citations,
    skillsPrompt: skillsPrompt ?? undefined,
    docsPath: docsPath ?? undefined,
  });

  const timestamp = snapshotTimestamp();
  const baseName = `${timestamp}-${opts.mode}`;
  const jsonPath = path.join(snapshotDir, `${baseName}.json`);
  const mdPath = path.join(snapshotDir, `${baseName}.md`);

  const messages: Array<{ role: string; source: string; content: string }> = [
    { role: "system", source: "harness", content: systemPrompt },
  ];
  if (userMessage) {
    messages.push({ role: "user", source: "debug-input", content: userMessage });
  }

  const workspaceFiles = contextFiles.map((f) => ({
    path: f.path,
    bytes: Buffer.byteLength(f.content, "utf-8"),
  }));

  const payload = {
    timestamp: new Date().toISOString(),
    sessionId,
    mode: opts.mode,
    model: modelLabel,
    messages,
    tools: [],
    workspaceFiles,
  };

  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf-8");

  const { harness, workspace } = splitSystemPrompt(systemPrompt);
  const totalBytes = workspaceFiles.reduce((sum, f) => sum + f.bytes, 0);
  const mdLines = [
    `# Prompt Snapshot — ${payload.timestamp} (mode: ${opts.mode})`,
    "",
    "## Summary",
    `- Model: ${modelLabel}`,
    `- Session: ${sessionId}`,
    "",
  ];
  if (workspaceFiles.length > 0) {
    mdLines.push(
      "## Workspace files loaded",
      "",
      "| path | bytes |",
      "| --- | ---:|",
      ...workspaceFiles.map((f) => `| ${f.path} | ${f.bytes} |`),
      "",
      `_Total: ${totalBytes} bytes across ${workspaceFiles.length} file(s)._`,
      "",
    );
  }
  mdLines.push("---", "", "## [HARNESS SYSTEM]", "```text", harness || "(none)", "```", "");
  if (workspace) {
    mdLines.push("## [WORKSPACE SYSTEM — SOUL]", "```text", workspace, "```", "");
  }
  mdLines.push(
    "## [TOOLS]",
    "```json",
    "[]",
    "```",
    "",
    "## [USER]",
    "```text",
    userMessage || "(empty for startup mode)",
    "```",
  );
  await fs.writeFile(mdPath, mdLines.join("\n"), "utf-8");

  return {
    ok: true,
    workspaceDir,
    snapshotDir,
    baseName,
    jsonPath,
    mdPath,
    model: modelLabel,
    sessionId,
  };
}
