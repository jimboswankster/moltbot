import type { OpenClawApp } from "./app";
import type { Tab } from "./navigation";
import { syncSubagentsFromSessionsList } from "./activity-hud-state";
import { connectGateway } from "./app-gateway";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
  startActivityHudSessionsPolling,
  stopActivityHudSessionsPolling,
} from "./app-polling";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll";
import {
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings";
import { loadSessions } from "./controllers/sessions";

type LifecycleHost = {
  basePath: string;
  tab: Tab;
  chatHasAutoScrolled: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string;
  loadSlashCommands: () => void | Promise<void>;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  startActivityTicker: () => void;
  stopActivityTicker: () => void;
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
};

export function handleConnected(host: LifecycleHost) {
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
  window.addEventListener("popstate", host.popStateHandler);
  void host.loadSlashCommands();
  host.startActivityTicker();
  connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
  if (host.tab === "activity-hud") {
    startActivityHudSessionsPolling(
      host as unknown as Parameters<typeof startActivityHudSessionsPolling>[0],
    );
  }
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  stopActivityHudSessionsPolling(
    host as unknown as Parameters<typeof stopActivityHudSessionsPolling>[0],
  );
  host.stopActivityTicker();
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
  if (changed.has("tab")) {
    if (host.tab === "activity-hud") {
      const app = host as unknown as OpenClawApp;
      startActivityHudSessionsPolling(app);
      if (app.connected && app.client) {
        void loadSessions(app, { limit: 50, activeMinutes: 60 }).then(() => {
          syncSubagentsFromSessionsList(
            app as unknown as Parameters<typeof syncSubagentsFromSessionsList>[0],
          );
          app.requestUpdate();
        });
      }
    } else {
      stopActivityHudSessionsPolling(
        host as unknown as Parameters<typeof stopActivityHudSessionsPolling>[0],
      );
    }
  }
}
