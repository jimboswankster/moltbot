import type { GatewayHelloOk } from "./gateway";
import type { SessionsListResult } from "./types";
import type { ChatEventPayload } from "./controllers/chat";

export type AgentActivity = {
  sessionKey: string;
  agentId: string;
  role: "main" | "subagent";
  active: boolean;
  lastUpdated: number;
  lastState: ChatEventPayload["state"] | "unknown";
};

const ACTIVE_STALE_MS = 12_000;
const MAX_RETENTION_MS = 30 * 60 * 1000;
/** Consider a subagent "active" if it had tokens and was updated within this window. */
const SUBAGENT_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

type ActivityHost = {
  hello: GatewayHelloOk | null;
  sessionsResult: SessionsListResult | null;
  activityEntries: AgentActivity[];
  activityBySession: Map<string, AgentActivity>;
};

function resolveMainSessionKey(
  hello: GatewayHelloOk | null,
  sessions: SessionsListResult | null,
): string | null {
  const snapshot = hello?.snapshot as { sessionDefaults?: SessionDefaultsSnapshot } | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  if (sessions?.sessions?.some((row) => row.key === "main")) {
    return "main";
  }
  return null;
}

function resolveRole(sessionKey: string, host: ActivityHost): "main" | "subagent" | null {
  const mainSessionKey = resolveMainSessionKey(host.hello, host.sessionsResult);
  if (mainSessionKey && sessionKey === mainSessionKey) {
    return "main";
  }
  if (!mainSessionKey && sessionKey === "main") {
    return "main";
  }
  if (isSubagentSessionKey(sessionKey)) {
    return "subagent";
  }
  return null;
}

function resolveAgentId(sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed?.agentId ?? "unknown";
}

type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

function parseAgentSessionKey(sessionKey: string | undefined | null): ParsedAgentSessionKey | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  if (parts[0] !== "agent") {
    return null;
  }
  const agentId = parts[1]?.trim();
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) {
    return null;
  }
  return { agentId, rest };
}

function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return false;
  }
  if (raw.toLowerCase().startsWith("subagent:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return Boolean((parsed?.rest ?? "").toLowerCase().startsWith("subagent:"));
}

function buildEntries(host: ActivityHost): AgentActivity[] {
  const entries = Array.from(host.activityBySession.values());
  entries.sort((a, b) => {
    if (a.role !== b.role) {
      return a.role === "main" ? -1 : 1;
    }
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }
    return b.lastUpdated - a.lastUpdated;
  });
  return entries;
}

export function noteChatActivity(host: ActivityHost, payload?: ChatEventPayload) {
  if (!payload?.sessionKey) {
    return;
  }
  const sessionKey = payload.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  const role = resolveRole(sessionKey, host);
  if (!role) {
    return;
  }
  const now = Date.now();
  const existing = host.activityBySession.get(sessionKey);
  const active =
    payload.state === "delta"
      ? true
      : payload.state === "final" || payload.state === "aborted" || payload.state === "error"
        ? false
        : existing?.active ?? false;
  const next: AgentActivity = {
    sessionKey,
    agentId: existing?.agentId ?? resolveAgentId(sessionKey),
    role,
    active,
    lastUpdated: now,
    lastState: payload.state ?? "unknown",
  };
  host.activityBySession.set(sessionKey, next);
  host.activityEntries = buildEntries(host);
}

export function ensureMainActivity(host: ActivityHost) {
  const mainSessionKey = resolveMainSessionKey(host.hello, host.sessionsResult);
  if (!mainSessionKey) {
    return;
  }
  if (host.activityBySession.has(mainSessionKey)) {
    return;
  }
  const now = Date.now();
  host.activityBySession.set(mainSessionKey, {
    sessionKey: mainSessionKey,
    agentId: "main",
    role: "main",
    active: false,
    lastUpdated: now,
    lastState: "unknown",
  });
  host.activityEntries = buildEntries(host);
}

export function sweepActivity(host: ActivityHost, now = Date.now()) {
  let changed = false;
  for (const [key, entry] of host.activityBySession.entries()) {
    const age = now - entry.lastUpdated;
    if (age > MAX_RETENTION_MS) {
      host.activityBySession.delete(key);
      changed = true;
      continue;
    }
    if (entry.active && age > ACTIVE_STALE_MS) {
      entry.active = false;
      entry.lastState = "unknown";
      changed = true;
    }
  }
  if (changed) {
    host.activityEntries = buildEntries(host);
  }
}

/**
 * Sync subagent sessions from sessions.list into the activity host so the HUD
 * shows subagents even when they have not yet emitted chat events to this client.
 * Call after loadSessions (or when sessionsResult is updated).
 */
export function syncSubagentsFromSessionsList(host: ActivityHost): void {
  const sessions = host.sessionsResult?.sessions;
  if (!Array.isArray(sessions)) {
    return;
  }
  const now = Date.now();
  let changed = false;
  for (const row of sessions) {
    const key = row?.key?.trim();
    if (!key || !isSubagentSessionKey(key)) {
      continue;
    }
    const existing = host.activityBySession.get(key);
    const updatedAt = typeof row.updatedAt === "number" ? row.updatedAt : now;
    const totalTokens = typeof row.totalTokens === "number" ? row.totalTokens : 0;
    const recentlyActive =
      totalTokens > 0 && updatedAt > 0 && now - updatedAt < SUBAGENT_ACTIVE_WINDOW_MS;
    const active = existing?.active ?? recentlyActive;
    const next: AgentActivity = {
      sessionKey: key,
      agentId: existing?.agentId ?? resolveAgentId(key),
      role: "subagent",
      active,
      lastUpdated: existing ? Math.max(existing.lastUpdated, updatedAt) : updatedAt,
      lastState: existing?.lastState ?? "unknown",
    };
    host.activityBySession.set(key, next);
    changed = true;
  }
  if (changed) {
    host.activityEntries = buildEntries(host);
  }
}
