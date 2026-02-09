/**
 * Memory Companion Adapter — thin engine-side loader.
 *
 * Mirrors the pattern established by stream-buffer-adapter.ts:
 *   - Read config.extensions.memoryCompanion.adapterPath
 *   - Dynamically import the workspace extension
 *   - Inject engine dependencies via factory function
 *   - Return typed adapter interface (or null if disabled/missing)
 *
 * Phase 3 additions:
 *   - Builds a `callCompanionLlm` function using the engine's model
 *     resolution + auth + `completeSimple` from pi-ai.
 *   - Passes companion config (batchSize, maxMemoryTokens) to the factory.
 *
 * All business logic lives in the extension. This file contains
 * only contract types, the loader, and the LLM bridge. MIT-safe.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { completeSimple } from "@mariozechner/pi-ai";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { limitHistoryTurns } from "../agents/pi-embedded-runner/history.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { resolveUserPath } from "../utils.js";

type LogLike = { warn?: (message: string) => void; debug?: (message: string) => void };

// ─── Contract Types (shapes only, no logic) ────────────────────────────────

export interface HistoryLimitResult {
  messages: AgentMessage[];
  degradationTier: "normal" | "caution" | "warning" | "emergency";
  sessionMemory?: string;
  turnsBehind?: number;
}

export interface ResolvedMemoryModel {
  provider: string;
  model: string;
}

export interface MemoryCompanionAdapter {
  limitWithMemory(
    messages: AgentMessage[],
    limit: number | undefined,
    sessionFile: string,
  ): HistoryLimitResult;

  getSessionMemoryForPrompt(sessionFile: string): string | undefined;

  onTurnComplete(sessionFile: string, messages: AgentMessage[]): Promise<void>;

  resolveModel(config: Record<string, unknown> | undefined): ResolvedMemoryModel | undefined;
}

/** Companion LLM call function (injected into extension). */
type CallCompanionLlmFn = (params: {
  systemPrompt: string;
  userPrompt: string;
}) => Promise<{ text: string }>;

/** Engine dependencies passed to the extension factory. */
export interface EngineDeps {
  limitHistoryTurns: (messages: AgentMessage[], limit: number | undefined) => AgentMessage[];
  callCompanionLlm?: CallCompanionLlmFn;
  companionConfig?: {
    batchSize?: number;
    maxMemoryTokens?: number;
    epochCompactionThreshold?: number;
  };
}

// ─── Companion LLM Bridge ───────────────────────────────────────────────────

/**
 * Build a callCompanionLlm function using the engine's model resolution
 * and auth infrastructure. Returns null if the memory model can't be resolved.
 *
 * The returned function uses `completeSimple` from pi-ai — the same
 * lightweight API used by tts.ts and image-tool.ts.
 */
async function buildCompanionLlmCaller(
  memoryModel: ResolvedMemoryModel,
  cfg: OpenClawConfig | undefined,
  agentDir: string | undefined,
  log?: LogLike,
): Promise<CallCompanionLlmFn | null> {
  const resolved = resolveModel(memoryModel.provider, memoryModel.model, agentDir, cfg);

  if (!resolved.model) {
    log?.warn?.(
      `memory companion: could not resolve model ${memoryModel.provider}/${memoryModel.model}: ${resolved.error}`,
    );
    return null;
  }

  let apiKey: string;
  try {
    const auth = await getApiKeyForModel({
      model: resolved.model,
      cfg,
      agentDir,
    });
    apiKey = requireApiKey(auth, memoryModel.provider);
  } catch (err) {
    log?.warn?.(
      `memory companion: could not resolve API key for ${memoryModel.provider}: ${String(err)}`,
    );
    return null;
  }

  const model = resolved.model;

  return async ({ systemPrompt, userPrompt }) => {
    const res = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: `${systemPrompt}\n\n${userPrompt}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 300,
        temperature: 0.3,
      },
    );

    const text = res.content
      .filter((block: { type: string; text?: string }) => block.type === "text")
      .map((block: { type: string; text?: string }) => (block.text ?? "").trim())
      .filter(Boolean)
      .join(" ");

    return { text };
  };
}

// ─── Loader ─────────────────────────────────────────────────────────────────

function resolveFactory(
  mod: Record<string, unknown>,
): ((deps: EngineDeps) => MemoryCompanionAdapter) | null {
  const candidates = [mod?.createMemoryCompanionAdapter, mod?.default, mod?.adapter];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as (deps: EngineDeps) => MemoryCompanionAdapter;
    }
  }
  return null;
}

/**
 * Load the Memory Companion adapter from workspace extension.
 *
 * Returns null if:
 *   - Extension is disabled in config
 *   - adapterPath is missing
 *   - Extension module can't be loaded
 *   - Extension doesn't export a factory function
 *
 * On success, injects engine dependencies (including companion LLM caller)
 * and returns the adapter.
 */
export async function loadMemoryCompanionAdapter(
  cfg?: OpenClawConfig,
  agentDir?: string,
  log?: LogLike,
): Promise<MemoryCompanionAdapter | null> {
  const entry = (cfg as Record<string, unknown>)?.extensions as Record<string, unknown> | undefined;
  const mcConfig = entry?.memoryCompanion as
    | {
        enabled?: boolean;
        adapterPath?: string;
        batchSize?: number;
        maxMemoryTokens?: number;
        epochCompactionThreshold?: number;
      }
    | undefined;

  if (!mcConfig?.enabled) {
    return null;
  }

  const rawPath = mcConfig.adapterPath?.trim();
  if (!rawPath) {
    log?.warn?.("memory companion enabled but adapterPath is missing");
    return null;
  }

  const resolved = resolveUserPath(rawPath);

  try {
    // Use jiti for TypeScript support (same as plugin loader)
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".js", ".mjs"],
    });

    const mod = (await jiti.import(resolved)) as Record<string, unknown>;
    const factory = resolveFactory(mod);

    if (!factory) {
      log?.warn?.(
        `memory companion adapter did not export createMemoryCompanionAdapter: ${resolved}`,
      );
      return null;
    }

    // Build companion LLM caller (Phase 3)
    // First, create a temporary adapter to resolve the memory model from config
    const tempAdapter = factory({ limitHistoryTurns });
    const memoryModel = tempAdapter.resolveModel(cfg as Record<string, unknown>);
    let callCompanionLlm: CallCompanionLlmFn | undefined;

    if (memoryModel) {
      const caller = await buildCompanionLlmCaller(memoryModel, cfg, agentDir, log);
      if (caller) {
        callCompanionLlm = caller;
        log?.debug?.(
          `memory companion: LLM caller ready (${memoryModel.provider}/${memoryModel.model})`,
        );
      } else {
        log?.warn?.("memory companion: LLM caller not available, onTurnComplete will be no-op");
      }
    }

    // Inject all engine dependencies
    const adapter = factory({
      limitHistoryTurns,
      callCompanionLlm,
      companionConfig: {
        batchSize: mcConfig.batchSize,
        maxMemoryTokens: mcConfig.maxMemoryTokens,
        epochCompactionThreshold: mcConfig.epochCompactionThreshold,
      },
    });

    log?.debug?.(`memory companion adapter loaded from ${resolved}`);
    return adapter;
  } catch (err) {
    log?.warn?.(`failed to load memory companion adapter: ${resolved} (${String(err)})`);
    return null;
  }
}
