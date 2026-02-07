import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

type CommandEntry = {
  id: string;
  slash: string;
  label?: string;
  prompt?: string;
};

type CommandsFile = {
  commands?: CommandEntry[];
};

function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function resolveCommandsPath(config: OpenClawConfig): string | null {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  if (!workspaceDir) {
    return null;
  }
  return path.join(workspaceDir, "os", "vault", "systems", "system-substrate", "commands.yaml");
}

function normalizeCommands(entries: CommandEntry[]): CommandEntry[] {
  return entries
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id.trim() : "",
      slash: typeof entry.slash === "string" ? entry.slash.trim() : "",
      label: typeof entry.label === "string" ? entry.label.trim() : undefined,
      prompt: typeof entry.prompt === "string" ? entry.prompt : undefined,
    }))
    .filter((entry) => entry.id && entry.slash);
}

export function handleControlUiCommandsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { basePath?: string; config?: OpenClawConfig },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;
  const commandsPath = basePath ? `${basePath}/commands` : "/commands";
  const commandsJsonPath = basePath ? `${basePath}/commands.json` : "/commands.json";
  if (pathname !== commandsPath && pathname !== commandsJsonPath) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  if (!opts?.config) {
    respondJson(res, 503, { error: "config unavailable" });
    return true;
  }

  const filePath = resolveCommandsPath(opts.config);
  if (!filePath || !fs.existsSync(filePath)) {
    respondJson(res, 404, { error: "commands registry not found" });
    return true;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(raw) as CommandsFile | null;
    const entries = Array.isArray(parsed?.commands) ? parsed.commands : [];
    respondJson(res, 200, { commands: normalizeCommands(entries) });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : err == null
            ? "failed to load commands"
            : JSON.stringify(err);
    respondJson(res, 500, { error: message });
  }
  return true;
}
