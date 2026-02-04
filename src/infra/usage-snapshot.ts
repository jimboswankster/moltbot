import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { resolveSessionTranscriptCandidates } from "../gateway/session-utils.fs.js";
import { listAgentsForGateway } from "../gateway/session-utils.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const SNAPSHOT_RELATIVE_PATH = path.join("os", "audits", "llm-usage-latest.json");
const DEFAULT_MAX_ENTRIES = 50;
const TOOL_SCAN_MAX_BYTES = 256 * 1024;
const TOOL_NAMES_MAX = 20;

type ToolUsageSummary = {
  names: string[];
  counts: Record<string, number>;
};

export type UsageSnapshotEntry = {
  sessionKey: string;
  agentId?: string;
  label?: string;
  displayName?: string;
  taskClass: string;
  updatedAt: number | null;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  toolUsage?: ToolUsageSummary;
  skillNames?: string[];
};

export type UsageSnapshot = {
  generatedAt: number;
  workspaceDir: string;
  path: string;
  entries: UsageSnapshotEntry[];
};

type TranscriptMessage = {
  toolName?: string;
  tool_name?: string;
  content?: Array<{ name?: string; type?: string }>;
};

function classifyTaskClass(key: string, entry?: SessionEntry): string {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (key.startsWith("cron:")) {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("node-") || key.startsWith("node:")) {
    return "node";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

function extractToolNames(message: TranscriptMessage): string[] {
  const names: string[] = [];
  if (Array.isArray(message.content)) {
    for (const entry of message.content) {
      if (typeof entry?.name === "string" && entry.name.trim()) {
        names.push(entry.name.trim());
      }
    }
  }
  const toolName = typeof message.toolName === "string" ? message.toolName : message.tool_name;
  if (typeof toolName === "string" && toolName.trim()) {
    names.push(toolName.trim());
  }
  return names;
}

function readToolUsageFromTranscript(params: {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
  agentId?: string;
}): ToolUsageSummary | undefined {
  const candidates = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  );
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return undefined;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat || stat.size === 0) {
      return undefined;
    }
    const start = Math.max(0, stat.size - TOOL_SCAN_MAX_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer
      .toString("utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const counts = new Map<string, number>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const message = parsed?.message as TranscriptMessage | undefined;
        if (!message || typeof message !== "object") {
          continue;
        }
        for (const name of extractToolNames(message)) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      } catch {
        // ignore malformed lines
      }
    }
    if (counts.size === 0) {
      return undefined;
    }
    const sorted = Array.from(counts.entries()).toSorted((a, b) => b[1] - a[1]);
    const limited = sorted.slice(0, TOOL_NAMES_MAX);
    return {
      names: limited.map(([name]) => name),
      counts: Object.fromEntries(limited),
    };
  } catch {
    return undefined;
  }
}

export async function collectUsageSnapshot(params: {
  config: OpenClawConfig;
  maxEntries?: number;
  includeTools?: boolean;
}): Promise<UsageSnapshot> {
  const { config } = params;
  const agentInfo = listAgentsForGateway(config);
  const maxEntries =
    typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
      ? Math.max(1, Math.floor(params.maxEntries))
      : DEFAULT_MAX_ENTRIES;
  const includeTools = params.includeTools !== false;

  const items: Array<
    UsageSnapshotEntry & { sessionId?: string; sessionFile?: string; storePath?: string }
  > = [];
  for (const agent of agentInfo.agents) {
    const storePath = resolveStorePath(config.session?.store, { agentId: agent.id });
    const store = loadSessionStore(storePath);
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || key === "global" || key === "unknown") {
        continue;
      }
      const input = entry.inputTokens ?? 0;
      const output = entry.outputTokens ?? 0;
      const total = entry.totalTokens ?? input + output;
      const parsedAgent = parseAgentSessionKey(key)?.agentId;
      items.push({
        sessionKey: key,
        agentId: parsedAgent ?? agent.id,
        label: entry.label ?? undefined,
        displayName: entry.displayName ?? undefined,
        taskClass: classifyTaskClass(key, entry),
        updatedAt: entry.updatedAt ?? null,
        model: entry.model ?? null,
        provider: entry.modelProvider ?? null,
        inputTokens: entry.inputTokens ?? null,
        outputTokens: entry.outputTokens ?? null,
        totalTokens: total ?? null,
        durationMs: null,
        skillNames: entry.skillsSnapshot?.skills?.map((skill) => skill.name).filter(Boolean),
        sessionId: entry.sessionId,
        sessionFile: entry.sessionFile,
        storePath,
      });
    }
  }

  const ordered = items
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, maxEntries);

  if (includeTools) {
    for (const entry of ordered) {
      if (!entry.sessionId) {
        continue;
      }
      const toolUsage = readToolUsageFromTranscript({
        sessionId: entry.sessionId,
        storePath: entry.storePath,
        sessionFile: entry.sessionFile,
        agentId: entry.agentId,
      });
      if (toolUsage) {
        entry.toolUsage = toolUsage;
      }
    }
  }

  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const snapshotPath = path.join(workspaceDir, SNAPSHOT_RELATIVE_PATH);
  const snapshot: UsageSnapshot = {
    generatedAt: Date.now(),
    workspaceDir,
    path: snapshotPath,
    entries: ordered.map((entry) => {
      const {
        sessionId: _sessionId,
        sessionFile: _sessionFile,
        storePath: _storePath,
        ...rest
      } = entry;
      return rest;
    }),
  };

  await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.promises.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

  return snapshot;
}
