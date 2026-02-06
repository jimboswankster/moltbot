import type { OpenClawApp } from "./app";
import type { EventLogEntry } from "./app-events";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import type { GatewayEventFrame, GatewayHelloOk } from "./gateway";
import type { Tab } from "./navigation";
import type { UiSettings } from "./storage";
import type { AgentsListResult, PresenceEntry, HealthSnapshot, StatusSummary } from "./types";
import { CHAT_SESSIONS_ACTIVE_MINUTES, flushChatQueueForEvent } from "./app-chat";
import { applySettings, loadCron, refreshActiveTab, setLastActiveSessionKey } from "./app-settings";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream";
import { ensureMainActivity, noteChatActivity, syncSubagentsFromSessionsList, type AgentActivity } from "./activity-hud-state";
import { loadAgents } from "./controllers/agents";
import { loadAssistantIdentity } from "./controllers/assistant-identity";
import { loadChatHistory } from "./controllers/chat";
import { handleChatEvent, type ChatEventPayload } from "./controllers/chat";
import { loadDevices } from "./controllers/devices";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  removeExecApproval,
} from "./controllers/exec-approval";
import { loadNodes } from "./controllers/nodes";
import { loadSessions } from "./controllers/sessions";
import { GatewayBrowserClient } from "./gateway";

