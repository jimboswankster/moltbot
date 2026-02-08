/**
 * Centralized LLM-to-API input normalization.
 *
 * LLMs naturally produce human-language variants for canonical identifiers
 * (e.g. "current", "self", "me" instead of omitting a sessionKey parameter).
 * This module provides a single synonym resolution layer so every tool
 * normalizes the same way.
 *
 * Design:
 *  - Explicit synonym maps (not fuzzy matching) — deterministic, testable, no
 *    false positives (e.g. "rain" won't match "main").
 *  - Returns a tagged result so callers can distinguish resolved synonyms from
 *    pass-through values.
 *  - Domains are extensible: add a new key to `SYNONYM_MAP` when a new
 *    identifier category needs normalization.
 */

// ---------------------------------------------------------------------------
// Canonical tokens — the resolved values that tools switch on.
// ---------------------------------------------------------------------------

/** The caller's own session / agent / model. */
export const SELF_TOKEN = "self" as const;

/** The main / default / primary entity. */
export const MAIN_TOKEN = "main" as const;

// ---------------------------------------------------------------------------
// Domain synonym maps
// ---------------------------------------------------------------------------

export type NormalizeDomain = "session" | "model" | "agent";

/**
 * Maps lowercased user input → canonical token.
 *
 * To add a new synonym: drop it into the appropriate domain object.
 * To add a new domain: add a key here and update `NormalizeDomain`.
 */
const SYNONYM_MAP: Record<NormalizeDomain, ReadonlyMap<string, string>> = {
  session: new Map([
    // Self-references → SELF_TOKEN
    ["current", SELF_TOKEN],
    ["self", SELF_TOKEN],
    ["me", SELF_TOKEN],
    ["this", SELF_TOKEN],
    ["mine", SELF_TOKEN],
    ["own", SELF_TOKEN],
    ["my session", SELF_TOKEN],
    ["this session", SELF_TOKEN],
    ["the current session", SELF_TOKEN],
    ["current session", SELF_TOKEN],
    // Main-session references → MAIN_TOKEN
    ["default", MAIN_TOKEN],
    ["main", MAIN_TOKEN],
    ["primary", MAIN_TOKEN],
  ]),

  model: new Map([
    ["default", MAIN_TOKEN],
    ["current", SELF_TOKEN],
    ["same", SELF_TOKEN],
    ["same model", SELF_TOKEN],
    ["current model", SELF_TOKEN],
    ["keep", SELF_TOKEN],
  ]),

  agent: new Map([
    ["me", SELF_TOKEN],
    ["self", SELF_TOKEN],
    ["current", SELF_TOKEN],
    ["this agent", SELF_TOKEN],
    ["default", MAIN_TOKEN],
    ["main", MAIN_TOKEN],
    ["primary", MAIN_TOKEN],
  ]),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type NormalizeResult = {
  /** The canonical value to use (either a mapped token or the original input, trimmed). */
  canonical: string;
  /** `true` when the input was recognized as a synonym and mapped. */
  wasSynonym: boolean;
};

/**
 * Normalize a raw tool-input string against a domain-specific synonym map.
 *
 * @example
 * ```ts
 * const r = normalizeToolInput("session", "current");
 * // r.canonical === "self", r.wasSynonym === true
 *
 * const r2 = normalizeToolInput("session", "agent:default:telegram:dm:123");
 * // r2.canonical === "agent:default:telegram:dm:123", r2.wasSynonym === false
 * ```
 */
export function normalizeToolInput(domain: NormalizeDomain, raw: string): NormalizeResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { canonical: trimmed, wasSynonym: false };
  }
  const key = trimmed.toLowerCase();
  const map = SYNONYM_MAP[domain];
  const mapped = map?.get(key);
  if (mapped !== undefined) {
    return { canonical: mapped, wasSynonym: true };
  }
  return { canonical: trimmed, wasSynonym: false };
}

/**
 * Resolve a session-key parameter, handling self-reference synonyms.
 *
 * Call this immediately after `readStringParam(params, "sessionKey")` in any
 * tool that accepts a session identifier.
 *
 * @param raw       The raw string from the LLM (may be `undefined` if omitted).
 * @param selfKey   The caller's own session key (e.g. `opts.agentSessionKey`).
 * @returns         The resolved key to use for lookup, or `undefined` if both
 *                  `raw` and `selfKey` are empty.
 */
export function resolveSessionKeyParam(
  raw: string | undefined,
  selfKey: string | undefined,
): string | undefined {
  if (raw == null || !raw.trim()) {
    // Parameter omitted — fall back to caller's own key (existing behavior).
    return selfKey?.trim() || undefined;
  }
  const { canonical, wasSynonym } = normalizeToolInput("session", raw);
  if (wasSynonym && canonical === SELF_TOKEN) {
    // "current", "self", "me", etc. → caller's own session.
    return selfKey?.trim() || undefined;
  }
  if (wasSynonym && canonical === MAIN_TOKEN) {
    // "default", "primary" → "main" (resolveInternalSessionKey handles the rest).
    return "main";
  }
  // Not a synonym — pass through unchanged.
  return raw.trim();
}
