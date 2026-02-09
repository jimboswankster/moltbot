/**
 * Memory Companion Adapter — thin engine-side loader.
 *
 * Mirrors the pattern established by stream-buffer-adapter.ts:
 *   - Read config.extensions.memoryCompanion.adapterPath
 *   - Dynamically import the workspace extension
 *   - Inject engine dependencies via factory function
 *   - Return typed adapter interface (or null if disabled/missing)
 *
 * All business logic lives in the extension. This file contains
 * only contract types and the loader. MIT-safe.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import { limitHistoryTurns } from "../agents/pi-embedded-runner/history.js";
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

/** Engine dependencies passed to the extension factory. */
export interface EngineDeps {
  limitHistoryTurns: (messages: AgentMessage[], limit: number | undefined) => AgentMessage[];
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
 * On success, injects engine dependencies and returns the adapter.
 */
export async function loadMemoryCompanionAdapter(
  cfg?: OpenClawConfig,
  log?: LogLike,
): Promise<MemoryCompanionAdapter | null> {
  const entry = (cfg as Record<string, unknown>)?.extensions as Record<string, unknown> | undefined;
  const mcConfig = entry?.memoryCompanion as
    | { enabled?: boolean; adapterPath?: string }
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

    // Inject engine dependencies
    const adapter = factory({ limitHistoryTurns });

    log?.debug?.(`memory companion adapter loaded from ${resolved}`);
    return adapter;
  } catch (err) {
    log?.warn?.(`failed to load memory companion adapter: ${resolved} (${String(err)})`);
    return null;
  }
}
