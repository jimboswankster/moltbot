import type { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../server-methods/types.js";
import type { GatewayWsClient } from "./ws-types.js";
import { resolveCanvasHostUrl } from "../../infra/canvas-host-url.js";
import { recordRuntimeTelemetryEvent } from "../../infra/runtime-telemetry.js";
import { listSystemPresence, upsertPresence } from "../../infra/system-presence.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { abortChatRunsForConnection } from "../chat-abort.js";
import { isLoopbackAddress } from "../net.js";
import { getHandshakeTimeoutMs } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { classifyGatewayDisconnect } from "../ws-disconnect-classifier.js";
import { logWs } from "../ws-log.js";
import { getHealthVersion, getPresenceVersion, incrementPresenceVersion } from "./health-state.js";
import { attachGatewayWsMessageHandler } from "./ws-connection/message-handler.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;
const WS_SERVER_PING_INTERVAL_MS = 20_000;
const PERIODIC_DISCONNECT_ABORT_GRACE_MS = 120_000;

export function attachGatewayWsConnectionHandler(params: {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  port: number;
  gatewayHost?: string;
  canvasHostEnabled: boolean;
  canvasHostServerPort?: number;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayMethods: string[];
  events: string[];
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
  extraHandlers: GatewayRequestHandlers;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  buildRequestContext: () => GatewayRequestContext;
}) {
  const {
    wss,
    clients,
    port,
    gatewayHost,
    canvasHostEnabled,
    canvasHostServerPort,
    resolvedAuth,
    gatewayMethods,
    events,
    logGateway,
    logHealth,
    logWsControl,
    extraHandlers,
    broadcast,
    buildRequestContext,
  } = params;

  wss.on("connection", (socket, upgradeReq) => {
    let client: GatewayWsClient | null = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();
    const remoteAddr = (socket as WebSocket & { _socket?: { remoteAddress?: string } })._socket
      ?.remoteAddress;
    const headerValue = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
    const requestHost = headerValue(upgradeReq.headers.host);
    const requestPath = typeof upgradeReq.url === "string" ? upgradeReq.url : "/";
    let clientConnId: string | null = null;
    try {
      const requestUrlForParse = new URL(requestPath, `ws://${requestHost ?? "localhost"}`);
      clientConnId = requestUrlForParse.searchParams.get("clientConnId")?.trim() || null;
    } catch {
      clientConnId = null;
    }
    const requestOrigin = headerValue(upgradeReq.headers.origin);
    const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
    const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
    const realIp = headerValue(upgradeReq.headers["x-real-ip"]);

    const canvasHostPortForWs = canvasHostServerPort ?? (canvasHostEnabled ? port : undefined);
    const canvasHostOverride =
      gatewayHost && gatewayHost !== "0.0.0.0" && gatewayHost !== "::" ? gatewayHost : undefined;
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostPortForWs,
      hostOverride: canvasHostServerPort ? canvasHostOverride : undefined,
      requestHost: upgradeReq.headers.host,
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
    });

    logWs("in", "open", { connId, remoteAddr });
    let handshakeState: "pending" | "connected" | "failed" = "pending";
    let closeCause: string | undefined;
    let closeMeta: Record<string, unknown> = {};
    let lastFrameType: string | undefined;
    let lastFrameMethod: string | undefined;
    let lastFrameId: string | undefined;
    let lastFrameAtMs: number | undefined;

    const setCloseCause = (cause: string, meta?: Record<string, unknown>) => {
      if (!closeCause) {
        closeCause = cause;
      }
      if (meta && Object.keys(meta).length > 0) {
        closeMeta = { ...closeMeta, ...meta };
      }
    };

    const setLastFrameMeta = (meta: { type?: string; method?: string; id?: string }) => {
      if (meta.type || meta.method || meta.id) {
        lastFrameType = meta.type ?? lastFrameType;
        lastFrameMethod = meta.method ?? lastFrameMethod;
        lastFrameId = meta.id ?? lastFrameId;
        lastFrameAtMs = Date.now();
      }
    };

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    let pingTimer: NodeJS.Timeout | null = setInterval(() => {
      if (closed) {
        return;
      }
      try {
        // Server-initiated ping keeps intermediary paths from idling out
        // long-lived WS sessions while the browser is background-throttled.
        socket.ping();
      } catch {
        // Best effort only.
      }
    }, WS_SERVER_PING_INTERVAL_MS);
    if (typeof pingTimer.unref === "function") {
      pingTimer.unref();
    }

    const connectNonce = randomUUID();
    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: connectNonce, ts: Date.now() },
    });

    const close = (code = 1000, reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      clearTimeout(handshakeTimer);
      if (client) {
        clients.delete(client);
      }
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", (err) => {
      logWsControl.warn(`error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`);
      recordRuntimeTelemetryEvent({
        event: "gateway.ws_socket_error",
        subsystem: "gateway",
        severity: "warning",
        status: "degraded",
        details: {
          connId,
          clientConnId,
          remoteAddr: remoteAddr || null,
          message: err instanceof Error ? err.message : String(err),
          cause: closeCause || null,
          handshake: handshakeState,
          lastFrameType: lastFrameType || null,
          lastFrameMethod: lastFrameMethod || null,
          lastFrameId: lastFrameId || null,
        },
      });
      close();
    });

    const isNoisySwiftPmHelperClose = (userAgent: string | undefined, remote: string | undefined) =>
      Boolean(
        userAgent?.toLowerCase().includes("swiftpm-testing-helper") && isLoopbackAddress(remote),
      );

    socket.once("close", (code, reason) => {
      const durationMs = Date.now() - openedAt;
      const closeReason = reason?.toString() || "n/a";
      const lastFrameAgeMs =
        typeof lastFrameAtMs === "number" ? Math.max(0, Date.now() - lastFrameAtMs) : null;
      const context = buildRequestContext();
      const activeChatRunsForConn: Array<{
        runId: string;
        sessionId: string;
        sessionKey: string;
        startedAtMs: number;
        ageMs: number;
        expiresAtMs: number;
      }> = [];
      for (const [runId, entry] of context.chatAbortControllers) {
        if (entry.connId !== connId) {
          continue;
        }
        activeChatRunsForConn.push({
          runId,
          sessionId: entry.sessionId,
          sessionKey: entry.sessionKey,
          startedAtMs: entry.startedAtMs,
          ageMs: Math.max(0, Date.now() - entry.startedAtMs),
          expiresAtMs: entry.expiresAtMs,
        });
      }
      const closeContext = {
        cause: closeCause,
        handshake: handshakeState,
        durationMs,
        clientConnId,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        lastFrameAgeMs,
        host: requestHost,
        origin: requestOrigin,
        userAgent: requestUserAgent,
        forwardedFor,
        activeChatRunsForConn: activeChatRunsForConn.length,
        ...closeMeta,
      };
      const disconnectClassification = classifyGatewayDisconnect({
        code: code ?? null,
        handshake: handshakeState,
        durationMs,
        activeChatRunsForConn: activeChatRunsForConn.length,
        lastFrameMethod: lastFrameMethod || null,
        userAgent: requestUserAgent || null,
      });
      if (!client) {
        const logFn = isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr)
          ? logWsControl.debug
          : logWsControl.warn;
        logFn(
          `closed before connect conn=${connId} remote=${remoteAddr ?? "?"} fwd=${forwardedFor ?? "n/a"} origin=${requestOrigin ?? "n/a"} host=${requestHost ?? "n/a"} ua=${requestUserAgent ?? "n/a"} code=${code ?? "n/a"} reason=${closeReason}`,
          closeContext,
        );
        recordRuntimeTelemetryEvent({
          event: "gateway.ws_closed_preconnect",
          subsystem: "gateway",
          severity: "warning",
          status: "degraded",
          details: {
            connId,
            clientConnId,
            code: code ?? null,
            reason: closeReason,
            handshake: handshakeState,
            durationMs,
            cause: closeCause || null,
            remoteAddr: remoteAddr || null,
            forwardedFor: forwardedFor || null,
            requestHost: requestHost || null,
            requestOrigin: requestOrigin || null,
            clientType: "unknown",
          },
        });
      }
      if (client && isWebchatClient(client.connect.client)) {
        logWsControl.info(`webchat disconnected code=${code} reason=${closeReason} conn=${connId}`);
        recordRuntimeTelemetryEvent({
          event: "gateway.ws_disconnect",
          subsystem: "gateway",
          severity: code === 1000 ? "info" : "warning",
          status: code === 1000 ? "ok" : "degraded",
          details: {
            connId,
            clientConnId,
            code: code ?? null,
            reason: closeReason,
            requestPath,
            requestOrigin: requestOrigin || null,
            userAgent: requestUserAgent || null,
            handshake: handshakeState,
            durationMs,
            cause: closeCause || null,
            lastFrameType: lastFrameType || null,
            lastFrameMethod: lastFrameMethod || null,
            lastFrameId: lastFrameId || null,
            lastFrameAgeMs,
            clientType: "webchat",
            clientId: client.connect?.client?.id || null,
            clientMode: client.connect?.client?.mode || null,
            clientVersion: client.connect?.client?.version || null,
            clientPlatform: client.connect?.client?.platform || null,
            clientInstanceId: client.connect?.client?.instanceId || null,
            activeChatRunsForConn: activeChatRunsForConn.length,
            activeChatRunIds: activeChatRunsForConn.map((entry) => entry.runId),
            activeChatRuns: activeChatRunsForConn.slice(0, 10).map((entry) => ({
              runId: entry.runId,
              sessionId: entry.sessionId,
              sessionKey: entry.sessionKey,
              ageMs: entry.ageMs,
              startedAtMs: entry.startedAtMs,
              expiresAtMs: entry.expiresAtMs,
            })),
            disconnectClassification,
          },
        });
        if (disconnectClassification !== "normal_or_expected") {
          const isRunImpactingDisconnect =
            disconnectClassification === "abnormal_periodic_client_churn_with_active_runs" ||
            activeChatRunsForConn.length > 0;
          recordRuntimeTelemetryEvent({
            event: "gateway.ws_disconnect_classified",
            subsystem: "gateway",
            // Idle periodic churn is expected for some browser/edge paths and should
            // not page like true stream instability.
            severity: isRunImpactingDisconnect ? "warning" : "info",
            status: isRunImpactingDisconnect ? "degraded" : "ok",
            details: {
              connId,
              clientConnId,
              code: code ?? null,
              reason: closeReason,
              requestPath,
              requestOrigin: requestOrigin || null,
              userAgent: requestUserAgent || null,
              durationMs,
              lastFrameMethod: lastFrameMethod || null,
              activeChatRunsForConn: activeChatRunsForConn.length,
              classification: disconnectClassification,
            },
          });
        }
        if (!clientConnId) {
          recordRuntimeTelemetryEvent({
            event: "gateway.ws_disconnect_missing_client_conn_id",
            subsystem: "gateway",
            severity: "warning",
            status: "degraded",
            details: {
              connId,
              code: code ?? null,
              reason: closeReason,
              requestPath,
              requestHost: requestHost || null,
              requestOrigin: requestOrigin || null,
              userAgent: requestUserAgent || null,
            },
          });
        }
        // If an abnormal disconnect happens while runs are in flight, defer
        // abort for periodic churn to avoid terminating long-running work due
        // to known client-facing websocket rotation behavior.
        if (code !== 1000 && activeChatRunsForConn.length > 0) {
          let skipAbortForWebchat = false;
          // Webchat transport can churn independently of run execution.
          // Do not hard-abort in-flight runs on disconnect; let run-level
          // timeout/cancellation semantics decide terminal state.
          if (client?.connect?.client?.mode === "webchat") {
            skipAbortForWebchat = true;
            recordRuntimeTelemetryEvent({
              event: "gateway.ws_disconnect_run_abort_skipped_webchat",
              subsystem: "gateway",
              severity: "warning",
              status: "degraded",
              details: {
                connId,
                clientConnId,
                code: code ?? null,
                reason: closeReason,
                classification: disconnectClassification,
                activeChatRunsForConn: activeChatRunsForConn.length,
                activeChatRunIds: activeChatRunsForConn.map((entry) => entry.runId),
              },
            });
          }
          if (!skipAbortForWebchat) {
            const abortOps = {
              chatAbortControllers: context.chatAbortControllers,
              chatRunBuffers: context.chatRunBuffers,
              chatDeltaSentAt: context.chatDeltaSentAt,
              chatAbortedRuns: context.chatAbortedRuns,
              removeChatRun: context.removeChatRun,
              agentRunSeq: context.agentRunSeq,
              broadcast,
              nodeSendToSession: context.nodeSendToSession,
            };
            if (disconnectClassification === "abnormal_periodic_client_churn_with_active_runs") {
              recordRuntimeTelemetryEvent({
                event: "gateway.ws_disconnect_run_abort_deferred",
                subsystem: "gateway",
                severity: "warning",
                status: "degraded",
                details: {
                  connId,
                  clientConnId,
                  code: code ?? null,
                  reason: closeReason,
                  graceMs: PERIODIC_DISCONNECT_ABORT_GRACE_MS,
                  activeChatRunsForConn: activeChatRunsForConn.length,
                  activeChatRunIds: activeChatRunsForConn.map((entry) => entry.runId),
                  classification: disconnectClassification,
                },
              });
              const deferredAbortTimer = setTimeout(() => {
                const aborted = abortChatRunsForConnection(abortOps, {
                  connId,
                  stopReason: "disconnect_grace_expired",
                });
                recordRuntimeTelemetryEvent({
                  event: "gateway.ws_disconnect_run_abort_deferred_result",
                  subsystem: "gateway",
                  severity: aborted.aborted ? "warning" : "info",
                  status: aborted.aborted ? "degraded" : "ok",
                  details: {
                    connId,
                    clientConnId,
                    aborted: aborted.aborted,
                    abortedRunCount: aborted.runIds.length,
                    abortedRunIds: aborted.runIds,
                    sessionKeys: aborted.sessionKeys,
                    graceMs: PERIODIC_DISCONNECT_ABORT_GRACE_MS,
                  },
                });
              }, PERIODIC_DISCONNECT_ABORT_GRACE_MS);
              if (typeof deferredAbortTimer.unref === "function") {
                deferredAbortTimer.unref();
              }
            } else {
              const aborted = abortChatRunsForConnection(abortOps, {
                connId,
                stopReason: "disconnect",
              });
              recordRuntimeTelemetryEvent({
                event: "gateway.ws_disconnect_run_abort",
                subsystem: "gateway",
                severity: aborted.aborted ? "warning" : "info",
                status: aborted.aborted ? "degraded" : "ok",
                details: {
                  connId,
                  clientConnId,
                  code: code ?? null,
                  reason: closeReason,
                  aborted: aborted.aborted,
                  abortedRunCount: aborted.runIds.length,
                  abortedRunIds: aborted.runIds,
                  sessionKeys: aborted.sessionKeys,
                },
              });
            }
          }
        }
      }
      if (client?.presenceKey) {
        upsertPresence(client.presenceKey, { reason: "disconnect" });
        incrementPresenceVersion();
        broadcast(
          "presence",
          { presence: listSystemPresence() },
          {
            dropIfSlow: true,
            stateVersion: {
              presence: getPresenceVersion(),
              health: getHealthVersion(),
            },
          },
        );
      }
      if (client?.connect?.role === "node") {
        const nodeId = context.nodeRegistry.unregister(connId);
        if (nodeId) {
          context.nodeUnsubscribeAll(nodeId);
        }
      }
      logWs("out", "close", {
        connId,
        code,
        reason: reason?.toString(),
        durationMs,
        cause: closeCause,
        handshake: handshakeState,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
      });
      close();
    });

    const handshakeTimeoutMs = getHandshakeTimeoutMs();
    const handshakeTimer = setTimeout(() => {
      if (!client) {
        handshakeState = "failed";
        setCloseCause("handshake-timeout", {
          handshakeMs: Date.now() - openedAt,
        });
        logWsControl.warn(`handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`);
        close();
      }
    }, handshakeTimeoutMs);

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq,
      connId,
      remoteAddr,
      forwardedFor,
      realIp,
      requestHost,
      requestOrigin,
      requestUserAgent,
      canvasHostUrl,
      connectNonce,
      resolvedAuth,
      gatewayMethods,
      events,
      extraHandlers,
      buildRequestContext,
      send,
      close,
      isClosed: () => closed,
      clearHandshakeTimer: () => clearTimeout(handshakeTimer),
      getClient: () => client,
      setClient: (next) => {
        client = next;
        clients.add(next);
      },
      setHandshakeState: (next) => {
        handshakeState = next;
      },
      setCloseCause,
      setLastFrameMeta,
      logGateway,
      logHealth,
      logWsControl,
    });
  });
}
