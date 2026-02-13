/**
 * Token Budget Gate — hard guarantee against context overflow.
 *
 * Inserted AFTER the existing limiting pipeline (limitHistoryTurns,
 * limitToolResults, capToolResultSize) and BEFORE replaceMessages.
 *
 * Uses estimateMessagesTokens (same estimator used by compaction) to
 * measure the prompt, then progressively sheds context until it fits
 * the model's context window.
 *
 * Shedding order (least valuable first):
 *   1. Re-cap tool result content size (20K → 10K → 5K → 2K)
 *   2. Reduce kept tool results (current → 10 → 5 → 3 → 1)
 *   3. Drop oldest messages (preserve last user message)
 *   4. Flag shouldCompact if still over budget
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens, SAFETY_MARGIN } from "../compaction.js";
import { capToolResultSize, limitToolResults } from "./history.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default tokens reserved for model output generation. */
const DEFAULT_OUTPUT_RESERVE_TOKENS = 4096;

/** Progressive tool result size caps (chars) — tried in order when over budget. */
const TOOL_SIZE_STEPS = [10_000, 5_000, 2_000];

/** Progressive tool result count caps — tried in order when over budget. */
const TOOL_COUNT_STEPS = [10, 5, 3, 1];

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TokenBudgetResult {
  /** Messages after budget fitting (may be the original array if no changes needed). */
  messages: AgentMessage[];
  /** Estimated token count of the returned messages. */
  estimatedTokens: number;
  /** Available token budget (contextWindow minus reserves). */
  budgetTokens: number;
  /** Human-readable descriptions of trimming actions taken. */
  actions: string[];
  /** If true, caller should trigger proactive compaction before send. */
  shouldCompact: boolean;
}

export interface TokenBudgetOptions {
  /** Tokens reserved for model output (default 4096). */
  outputReserveTokens?: number;
  /** Tokens already consumed by system prompt (subtracted from budget). */
  systemPromptTokens?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isWithinBudget(estimatedTokens: number, budgetTokens: number): boolean {
  return estimatedTokens * SAFETY_MARGIN <= budgetTokens;
}

/**
 * Count current full (non-cleared) tool results in messages.
 */
function countFullToolResults(messages: AgentMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!Array.isArray(msg.content)) continue;
    // A cleared result has a single block with the sentinel text
    const isCleared =
      msg.content.length === 1 &&
      msg.content[0]?.type === "text" &&
      typeof msg.content[0].text === "string" &&
      msg.content[0].text.startsWith("[Old tool result cleared");
    if (!isCleared) {
      count++;
    }
  }
  return count;
}

/**
 * Drop oldest messages until estimated tokens fit budget.
 * Always preserves the last user message.
 * Returns the trimmed messages and the count of dropped messages.
 */
function dropOldestToFit(
  messages: AgentMessage[],
  budgetTokens: number,
): { messages: AgentMessage[]; dropped: number } {
  if (messages.length === 0) {
    return { messages, dropped: 0 };
  }

  // Find the index of the last user message — we must keep it
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // Binary search: find the smallest start index where tail fits budget.
  // We always keep everything from lastUserIndex onward at minimum.
  const mustKeepFrom = lastUserIndex >= 0 ? lastUserIndex : messages.length - 1;
  let lo = 0;
  let hi = mustKeepFrom;
  let bestStart = mustKeepFrom; // fallback: keep from last user msg

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const slice = messages.slice(mid);
    const est = estimateMessagesTokens(slice);
    if (isWithinBudget(est, budgetTokens)) {
      bestStart = mid;
      hi = mid - 1; // try keeping more
    } else {
      lo = mid + 1; // need to drop more
    }
  }

  if (bestStart === 0) {
    return { messages, dropped: 0 };
  }

  const trimmed = messages.slice(bestStart);
  // Insert a marker so the model knows context was truncated
  const dropped = bestStart;
  const marker: AgentMessage = {
    role: "user",
    content: `[Context truncated: ${dropped} older messages dropped to fit model context window (${budgetTokens} token budget)]`,
    timestamp: trimmed[0]?.timestamp ?? Date.now(),
  };

  return {
    messages: [marker, ...trimmed],
    dropped,
  };
}

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Hard token-budget guarantee. Progressively sheds context until
 * estimated tokens fit the model's context window.
 *
 * This function is pure — it never mutates the input array.
 * It is designed to be a safety net after the existing limiting pipeline.
 */
