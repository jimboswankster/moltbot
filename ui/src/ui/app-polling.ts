import type { OpenClawApp } from "./app";
import { syncSubagentsFromSessionsList } from "./activity-hud-state";
import { loadDebug } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";
import { loadNodes } from "./controllers/nodes";
import { loadSessions } from "./controllers/sessions";

const ACTIVITY_HUD_SESSIONS_POLL_MS = 4000;

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  activityHudSessionsPollInterval: number | null;
  tab: string;
};

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = window.setInterval(
    () => void loadNodes(host as unknown as OpenClawApp, { quiet: true }),
    5000,
  );
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") {
      return;
    }
    void loadLogs(host as unknown as OpenClawApp, { quiet: true });
  }, 2000);
}

export function stopLogsPolling(host: PollingHost) {
  if (host.logsPollInterval == null) {
    return;
  }
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") {
      return;
    }
    void loadDebug(host as unknown as OpenClawApp);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}

export function startActivityHudSessionsPolling(host: PollingHost) {
  if (host.activityHudSessionsPollInterval != null) {
    return;
  }
  if (host.tab !== "activity-hud") {
    return;
  }
  host.activityHudSessionsPollInterval = window.setInterval(async () => {
    const app = host as unknown as OpenClawApp;
    if (app.tab !== "activity-hud" || !app.connected || !app.client) {
      return;
    }
    await loadSessions(app, { limit: 50, activeMinutes: 60 });
    syncSubagentsFromSessionsList(
      app as unknown as Parameters<typeof syncSubagentsFromSessionsList>[0],
    );
    app.requestUpdate();
  }, ACTIVITY_HUD_SESSIONS_POLL_MS);
}

export function stopActivityHudSessionsPolling(host: PollingHost) {
  if (host.activityHudSessionsPollInterval == null) {
    return;
  }
  clearInterval(host.activityHudSessionsPollInterval);
  host.activityHudSessionsPollInterval = null;
}
