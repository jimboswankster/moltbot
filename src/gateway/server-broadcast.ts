import type { GatewayWsClient } from "./server/ws-types.js";
import { recordRuntimeTelemetryEvent } from "../infra/runtime-telemetry.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
};

function hasEventScope(client: GatewayWsClient, event: string): boolean {
  const required = EVENT_SCOPE_GUARDS[event];
  if (!required) {
    return true;
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return false;
  }
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  return required.some((scope) => scopes.includes(scope));
}

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  let seq = 0;
  const broadcast = (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => {
    const eventSeq = ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    const logMeta: Record<string, unknown> = {
      event,
      seq: eventSeq,
      clients: params.clients.size,
      dropIfSlow: opts?.dropIfSlow,
      presenceVersion: opts?.stateVersion?.presence,
      healthVersion: opts?.stateVersion?.health,
    };
    if (event === "agent") {
      Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
    }
    if (event === "chat" && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      logMeta.runId = p.runId;
      logMeta.sessionKey = p.sessionKey;
      logMeta.state = p.state;
    }
    const chatDetails =
      event === "chat" && payload && typeof payload === "object"
        ? (() => {
            const p = payload as Record<string, unknown>;
            return {
              chatRunId: typeof p.runId === "string" ? p.runId : null,
              chatSessionKey: typeof p.sessionKey === "string" ? p.sessionKey : null,
              chatState: typeof p.state === "string" ? p.state : null,
            };
          })()
        : null;
    logWs("out", "event", logMeta);
    for (const c of params.clients) {
      if (!hasEventScope(c, event)) {
        continue;
      }
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) {
        logWs("out", "drop-slow", {
          event,
          seq: eventSeq,
          connId: c.connId,
          buffered: c.socket.bufferedAmount,
          limit: MAX_BUFFERED_BYTES,
        });
        recordRuntimeTelemetryEvent({
          event: "gateway.ws_drop_slow",
          subsystem: "gateway",
          severity: "warning",
          status: "degraded",
          details: {
            connId: c.connId,
            event,
            seq: eventSeq,
            buffered: c.socket.bufferedAmount,
            limit: MAX_BUFFERED_BYTES,
            ...(chatDetails ?? {}),
          },
        });
        continue;
      }
      if (slow) {
        logWs("out", "close-slow", {
          event,
          seq: eventSeq,
          connId: c.connId,
          buffered: c.socket.bufferedAmount,
          limit: MAX_BUFFERED_BYTES,
        });
        recordRuntimeTelemetryEvent({
          event: "gateway.ws_close_slow",
          subsystem: "gateway",
          severity: "warning",
          status: "degraded",
          details: {
            connId: c.connId,
            event,
            seq: eventSeq,
            buffered: c.socket.bufferedAmount,
            limit: MAX_BUFFERED_BYTES,
            ...(chatDetails ?? {}),
          },
        });
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch (err) {
        recordRuntimeTelemetryEvent({
          event: "gateway.ws_send_error",
          subsystem: "gateway",
          severity: "warning",
          status: "degraded",
          details: {
            connId: c.connId,
            event,
            seq: eventSeq,
            message: err instanceof Error ? err.message : String(err),
            ...(chatDetails ?? {}),
          },
        });
      }
    }
  };
  return { broadcast };
}