export function fitToTokenBudget(
  messages: AgentMessage[],
  contextWindowTokens: number,
  options?: TokenBudgetOptions,
): TokenBudgetResult {
  const outputReserve = options?.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const systemPromptTokens = options?.systemPromptTokens ?? 0;
  const budgetTokens = Math.max(
    0,
    Math.floor(contextWindowTokens - outputReserve - systemPromptTokens),
  );

  const actions: string[] = [];
  let current = messages;
  let estimated = estimateMessagesTokens(current);

  // Fast path: already under budget
  if (isWithinBudget(estimated, budgetTokens)) {
    return {
      messages: current,
      estimatedTokens: estimated,
      budgetTokens,
      actions,
      shouldCompact: false,
    };
  }

  // ── Step 1: Tighten tool result size caps ──
  for (const maxChars of TOOL_SIZE_STEPS) {
    const recapped = capToolResultSize(current, maxChars);
    const newEstimated = estimateMessagesTokens(recapped);
    if (newEstimated < estimated) {
      actions.push(
        `recapped tool results to ${maxChars} chars (${estimated}→${newEstimated} est tokens)`,
      );
      current = recapped;
      estimated = newEstimated;
      if (isWithinBudget(estimated, budgetTokens)) {
        return {
          messages: current,
          estimatedTokens: estimated,
          budgetTokens,
          actions,
          shouldCompact: false,
        };
      }
    }
  }

  // ── Step 2: Reduce kept tool results ──
  const currentFullResults = countFullToolResults(current);
  for (const keepCount of TOOL_COUNT_STEPS) {
    if (keepCount >= currentFullResults) continue; // no point re-running with same or higher limit
    const reduced = limitToolResults(current, keepCount);
    const newEstimated = estimateMessagesTokens(reduced);
    if (newEstimated < estimated) {
      actions.push(
        `reduced kept tool results to ${keepCount} (was ${currentFullResults}, ${estimated}→${newEstimated} est tokens)`,
      );
      current = reduced;
      estimated = newEstimated;
      if (isWithinBudget(estimated, budgetTokens)) {
        return {
          messages: current,
          estimatedTokens: estimated,
          budgetTokens,
          actions,
          shouldCompact: false,
        };
      }
    }
  }

  // ── Step 3: Drop oldest messages ──
  const { messages: trimmed, dropped } = dropOldestToFit(current, budgetTokens);
  if (dropped > 0) {
    current = trimmed;
    estimated = estimateMessagesTokens(current);
    actions.push(`dropped ${dropped} oldest messages (${estimated} est tokens remaining)`);
    if (isWithinBudget(estimated, budgetTokens)) {
      return {
        messages: current,
        estimatedTokens: estimated,
        budgetTokens,
        actions,
        shouldCompact: false,
      };
    }
  }

  // ── Step 4: Still over budget — flag for proactive compaction ──
  actions.push(
    `still over budget after all shedding (${estimated} est tokens vs ${budgetTokens} budget); flagging shouldCompact`,
  );

  return {
    messages: current,
    estimatedTokens: estimated,
    budgetTokens,
    actions,
    shouldCompact: true,
  };
}

// ─── Budget-Derived Limits ──────────────────────────────────────────────────

export interface ContextDerivedLimits {
  /** Maximum user turns to keep in history. */
  historyTurns: number;
  /** Number of full tool results to keep. */
  toolResultsKept: number;
  /** Maximum chars per tool result. */
  toolResultMaxChars: number;
}

/**
 * Derive first-pass limiting constants from the model's context window.
 * Smaller models get tighter limits; larger models can keep more.
 *
 * These are fast first-pass filters — fitToTokenBudget is the hard guarantee.
 */
export function deriveContextLimits(contextWindowTokens: number): ContextDerivedLimits {
  if (contextWindowTokens <= 32_000) {
    return { historyTurns: 10, toolResultsKept: 3, toolResultMaxChars: 5_000 };
  }
  if (contextWindowTokens <= 64_000) {
    return { historyTurns: 20, toolResultsKept: 5, toolResultMaxChars: 10_000 };
  }
  if (contextWindowTokens <= 128_000) {
    return { historyTurns: 30, toolResultsKept: 10, toolResultMaxChars: 15_000 };
  }
  // 128K+ (most current models)
  return { historyTurns: 50, toolResultsKept: 15, toolResultMaxChars: 20_000 };
}
