/**
 * Resolve the "memory" model role from OpenClawConfig.
 *
 * The Memory Companion uses a dedicated cheap/fast model for
 * incremental summarization. This function looks up the "memory"
 * role in the config's modelRoles mapping.
 *
 * Config example in openclaw.json:
 *   "modelRoles": {
 *     "primary": "google/gemini-3-pro-preview",
 *     "memory": "google/gemini-2.0-flash"
 *   }
 */

import type { OpenClawConfig } from "../config/config.js";

export interface ResolvedMemoryModel {
  provider: string;
  model: string;
}

/**
 * Resolve the memory companion model from config.
 * Returns undefined if no "memory" role is configured.
 */
export function resolveMemoryModel(
  cfg: OpenClawConfig | undefined,
): ResolvedMemoryModel | undefined {
  if (!cfg) return undefined;

  const roles = (cfg as Record<string, any>)?.agents?.defaults?.modelRoles as
    | Record<string, string>
    | undefined;

  if (!roles) return undefined;

  const memoryModel = roles.memory;
  if (!memoryModel || typeof memoryModel !== "string") return undefined;

  const trimmed = memoryModel.trim();
  if (!trimmed) return undefined;

  // Parse "provider/model" format
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    return { provider: "", model: trimmed };
  }

  return {
    provider: trimmed.slice(0, slashIdx),
    model: trimmed.slice(slashIdx + 1),
  };
}
