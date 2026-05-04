import { type RunOptions, run } from "@grammyjs/runner";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationMs } from "../infra/format-duration.js";
import { recordRuntimeTelemetryEvent } from "../infra/runtime-telemetry.js";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { createTelegramBot } from "./bot.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
  env?: NodeJS.ProcessEnv;
};

export function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Increased from grammY default (30s) to reduce spurious timeout-restart
        // cycles on slow networks. Telegram supports up to 50s for long-polling.
        timeout: 45,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Retry transient failures for a limited window before surfacing errors.
      maxRetryTime: 5 * 60 * 1000,
      retryInterval: "exponential",
    },
  };
}

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};
const activeTelegramPollers = new Set<string>();

type TelegramPollerLockHandle = {
  release: () => Promise<void>;
};
const DEFAULT_TELEGRAM_POLLER_LOCK_STALE_MS = 10 * 60 * 1000;
type TelegramPollerLockPayload = {
  pid?: number;
  accountId?: string;
  createdAt?: string;
};

function normalizeTelegramAccountForLock(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeTelemetryPathForPreflight(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_RUNTIME_TELEMETRY_FILE?.trim();
  if (configured) {
    return configured;
  }
  const home = env.HOME || "/Users/basecamp";
  return path.join(home, ".openclaw", "logs", "runtime-telemetry.jsonl");
}

async function ensureTelegramMonitorPermissionPreflight(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const stateDir = resolveStateDir(params.env);
  const normalized = normalizeTelegramAccountForLock(params.accountId);
  const lockPath = path.join(stateDir, "telegram", `poller-${normalized}.lock`);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const telemetryPath = resolveRuntimeTelemetryPathForPreflight(params.env);
  await fs.mkdir(path.dirname(telemetryPath), { recursive: true, mode: 0o700 });
}

async function acquireTelegramPollerLock(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
  onConflict?: (details: {
    accountId: string;
    ownerPid: number | null;
    ownerCreatedAt: string | null;
  }) => void;
}): Promise<TelegramPollerLockHandle> {
  const stateDir = resolveStateDir(params.env);
  const normalized = normalizeTelegramAccountForLock(params.accountId);
  const lockPath = path.join(stateDir, "telegram", `poller-${normalized}.lock`);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      const staleMsRaw = params.env?.OPENCLAW_TELEGRAM_POLLER_LOCK_STALE_MS?.trim();
      const staleMs = Number.isFinite(Number(staleMsRaw))
        ? Number(staleMsRaw)
        : DEFAULT_TELEGRAM_POLLER_LOCK_STALE_MS;
      let owner: TelegramPollerLockPayload | null = null;
      let stale = false;
      try {
        const existingRaw = await fs.readFile(lockPath, "utf8");
        const parsed = JSON.parse(existingRaw) as TelegramPollerLockPayload;
        owner = parsed;
        if (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) {
          stale = true;
        }
        const createdAt = parsed.createdAt ? Date.parse(parsed.createdAt) : Number.NaN;
        if (Number.isFinite(createdAt) && Date.now() - createdAt > staleMs) {
          stale = true;
        }
      } catch {
        // Fall back to mtime check below.
      }
      if (!stale) {
        try {
          const st = await fs.stat(lockPath);
          stale = Date.now() - st.mtimeMs > staleMs;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        recordRuntimeTelemetryEvent({
          event: "telegram.poller_lock_reclaimed",
          subsystem: "telegram-monitor",
          severity: "info",
          status: "ok",
          details: {
            accountId: params.accountId,
            mode: "polling",
            reason: typeof owner?.pid === "number" && !isPidAlive(owner.pid) ? "dead_pid" : "stale",
            ownerPid: typeof owner?.pid === "number" ? owner.pid : null,
            ownerCreatedAt: typeof owner?.createdAt === "string" ? owner.createdAt : null,
          },
        });
        await fs.rm(lockPath, { force: true });
        return acquireTelegramPollerLock(params);
      }
      const ownerPid = typeof owner?.pid === "number" ? owner.pid : null;
      const ownerCreatedAt = typeof owner?.createdAt === "string" ? owner.createdAt : null;
      params.onConflict?.({
        accountId: params.accountId,
        ownerPid,
        ownerCreatedAt,
      });
      recordRuntimeTelemetryEvent({
        event: "telegram.poller_lock_preflight_checked",
        subsystem: "telegram-monitor",
        severity: "warning",
        status: "degraded",
        details: {
          accountId: params.accountId,
          mode: "polling",
          result: "conflict",
          ownerPid,
          ownerCreatedAt,
        },
      });
      recordRuntimeTelemetryEvent({
        event: "telegram.poller_lock_conflict",
        subsystem: "telegram-monitor",
        severity: "warning",
        status: "degraded",
        details: {
          accountId: params.accountId,
          mode: "polling",
          ownerPid,
          ownerCreatedAt,
        },
      });
      const ownerSuffix =
        ownerPid || ownerCreatedAt
          ? ` (ownerPid=${ownerPid ?? "unknown"} ownerCreatedAt=${ownerCreatedAt ?? "unknown"})`
          : "";
      throw new Error(
        `telegram poller lock already held for account=${params.accountId}${ownerSuffix}`,
      );
    }
    throw err;
  }

  await handle.writeFile(
    JSON.stringify({
      pid: process.pid,
      accountId: params.accountId,
      createdAt: new Date().toISOString(),
    }),
    "utf8",
  );
  recordRuntimeTelemetryEvent({
    event: "telegram.poller_lock_preflight_checked",
    subsystem: "telegram-monitor",
    severity: "info",
    status: "ok",
    details: {
      accountId: params.accountId,
      mode: "polling",
      result: "acquired",
      ownerPid: process.pid,
    },
  });

  return {
    release: async () => {
      await handle.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true });
    },
  };
}

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { name?: string }).name === "HttpError";
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const log = opts.runtime?.error ?? console.error;
  const info = opts.runtime?.log ?? console.log;

  // Register handler for Grammy HttpError unhandled rejections.
  // This catches network errors that escape the polling loop's try-catch
  // (e.g., from setMyCommands during bot setup).
  // We gate on isGrammyHttpError to avoid suppressing non-Telegram errors.
  const unregisterHandler = registerUnhandledRejectionHandler((err) => {
    if (isGrammyHttpError(err) && isRecoverableTelegramNetworkError(err, { context: "polling" })) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true; // handled - don't crash
    }
    return false;
  });

  let activePollerKey: string | null = null;
  let pollerLock: TelegramPollerLockHandle | null = null;
  try {
    const cfg = opts.config ?? loadConfig();
    const account = resolveTelegramAccount({
      cfg,
      accountId: opts.accountId,
    });
    const pollerKey = account.accountId;
    if (!opts.useWebhook) {
      try {
        await ensureTelegramMonitorPermissionPreflight({
          accountId: pollerKey,
          env: opts.env,
        });
      } catch (err) {
        const message = `telegram monitor permission preflight failed: ${formatErrorMessage(err)}`;
        log(message);
        throw new Error(message, { cause: err });
      }
      if (activeTelegramPollers.has(pollerKey)) {
        recordRuntimeTelemetryEvent({
          event: "telegram.poller_singleton_conflict",
          subsystem: "telegram-monitor",
          severity: "warning",
          status: "degraded",
          details: {
            accountId: pollerKey,
            mode: "polling",
          },
        });
        throw new Error(`telegram poller already running for account=${pollerKey}`);
      }
      activeTelegramPollers.add(pollerKey);
      activePollerKey = pollerKey;
      pollerLock = await acquireTelegramPollerLock({
        accountId: pollerKey,
        env: opts.env,
        onConflict: ({ accountId, ownerPid, ownerCreatedAt }) => {
          log(
            `telegram poller preflight conflict account=${accountId} ownerPid=${ownerPid ?? "unknown"} ownerCreatedAt=${ownerCreatedAt ?? "unknown"}`,
          );
        },
      });
    }
    const token = opts.token?.trim() || account.token;
    if (!token) {
      throw new Error(
        `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
      );
    }

    const proxyFetch =
      opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

    let lastUpdateId = await readTelegramUpdateOffset({
      accountId: account.accountId,
    });
    let highestObservedUpdateId = lastUpdateId;
    let lastAcceptedUpdateId = lastUpdateId;
    let lastSkippedUpdateId: number | null = null;
    let lastSkipReason: "stale_offset" | "dedupe" | null = null;
    const persistUpdateId = async (updateId: number) => {
      if (lastUpdateId !== null && updateId <= lastUpdateId) {
        return;
      }
      lastUpdateId = updateId;
      try {
        await writeTelegramUpdateOffset({
          accountId: account.accountId,
          updateId,
        });
      } catch (err) {
        (opts.runtime?.error ?? console.error)(
          `telegram: failed to persist update offset: ${String(err)}`,
        );
      }
    };

    const bot = createTelegramBot({
      token,
      runtime: opts.runtime,
      proxyFetch,
      config: cfg,
      accountId: account.accountId,
      updateOffset: {
        lastUpdateId,
        onUpdateId: persistUpdateId,
      },
      diagnostics: {
        onUpdateObserved: ({ updateId, skipped, reason }) => {
          if (highestObservedUpdateId == null || updateId > highestObservedUpdateId) {
            highestObservedUpdateId = updateId;
          }
          if (skipped) {
            lastSkippedUpdateId = updateId;
            lastSkipReason = reason ?? null;
            return;
          }
          if (lastAcceptedUpdateId == null || updateId > lastAcceptedUpdateId) {
            lastAcceptedUpdateId = updateId;
          }
        },
      },
    });

    if (opts.useWebhook) {
      await startTelegramWebhook({
        token,
        accountId: account.accountId,
        config: cfg,
        path: opts.webhookPath,
        port: opts.webhookPort,
        secret: opts.webhookSecret,
        runtime: opts.runtime as RuntimeEnv,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
      });
      return;
    }

    // Use grammyjs/runner for concurrent update processing
    let restartAttempts = 0;

    while (!opts.abortSignal?.aborted) {
      info(
        `[telegram] polling start account=${account.accountId} persistedOffset=${lastUpdateId ?? "none"} acceptedOffset=${lastAcceptedUpdateId ?? "none"} observedUpdate=${highestObservedUpdateId ?? "none"} restartAttempt=${restartAttempts}`,
      );
      const runner = run(bot, createTelegramRunnerOptions(cfg));
      // Track the runner.stop() promise so we can await it during cleanup,
      // preventing resource leaks from fire-and-forget stops.
      let stopPromise: Promise<void> | undefined;
      const stopOnAbort = () => {
        if (opts.abortSignal?.aborted) {
          stopPromise = runner.stop();
        }
      };
      opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
      try {
        // runner.task() returns a promise that resolves when the runner stops
        await runner.task();
        // Runner stopped without error — don't exit the loop. This can happen due
        // to internal cleanup, idle timeout, or Node fetch quirks (upstream #1639).
        // Reset backoff and restart polling instead of exiting permanently.
        if (opts.abortSignal?.aborted) {
          return;
        }
        if (process.env.VITEST || process.env.NODE_ENV === "test") {
          // Unit tests mock runner.task() to resolve immediately; restarting here
          // would spin forever and exhaust memory.
          return;
        }
        restartAttempts = 0;
        info(
          `[telegram] runner stopped (non-error); restarting polling account=${account.accountId} persistedOffset=${lastUpdateId ?? "none"} acceptedOffset=${lastAcceptedUpdateId ?? "none"} observedUpdate=${highestObservedUpdateId ?? "none"} lastSkipped=${lastSkippedUpdateId ?? "none"} skipReason=${lastSkipReason ?? "none"}`,
        );
        continue;
      } catch (err) {
        if (opts.abortSignal?.aborted) {
          throw err;
        }
        const isConflict = isGetUpdatesConflict(err);
        const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
        if (!isConflict && !isRecoverable) {
          throw err;
        }
        restartAttempts += 1;
        const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
        const reason = isConflict ? "getUpdates conflict" : "network error";
        const errMsg = formatErrorMessage(err);
        log(
          `Telegram ${reason}: ${errMsg}; retrying in ${formatDurationMs(delayMs)}. account=${account.accountId} persistedOffset=${lastUpdateId ?? "none"} acceptedOffset=${lastAcceptedUpdateId ?? "none"} observedUpdate=${highestObservedUpdateId ?? "none"} lastSkipped=${lastSkippedUpdateId ?? "none"} skipReason=${lastSkipReason ?? "none"} restartAttempt=${restartAttempts}`,
        );
        try {
          await sleepWithAbort(delayMs, opts.abortSignal);
        } catch (sleepErr) {
          if (opts.abortSignal?.aborted) {
            return;
          }
          throw sleepErr;
        }
      } finally {
        opts.abortSignal?.removeEventListener("abort", stopOnAbort);
        // Await the stop if it was triggered, ensuring the runner fully drains
        // before we create a new one in the next iteration.
        if (stopPromise) {
          await stopPromise.catch(() => {});
        }
      }
    }
  } finally {
    await pollerLock?.release().catch(() => undefined);
    if (activePollerKey) {
      activeTelegramPollers.delete(activePollerKey);
    }
    unregisterHandler();
  }
}
