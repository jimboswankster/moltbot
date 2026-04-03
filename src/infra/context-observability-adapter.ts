import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";

type LogLike = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

export type TelegramContextComposedInput = {
  sessionKey: string;
  chatId: string | number;
  topicId?: string | number;
  isGroup: boolean;
  historyLimit: number;
  pendingHistoryEntryCount: number;
  rawBody: string;
  envelopeBody: string;
  combinedBody: string;
};

export type AgentContextPreparedInput = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider: string;
  modelId: string;
  messageChannel?: string;
  systemPromptTokens: number;
  historyMessages: AgentMessage[];
  memoryCompanionChars?: number;
};

export interface ContextObservabilityAdapter {
  onTelegramContextComposed?(input: TelegramContextComposedInput): void | Promise<void>;
  onAgentContextPrepared?(input: AgentContextPreparedInput): void | Promise<void>;
}

type ContextObservabilityConfig = {
  enabled?: boolean;
  adapterPath?: string;
};

function resolveFactory(
  mod: Record<string, unknown>,
): ((deps: Record<string, never>) => ContextObservabilityAdapter) | null {
  const candidates = [mod?.createContextObservabilityAdapter, mod?.default, mod?.adapter];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as (deps: Record<string, never>) => ContextObservabilityAdapter;
    }
  }
  return null;
}

export async function loadContextObservabilityAdapter(
  cfg?: OpenClawConfig,
  log?: LogLike,
): Promise<ContextObservabilityAdapter | null> {
  const entry = (cfg as Record<string, unknown>)?.extensions as Record<string, unknown> | undefined;
  const adapterConfig = entry?.contextObservability as ContextObservabilityConfig | undefined;
  if (!adapterConfig?.enabled) {
    return null;
  }
  const rawPath = adapterConfig.adapterPath?.trim();
  if (!rawPath) {
    log?.warn?.("context observability enabled but adapterPath is missing");
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
        `context observability adapter did not export createContextObservabilityAdapter: ${resolved}`,
      );
      return null;
    }
    const adapter = factory({});
    log?.debug?.(`context observability adapter loaded from ${resolved}`);
    return adapter;
  } catch (err) {
    log?.warn?.(`failed to load context observability adapter: ${resolved} (${String(err)})`);
    return null;
  }
}
