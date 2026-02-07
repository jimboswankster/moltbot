import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";

type LogLike = { warn?: (message: string) => void };

export type StreamBufferDecision = {
  allow: boolean;
  coalesceMs?: number;
  reason?: string;
  stage?: string;
};

export type StreamBufferAdapterInput = {
  sessionKey: string;
  runId: string;
  seq: number;
  text: string;
  deltaText?: string;
  timestamp: number;
};

export type StreamBufferAdapter = (input: StreamBufferAdapterInput) => StreamBufferDecision;

function resolveAdapter(candidate: unknown): StreamBufferAdapter | null {
  if (typeof candidate === "function") {
    return candidate as StreamBufferAdapter;
  }
  return null;
}

export async function loadStreamBufferAdapter(
  cfg?: OpenClawConfig,
  log?: LogLike,
): Promise<StreamBufferAdapter | null> {
  const entry = cfg?.extensions?.streamBuffer;
  if (!entry?.enabled) {
    return null;
  }
  const rawPath = entry.adapterPath?.trim();
  if (!rawPath) {
    log?.warn?.("stream buffer enabled but adapterPath is missing");
    return null;
  }
  const resolved = resolveUserPath(rawPath);
  try {
    const url = pathToFileURL(resolved).toString();
    const mod = await import(url);
    const adapter =
      resolveAdapter(mod?.default) ||
      resolveAdapter(mod?.adapter) ||
      resolveAdapter(mod?.streamBufferAdapter);
    if (!adapter) {
      log?.warn?.(`stream buffer adapter did not export a function: ${resolved}`);
      return null;
    }
    return adapter;
  } catch (err) {
    log?.warn?.(`failed to load stream buffer adapter: ${resolved} (${String(err)})`);
    return null;
  }
}
