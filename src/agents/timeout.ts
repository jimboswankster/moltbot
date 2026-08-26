import type { OpenClawConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

function normalizeChannel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function inferChannelFromSessionKey(value: unknown): string | undefined {
  const sessionKey = normalizeChannel(value);
  if (sessionKey?.startsWith("telegram:") || sessionKey?.includes(":telegram:")) {
    return "telegram";
  }
  return undefined;
}

export function resolveAgentTimeoutSeconds(
  cfg?: OpenClawConfig,
  context?: {
    channel?: string;
    sessionKey?: string;
  },
): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const defaultSeconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  const channelKey =
    normalizeChannel(context?.channel) ?? inferChannelFromSessionKey(context?.sessionKey);
  const byChannelRaw = channelKey
    ? normalizeNumber(
        (cfg?.agents?.defaults?.timeoutSecondsByChannel as Record<string, number | undefined>)?.[
          channelKey
        ],
      )
    : undefined;
  const seconds = byChannelRaw ?? defaultSeconds;
  return Math.max(seconds, 1);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  channel?: string;
  sessionKey?: string;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const defaultMs =
    resolveAgentTimeoutSeconds(opts.cfg, {
      channel: opts.channel,
      sessionKey: opts.sessionKey,
    }) * 1000;
  // Use a very large timeout value (Int32 Max) to represent "no timeout"
  // when explicitly set to 0. This avoids setTimeout issues with Infinity and Int32 overflow.
  const NO_TIMEOUT_MS = 2147483647;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return Math.max(overrideMs, minMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return Math.max(overrideSeconds * 1000, minMs);
  }
  return Math.max(defaultMs, minMs);
}
