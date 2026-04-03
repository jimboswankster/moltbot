import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";

type LogLike = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

export type TelegramPendingHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

export type TelegramContextPolicyInput = {
  sessionKey: string;
  chatId: string | number;
  topicId?: string | number;
  historyLimit: number;
  envelopeBody: string;
  pendingHistoryEntries: TelegramPendingHistoryEntry[];
};

export type TelegramContextPolicyOutput = {
  body?: string;
  untrustedContext?: string[];
};

export type TelegramSessionHistoryPolicyInput = {
  sessionKey: string;
  chatId?: string | number;
  topicId?: string | number;
  historyLimit?: number;
};

export interface TelegramContextPolicyAdapter {
  shapeInboundContext?(
    input: TelegramContextPolicyInput,
  ): TelegramContextPolicyOutput | Promise<TelegramContextPolicyOutput>;
  resolveSessionHistoryLimit?(
    input: TelegramSessionHistoryPolicyInput,
  ): number | undefined | Promise<number | undefined>;
}

type TelegramContextPolicyConfig = {
  enabled?: boolean;
  adapterPath?: string;
};

function resolveFactory(
  mod: Record<string, unknown>,
): ((deps: Record<string, never>) => TelegramContextPolicyAdapter) | null {
  const candidates = [mod?.createTelegramContextPolicyAdapter, mod?.default, mod?.adapter];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as (deps: Record<string, never>) => TelegramContextPolicyAdapter;
    }
  }
  return null;
}

export async function loadTelegramContextPolicyAdapter(
  cfg?: OpenClawConfig,
  log?: LogLike,
): Promise<TelegramContextPolicyAdapter | null> {
  const entry = (cfg as Record<string, unknown>)?.extensions as Record<string, unknown> | undefined;
  const adapterConfig = entry?.telegramContextPolicy as TelegramContextPolicyConfig | undefined;
  if (!adapterConfig?.enabled) {
    return null;
  }
  const rawPath = adapterConfig.adapterPath?.trim();
  if (!rawPath) {
    log?.warn?.("telegram context policy enabled but adapterPath is missing");
    return null;
  }
  const resolved = resolveUserPath(rawPath);
  try {
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".js", ".mjs"],
    });
    const mod = (await jiti.import(resolved)) as Record<string, unknown>;
    const factory = resolveFactory(mod);
    if (!factory) {
      log?.warn?.(
        `telegram context policy adapter did not export createTelegramContextPolicyAdapter: ${resolved}`,
      );
      return null;
    }
    const adapter = factory({});
    log?.debug?.(`telegram context policy adapter loaded from ${resolved}`);
    return adapter;
  } catch (err) {
    log?.warn?.(`failed to load telegram context policy adapter: ${resolved} (${String(err)})`);
    return null;
  }
}
