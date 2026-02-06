import { html, nothing } from "lit";
import type { GatewayHelloOk } from "../gateway";
import type { SessionsListResult } from "../types";
import type { AgentActivity } from "../activity-hud-state";

type ActivityHudProps = {
  entries: AgentActivity[];
  sessions: SessionsListResult | null;
  hello: GatewayHelloOk | null;
  connected: boolean;
  /** Session keys dismissed from the HUD (local UI only; does not affect sessions). */
  dismissedSessionKeys?: ReadonlySet<string>;
  /** Callback when user dismisses a subagent chip. */
  onDismissSession?: (sessionKey: string) => void;
};

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
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

function resolveLabel(entry: AgentActivity, props: ActivityHudProps): string {
  if (entry.role === "main") {
    return "MIS";
  }
  const row = props.sessions?.sessions?.find((s) => s.key === entry.sessionKey);
  const label = row?.label?.trim();
  if (label) {
    return label;
  }
  const displayName = row?.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return entry.agentId || entry.sessionKey;
}

function formatAgo(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 1000) {
    return "just now";
  }
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function renderHudChip(entry: AgentActivity, props: ActivityHudProps) {
  if (entry.role === "main") {
    return html`
      <div class="activity-main ${entry.active ? "is-active" : ""}" title="Main agent">
        MIS
      </div>
    `;
  }
  const label = resolveLabel(entry, props);
  const truncatedLabel = label.length > 32 ? `${label.slice(0, 29)}…` : label;
  return html`
    <div class="activity-chip ${entry.active ? "is-active" : ""}" title="${label}">
      <span class="activity-chip__dot"></span>
      <span class="activity-chip__label">${truncatedLabel}</span>
      ${props.onDismissSession
        ? html`
            <button
              type="button"
              class="activity-chip__dismiss"
              aria-label="Dismiss from HUD"
              @click=${() => props.onDismissSession?.(entry.sessionKey)}
            >
              ×
            </button>
          `
        : nothing}
    </div>
  `;
}

export function renderAgentActivityHud(props: ActivityHudProps) {
  const mainSessionKey = resolveMainSessionKey(props.hello, props.sessions);
  const main = props.entries.find(
    (item) => item.role === "main" || (mainSessionKey && item.sessionKey === mainSessionKey),
  );
  const dismissed = props.dismissedSessionKeys ?? new Set<string>();
  const subagents = props.entries.filter(
    (item) => item.role === "subagent" && !dismissed.has(item.sessionKey),
  );

  return html`
    <section class="activity-viewer">
      <div class="activity-panel">
        <div class="activity-panel__title">Agent Activity HUD</div>
        <div class="activity-meta">
          <h3>At-a-glance agent activity</h3>
          <p>
            Live telemetry from the gateway chat stream. Main agent stays pinned while subagents
            appear as they emit activity.
          </p>
        </div>

        <div class="activity-hud" aria-label="Agent activity HUD">
          ${main ? renderHudChip(main, props) : nothing}
          <div class="activity-subagents">
            ${subagents.map((item) => renderHudChip(item, props))}
          </div>
        </div>

        ${
          !props.connected
            ? html`<div class="callout">Connect to the gateway to see live activity.</div>`
            : nothing
        }

        <div class="activity-list">
          ${props.entries.length === 0
            ? html`<div class="muted">No agent activity yet.</div>`
            : props.entries.map(
                (item) => html`
                  <div class="activity-row ${item.active ? "is-active" : ""}">
                    <div class="activity-row__label">
                      <strong>${resolveLabel(item, props)}</strong>
                      <span>${item.role === "main" ? "Main agent" : "Subagent"}</span>
                    </div>
                    <div class="activity-row__status">
                      ${item.active ? "Active" : "Idle"} · ${formatAgo(item.lastUpdated)}
                    </div>
                  </div>
                `,
              )}
        </div>
      </div>
    </section>
  `;
}
