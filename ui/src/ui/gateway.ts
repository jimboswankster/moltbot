import { buildDeviceAuthPayload } from "../../../src/gateway/device-auth.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../src/gateway/protocol/client-info.js";
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./device-identity";
import { generateUUID } from "./uuid";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type GatewayBrowserClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: { code: number; reason: string }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;

// Requests queued while the socket is disconnected. They are replayed after
// the next successful hello-ok, or rejected after QUEUE_TIMEOUT_MS.
type QueuedRequest = {
  frame: string;
  id: string;
  resolve: (v: unknown) => void;
  reject: (err: unknown) => void;
  timer: number;
};

const QUEUE_TIMEOUT_MS = 15_000;
const MAX_QUEUED = 20;
const KEEPALIVE_INTERVAL_MS = 20_000;
const KEEPALIVE_TIMEOUT_MS = 15_000;
const MAX_KEEPALIVE_TIMEOUTS_BEFORE_CLOSE = 4;
const KEEPALIVE_MIN_SILENCE_BEFORE_CLOSE_MS = 120_000;
const CLIENT_WS_TELEMETRY_ENDPOINT = "/api/telemetry/client-ws-event";

type ClientWsLifecycleEvent = "visibilitychange" | "online" | "offline" | "pagehide" | "freeze";

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private queued: QueuedRequest[] = [];
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: number | null = null;
  private backoffMs = 800;
  private keepaliveTimer: number | null = null;
  private keepaliveInFlight = false;
  private consecutiveKeepaliveTimeouts = 0;
  private readonly clientConnId = generateUUID();
  private lastMessageAtMs: number | null = null;
  private wsOpenedAtMs: number | null = null;
  private reconnectAttempts = 0;
  private lifecycleHandlersInstalled = false;
  private readonly onVisibilityChange = () => this.emitLifecycleTelemetry("visibilitychange");
  private readonly onOnline = () => this.emitLifecycleTelemetry("online");
  private readonly onOffline = () => this.emitLifecycleTelemetry("offline");
  private readonly onPageHide = () => this.emitLifecycleTelemetry("pagehide");
  private readonly onFreeze = () => this.emitLifecycleTelemetry("freeze");

  constructor(private opts: GatewayBrowserClientOptions) {}

  start() {
    this.closed = false;
    this.installLifecycleHandlers();
    this.connect();
  }

  stop() {
    this.closed = true;
    this.removeLifecycleHandlers();
    this.stopKeepalive();
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("gateway client stopped"));
    // Also reject queued requests on permanent stop
    for (const q of this.queued.splice(0)) {
      window.clearTimeout(q.timer);
      q.reject(new Error("gateway client stopped"));
    }
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) {
      return;
    }
    const wsUrl = this.resolveWsUrl();
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("open", () => {
      this.wsOpenedAtMs = Date.now();
      this.emitClientWsTelemetry("ui.ws_open", {
        wsUrl,
        clientConnId: this.clientConnId,
        reconnectAttempts: this.reconnectAttempts,
      });
      this.queueConnect();
    });
    this.ws.addEventListener("message", (ev) => this.handleMessage(String(ev.data ?? "")));
    this.ws.addEventListener("close", (ev) => {
      const reason = String(ev.reason ?? "");
      const now = Date.now();
      this.stopKeepalive();
      this.ws = null;
      this.emitClientWsTelemetry("ui.ws_close", {
        clientConnId: this.clientConnId,
        code: ev.code,
        reason,
        wasClean: ev.wasClean,
        sessionAgeMs: this.wsOpenedAtMs != null ? Math.max(0, now - this.wsOpenedAtMs) : null,
        online: typeof navigator !== "undefined" ? navigator.onLine : null,
        visibilityState:
          typeof document !== "undefined" ? document.visibilityState : null,
        sinceLastMessageMs:
          this.lastMessageAtMs != null ? Math.max(0, now - this.lastMessageAtMs) : null,
        appClosed: this.closed,
      });
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason });
      this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // ignored; close handler will fire
    });
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    this.emitClientWsTelemetry("ui.ws_reconnect_scheduled", {
      clientConnId: this.clientConnId,
      delayMs: delay,
      reconnectAttempts: this.reconnectAttempts,
    });
    window.setTimeout(() => this.connect(), delay);
  }

  private resolveWsUrl() {
    try {
      const parsed = new URL(this.opts.url);
      parsed.searchParams.set("clientConnId", this.clientConnId);
      return parsed.toString();
    } catch {
      const sep = this.opts.url.includes("?") ? "&" : "?";
      return `${this.opts.url}${sep}clientConnId=${encodeURIComponent(this.clientConnId)}`;
    }
  }

  private emitClientWsTelemetry(event: string, details: Record<string, unknown>) {
    const payload = {
      event,
      subsystem: "second-brain-ui-ws",
      severity: "info",
      status: "ok",
      details: {
        ...details,
        tsMs: Date.now(),
      },
    };
    // Preferred path: send telemetry over the already-established gateway socket.
    // Keep HTTP as best-effort fallback for pre-connect / post-close lifecycle events.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed) {
      void this.request("telemetry.client_ws_event", payload).catch(() => {
        // Fall through to HTTP fallback.
      });
    }
    try {
      void fetch(CLIENT_WS_TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch {
      // Best-effort telemetry only.
    }
  }

  private emitLifecycleTelemetry(kind: ClientWsLifecycleEvent) {
    this.emitClientWsTelemetry("ui.ws_lifecycle", {
      clientConnId: this.clientConnId,
      kind,
      online: typeof navigator !== "undefined" ? navigator.onLine : null,
      visibilityState: typeof document !== "undefined" ? document.visibilityState : null,
    });
  }

  private installLifecycleHandlers() {
    if (this.lifecycleHandlersInstalled || typeof window === "undefined") {
      return;
    }
    this.lifecycleHandlersInstalled = true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      document.addEventListener("freeze", this.onFreeze as EventListener);
    }
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("pagehide", this.onPageHide);
  }

  private removeLifecycleHandlers() {
    if (!this.lifecycleHandlersInstalled || typeof window === "undefined") {
      return;
    }
    this.lifecycleHandlersInstalled = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      document.removeEventListener("freeze", this.onFreeze as EventListener);
    }
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    window.removeEventListener("pagehide", this.onPageHide);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private async sendConnect() {
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    // Gateways may reject this unless gateway.controlUi.allowInsecureAuth is enabled.
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;

    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
    const role = "operator";
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let canFallbackToShared = false;
    let authToken = this.opts.token;

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      const storedToken = loadDeviceAuthToken({
        deviceId: deviceIdentity.deviceId,
        role,
      })?.token;
      authToken = storedToken ?? this.opts.token;
      canFallbackToShared = Boolean(storedToken && this.opts.token);
    }
    const auth =
      authToken || this.opts.password
        ? {
            token: authToken,
            password: this.opts.password,
          }
        : undefined;

    let device:
      | {
          id: string;
          publicKey: string;
          signature: string;
          signedAt: number;
          nonce: string | undefined;
        }
      | undefined;

    if (isSecureContext && deviceIdentity) {
      const signedAtMs = Date.now();
      const nonce = this.connectNonce ?? undefined;
      const payload = buildDeviceAuthPayload({
        deviceId: deviceIdentity.deviceId,
        clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
        clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
      });
      const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
      device = {
        id: deviceIdentity.deviceId,
        publicKey: deviceIdentity.publicKey,
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: this.opts.clientVersion ?? "dev",
        platform: this.opts.platform ?? navigator.platform ?? "web",
        mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
        instanceId: this.opts.instanceId,
      },
      role,
      scopes,
      device,
      caps: [],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    void this.request<GatewayHelloOk>("connect", params)
      .then((hello) => {
        if (hello?.auth?.deviceToken && deviceIdentity) {
          storeDeviceAuthToken({
            deviceId: deviceIdentity.deviceId,
            role: hello.auth.role ?? role,
            token: hello.auth.deviceToken,
            scopes: hello.auth.scopes ?? [],
          });
        }
        this.backoffMs = 800;
        this.reconnectAttempts = 0;
        this.startKeepalive();
        this.flushQueued();
        this.opts.onHello?.(hello);
      })
      .catch(() => {
        if (canFallbackToShared && deviceIdentity) {
          clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
        }
        this.ws?.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
      });
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    this.lastMessageAtMs = Date.now();

    const frame = parsed as { type?: unknown };
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(new Error(res.error?.message ?? "request failed"));
      }
      return;
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = generateUUID();
    const frameObj = { type: "req", id, method, params };
    const frameStr = JSON.stringify(frameObj);

    // If connected, send immediately
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const p = new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      });
      this.ws.send(frameStr);
      return p;
    }

    // If closed permanently, reject
    if (this.closed) {
      return Promise.reject(new Error("gateway not connected"));
    }

    // Queue for replay after reconnect (up to MAX_QUEUED with timeout)
    if (this.queued.length >= MAX_QUEUED) {
      return Promise.reject(new Error("gateway reconnect queue full"));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.queued = this.queued.filter((q) => q.id !== id);
        reject(new Error("gateway reconnect timeout"));
      }, QUEUE_TIMEOUT_MS);
      this.queued.push({
        frame: frameStr,
        id,
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
    });
  }

  /** Replay queued requests after successful reconnect. */
  private flushQueued() {
    const toSend = this.queued.splice(0);
    for (const q of toSend) {
      window.clearTimeout(q.timer);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.pending.set(q.id, { resolve: q.resolve, reject: q.reject });
        this.ws.send(q.frame);
      } else {
        q.reject(new Error("gateway not connected after reconnect"));
      }
    }
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
    }
    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect();
    }, 750);
  }

  private startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = window.setInterval(() => {
      if (this.keepaliveInFlight) {
        return;
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) {
        return;
      }
      this.keepaliveInFlight = true;
      const startedAtMs = Date.now();
      this.emitClientWsTelemetry("ui.ws_keepalive_sent", {
        clientConnId: this.clientConnId,
      });
      const timeout = window.setTimeout(() => {
        this.keepaliveInFlight = false;
        this.consecutiveKeepaliveTimeouts += 1;
        this.emitClientWsTelemetry("ui.ws_keepalive_timeout", {
          clientConnId: this.clientConnId,
          timeoutMs: KEEPALIVE_TIMEOUT_MS,
          consecutiveTimeouts: this.consecutiveKeepaliveTimeouts,
        });
        if (
          this.ws &&
          this.ws.readyState === WebSocket.OPEN &&
          this.consecutiveKeepaliveTimeouts >= MAX_KEEPALIVE_TIMEOUTS_BEFORE_CLOSE
        ) {
          const nowMs = Date.now();
          const sinceLastMessageMs =
            this.lastMessageAtMs != null ? Math.max(0, nowMs - this.lastMessageAtMs) : null;
          if (
            sinceLastMessageMs != null &&
            sinceLastMessageMs < KEEPALIVE_MIN_SILENCE_BEFORE_CLOSE_MS
          ) {
            this.emitClientWsTelemetry("ui.ws_keepalive_close_suppressed_recent_activity", {
              clientConnId: this.clientConnId,
              consecutiveTimeouts: this.consecutiveKeepaliveTimeouts,
              threshold: MAX_KEEPALIVE_TIMEOUTS_BEFORE_CLOSE,
              sinceLastMessageMs,
              minSilenceMs: KEEPALIVE_MIN_SILENCE_BEFORE_CLOSE_MS,
            });
            return;
          }
          const online = typeof navigator !== "undefined" ? navigator.onLine : true;
          const visibilityState =
            typeof document !== "undefined" ? document.visibilityState : "visible";
          const shouldDeferClose = !online || visibilityState !== "visible";
          if (shouldDeferClose) {
            this.emitClientWsTelemetry("ui.ws_keepalive_close_deferred", {
              clientConnId: this.clientConnId,
              consecutiveTimeouts: this.consecutiveKeepaliveTimeouts,
              threshold: MAX_KEEPALIVE_TIMEOUTS_BEFORE_CLOSE,
              online,
              visibilityState,
            });
            return;
          }
          this.emitClientWsTelemetry("ui.ws_keepalive_close_triggered", {
            clientConnId: this.clientConnId,
            consecutiveTimeouts: this.consecutiveKeepaliveTimeouts,
            threshold: MAX_KEEPALIVE_TIMEOUTS_BEFORE_CLOSE,
          });
          this.ws.close(4000, "keepalive timeout");
        }
      }, KEEPALIVE_TIMEOUT_MS);

      void this.request("agent.identity.get", {})
        .then(() => {
          window.clearTimeout(timeout);
          this.keepaliveInFlight = false;
          this.consecutiveKeepaliveTimeouts = 0;
          this.emitClientWsTelemetry("ui.ws_keepalive_ok", {
            clientConnId: this.clientConnId,
            latencyMs: Math.max(0, Date.now() - startedAtMs),
          });
        })
        .catch((err) => {
          window.clearTimeout(timeout);
          this.keepaliveInFlight = false;
          this.emitClientWsTelemetry("ui.ws_keepalive_error", {
            clientConnId: this.clientConnId,
            latencyMs: Math.max(0, Date.now() - startedAtMs),
            message: err instanceof Error ? err.message : String(err),
          });
        });
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer !== null) {
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.keepaliveInFlight = false;
    this.consecutiveKeepaliveTimeouts = 0;
  }
}