type GatewayHost = {
  settings: UiSettings;
  password: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  debugHealth: HealthSnapshot | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  chatRunId: string | null;
  pendingChatResync: boolean;
  chatResyncTimer: number | null;
  refreshSessionsAfterChat: Set<string>;
  activityEntries: AgentActivity[];
  activityBySession: Map<string, AgentActivity>;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

const CHAT_DEBUG_FLAG = "openclaw:chat:debug";
const shouldDebugChat = () =>
  typeof localStorage !== "undefined" && localStorage.getItem(CHAT_DEBUG_FLAG) === "1";

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

function scheduleChatResync(host: GatewayHost, delayMs = 500) {
  if (host.chatResyncTimer != null) {
    window.clearTimeout(host.chatResyncTimer);
  }
  host.chatResyncTimer = window.setTimeout(() => {
    host.chatResyncTimer = null;
    if (!host.connected || !host.client) {
      return;
    }
    void loadChatHistory(host as unknown as OpenClawApp);
  }, delayMs);
}

export function connectGateway(host: GatewayHost) {
  host.lastError = null;
  host.hello = null;
  host.connected = false;
  host.execApprovalQueue = [];
  host.execApprovalError = null;

  host.client?.stop();
  host.client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    onHello: (hello) => {
      host.connected = true;
      host.lastError = null;
      host.hello = hello;
      applySnapshot(host, hello);
      ensureMainActivity(host as unknown as Parameters<typeof ensureMainActivity>[0]);
      // Reset orphaned chat run state from before disconnect unless we plan to resync.
      // Any in-flight run's final event was lost during the disconnect window.
      if (!host.pendingChatResync) {
        host.chatRunId = null;
        (host as unknown as { chatStream: string | null }).chatStream = null;
        (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
        resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      }
      void loadAssistantIdentity(host as unknown as OpenClawApp);
      void loadAgents(host as unknown as OpenClawApp);
      void loadNodes(host as unknown as OpenClawApp, { quiet: true });
      void loadDevices(host as unknown as OpenClawApp, { quiet: true });
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
      if (host.pendingChatResync) {
        host.pendingChatResync = false;
        scheduleChatResync(host, 800);
      }
      if (host.tab === "activity-hud") {
        void loadSessions(host as unknown as OpenClawApp, { limit: 50, activeMinutes: 60 }).then(
          () => {
            syncSubagentsFromSessionsList(host as unknown as Parameters<typeof syncSubagentsFromSessionsList>[0]);
            (host as unknown as OpenClawApp).requestUpdate();
          },
        );
      }
    },
    onClose: ({ code, reason }) => {
      host.connected = false;
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      if (code !== 1012) {
        host.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      }
      if (host.chatRunId || (host as unknown as { chatStream: string | null }).chatStream) {
        host.pendingChatResync = true;
      }
    },
    onEvent: (evt) => handleGatewayEvent(host, evt),
    onGap: ({ expected, received }) => {
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`;
      host.pendingChatResync = true;
      scheduleChatResync(host);
    },
  });
  host.client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (host.tab === "debug") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) {
      return;
    }
    const payload = evt.payload as AgentEventPayload | undefined;
    if (payload) {
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
      const activeSession = host.sessionKey;
      const matchesSession = sessionKey ? sessionKey === activeSession : false;
      const currentRun = host.chatRunId;
      const runMatches = !currentRun || currentRun === payload.runId;
      const matchesRunOnly = !sessionKey && currentRun === payload.runId;
      const lastSendAt = (host as unknown as { lastChatSendAt?: number | null }).lastChatSendAt;
      const lastSendRunId = (host as unknown as { lastChatSendRunId?: string | null })
        .lastChatSendRunId;
      const recentSend = typeof lastSendAt === "number" && Date.now() - lastSendAt < 120_000;
      const matchesRecentRun = recentSend && currentRun && lastSendRunId === currentRun;
      if ((matchesSession && runMatches) || matchesRunOnly || matchesRecentRun) {
        if (shouldDebugChat()) {
          console.debug("[chat][agent] event", {
            stream: payload.stream,
            runId: payload.runId,
            sessionKey,
            activeSession,
            matchesSession,
            runMatches,
            matchesRunOnly,
            matchesRecentRun,
            hasText: typeof payload.data?.text === "string",
            hasDelta: typeof payload.data?.delta === "string",
          });
        }
        if (!host.chatRunId) {
          host.chatRunId = payload.runId;
        }
        const startedAt = (host as unknown as { chatStreamStartedAt: number | null })
          .chatStreamStartedAt;
        if (!startedAt) {
          (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt =
            typeof payload.ts === "number" ? payload.ts : Date.now();
        }
        if (payload.stream === "tool" || payload.stream === "lifecycle") {
          if ((host as unknown as { chatStream: string | null }).chatStream === null) {
            (host as unknown as { chatStream: string | null }).chatStream = "";
          }
        }
        if (payload.stream === "assistant" && typeof payload.data?.text === "string") {
          (host as unknown as { chatStream: string | null }).chatStream = payload.data.text;
        } else if (payload.stream === "lifecycle" && payload.data?.phase === "end") {
          if (host.chatRunId === payload.runId) {
            host.chatRunId = null;
            (host as unknown as { chatStream: string | null }).chatStream = null;
            (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
            void loadChatHistory(host as unknown as OpenClawApp);
          }
        } else if (payload.stream === "lifecycle" && payload.data?.phase === "error") {
          if (host.chatRunId === payload.runId) {
            host.chatRunId = null;
            (host as unknown as { chatStream: string | null }).chatStream = null;
            (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
            void loadChatHistory(host as unknown as OpenClawApp);
          }
        }
      }
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      payload,
    );
    (host as unknown as OpenClawApp).requestUpdate();
    return;
  }

  if (evt.event === "chat") {
    const payload = evt.payload as ChatEventPayload | undefined;
    if (shouldDebugChat()) {
      console.debug("[chat][event]", {
        hasPayload: Boolean(payload),
        runId: payload?.runId,
        sessionKey: payload?.sessionKey,
        activeSession: host.sessionKey,
        state: payload?.state,
        hasDeltaText: typeof payload?.deltaText === "string",
      });
    }
    noteChatActivity(host as unknown as Parameters<typeof noteChatActivity>[0], payload);
    if (payload?.sessionKey) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    const state = handleChatEvent(host as unknown as OpenClawApp, payload);
    if (state === "final" || state === "error" || state === "aborted") {
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
      const runId = payload?.runId;
      if (runId && host.refreshSessionsAfterChat.has(runId)) {
        host.refreshSessionsAfterChat.delete(runId);
        if (state === "final") {
          void loadSessions(host as unknown as OpenClawApp, {
            activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
          });
        }
      }
    }
    if (state === "final") {
      void loadChatHistory(host as unknown as OpenClawApp);
    }
    (host as unknown as OpenClawApp).requestUpdate();
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "cron" && host.tab === "cron") {
    void loadCron(host as unknown as Parameters<typeof loadCron>[0]);
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as OpenClawApp, { quiet: true });
  }

  if (evt.event === "exec.approval.requested") {
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSnapshot;
        sessionDefaults?: SessionDefaultsSnapshot;
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
}
