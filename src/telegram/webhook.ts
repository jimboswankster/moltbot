import { webhookCallback } from "grammy";
import { createServer } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  acquireTelegramIngressPolicyLease,
  loadTelegramIngressPolicyAdapter,
  type LoadedTelegramIngressPolicy,
} from "../infra/telegram-ingress-policy-adapter.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { defaultRuntime } from "../runtime.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";

// ── Webhook health check ────────────────────────────────────────────────────

const WEBHOOK_HEALTH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WEBHOOK_PENDING_WARN_THRESHOLD = 100;

type WebhookHealthContext = {
  bot: ReturnType<typeof createTelegramBot>;
  expectedUrl: string;
  runtime: RuntimeEnv;
  timer: ReturnType<typeof setInterval> | null;
};

async function runWebhookHealthCheck(ctx: WebhookHealthContext): Promise<void> {
  try {
    const info = await ctx.bot.api.getWebhookInfo();
    const now = Date.now();

    // Check pending update backlog
    if (
      typeof info.pending_update_count === "number" &&
      info.pending_update_count > WEBHOOK_PENDING_WARN_THRESHOLD
    ) {
      console.warn(
        `[telegram-webhook-health] HIGH pending_update_count: ${info.pending_update_count} (threshold: ${WEBHOOK_PENDING_WARN_THRESHOLD})`,
      );
    }

    // Check recent errors from Telegram
    if (info.last_error_date) {
      const errorAgeMs = now - info.last_error_date * 1000;
      if (errorAgeMs < WEBHOOK_HEALTH_INTERVAL_MS) {
        console.warn(
          `[telegram-webhook-health] recent delivery error (${Math.round(errorAgeMs / 1000)}s ago): ${info.last_error_message ?? "unknown"}`,
        );
      }
    }

    // Check URL mismatch (indicates external override or stale registration)
    if (info.url && info.url !== ctx.expectedUrl) {
      console.error(
        `[telegram-webhook-health] URL MISMATCH: expected=${ctx.expectedUrl} actual=${info.url}`,
      );
    }
  } catch (err) {
    console.error(`[telegram-webhook-health] health check failed: ${String(err)}`);
  }
}

function startWebhookHealthCheck(ctx: WebhookHealthContext): void {
  ctx.timer = setInterval(() => {
    void runWebhookHealthCheck(ctx);
  }, WEBHOOK_HEALTH_INTERVAL_MS);
  // Run once immediately after a short delay (let startup settle)
  setTimeout(() => void runWebhookHealthCheck(ctx), 10_000);
}

function stopWebhookHealthCheck(ctx: WebhookHealthContext): void {
  if (ctx.timer) {
    clearInterval(ctx.timer);
    ctx.timer = null;
  }
}

// ── Webhook server ──────────────────────────────────────────────────────────

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
  ingressPolicy?: LoadedTelegramIngressPolicy | null;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const runtime = opts.runtime ?? defaultRuntime;
  const ingressPolicy = opts.ingressPolicy === undefined
    ? await loadTelegramIngressPolicyAdapter(opts.config, {
        debug: runtime.log,
        warn: runtime.error,
      })
    : opts.ingressPolicy;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });
  const handler = webhookCallback(bot, "http", {
    secretToken: opts.secret,
  });

  const server = createServer((req, res) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }
    const handled = handler(req, res);
    if (handled && typeof handled.catch === "function") {
      void handled
        .then(() => {
          if (diagnosticsEnabled) {
            logWebhookProcessed({
              channel: "telegram",
              updateType: "telegram-post",
              durationMs: Date.now() - startTime,
            });
          }
        })
        .catch((err) => {
          const errMsg = formatErrorMessage(err);
          if (diagnosticsEnabled) {
            logWebhookError({
              channel: "telegram",
              updateType: "telegram-post",
              error: errMsg,
            });
          }
          runtime.log?.(`webhook handler failed: ${errMsg}`);
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        });
    }
  });

  // Claim shared ingress immediately before webhook registration makes this
  // process externally authoritative.
  const ingressLease = await acquireTelegramIngressPolicyLease({
    loaded: ingressPolicy,
    accountId: opts.accountId?.trim() || "default",
    mode: "webhook",
  });

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  // Phase 3d: handle HTTP server-level errors (EADDRINUSE, crashes, etc.)
  server.on("error", (err) => {
    console.error(`[telegram-webhook] HTTP server error: ${String(err)}`);
  });

  const publicUrl =
    opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;

  // Phase 3a: fail startup if webhook registration fails
  try {
    await withTelegramApiErrorLogging({
      operation: "setWebhook",
      runtime,
      fn: () =>
        bot.api.setWebhook(publicUrl, {
          secret_token: opts.secret,
          allowed_updates: resolveTelegramAllowedUpdates(),
        }),
    });
  } catch (err) {
    console.error(`[telegram-webhook] FATAL: webhook registration failed: ${String(err)}`);
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
    await ingressLease?.release().catch(() => undefined);
    throw new Error(`Telegram webhook registration failed: ${String(err)}`, { cause: err });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (error: Error) => reject(error);
      server.once("error", onStartupError);
      server.listen(port, host, () => {
        server.off("error", onStartupError);
        resolve();
      });
    });
  } catch (err) {
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
    await ingressLease?.release().catch(() => undefined);
    throw new Error(`Telegram webhook listener failed: ${String(err)}`, { cause: err });
  }
  runtime.log?.(`webhook listening on ${publicUrl}`);

  // Phase 3b: periodic webhook health check
  const healthCtx: WebhookHealthContext = { bot, expectedUrl: publicUrl, runtime, timer: null };
  startWebhookHealthCheck(healthCtx);

  // Phase 3c: graceful shutdown with request draining
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWebhookHealthCheck(healthCtx);

    // Stop accepting new connections
    server.close();

    // Wait for in-flight requests to complete (max 10s)
    await Promise.race([
      new Promise<void>((resolve) => server.on("close", resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);

    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
    await ingressLease?.release().catch(() => undefined);
  };
  if (ingressLease?.lost) {
    void ingressLease.lost.catch(async (error) => {
      runtime.error?.(`telegram ingress lease lost: ${formatErrorMessage(error)}`);
      await shutdown();
    });
  }
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener(
      "abort",
      () => {
        void shutdown();
      },
      { once: true },
    );
  }

  return { server, bot, stop: shutdown };
}
