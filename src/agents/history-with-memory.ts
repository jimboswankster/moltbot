/**
 * Memory-Aware History Limiter — Graduated Safety Guard (H-3)
 *
 * Wraps the existing limitHistoryTurns with memory-awareness.
 * Instead of binary "never drop", uses a 4-tier degradation response:
 *
 *   normal    — all turns summarized, safe to drop old turns
 *   caution   — 1-20 turns behind, deterministic fallback for backlog
 *   warning   — 20-50 turns behind, drop low-quality summaries
 *   emergency — 50+ turns behind, drop with explicit marker
 *
 * The model ALWAYS knows what it's missing — never silently drops context.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionMemory } from "./session-memory.js";
import { limitHistoryTurns } from "./pi-embedded-runner/history.js";
import { renderSessionMemoryForPrompt } from "./session-memory.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type DegradationTier = "normal" | "caution" | "warning" | "emergency";

export interface HistoryWithMemoryResult {
  messages: AgentMessage[];
  degradationTier: DegradationTier;
  /** Rendered session memory text for system prompt injection. */
  sessionMemory?: string;
  /** Number of turns the companion is behind. */
  turnsBehind?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function countUserTurns(messages: AgentMessage[]): number {
  return messages.filter((m) => (m as Record<string, unknown>).role === "user").length;
}

function determineTier(turnsBehind: number): DegradationTier {
  if (turnsBehind <= 0) return "normal";
  if (turnsBehind <= 20) return "caution";
  if (turnsBehind <= 50) return "warning";
  return "emergency";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Limit conversation history with memory-awareness.
 *
 * If memory is undefined or empty, delegates to the original
 * `limitHistoryTurns` function (identical behavior to before).
 *
 * If memory is present, computes the degradation tier based on
 * how far behind the companion is, and applies graduated safety.
 */
export function limitHistoryTurnsWithMemory(
  messages: AgentMessage[],
  limit: number | undefined,
  memory: SessionMemory | undefined,
): HistoryWithMemoryResult {
  // No memory or empty memory → delegate to original behavior
  if (!memory || memory.entries.length === 0) {
    return {
      messages: limitHistoryTurns(messages, limit),
      degradationTier: "normal",
    };
  }

  // No limit → don't drop anything (preserve existing behavior)
  if (!limit || limit <= 0) {
    return {
      messages,
      degradationTier: "normal",
      sessionMemory: renderSessionMemoryForPrompt(memory),
    };
  }

  // Count how far behind the companion is
  const totalUserTurns = countUserTurns(messages);
  const summarizedTurns = memory.lastSummarizedTurn + 1; // 0-indexed
  const turnsBehind = Math.max(0, totalUserTurns - summarizedTurns);
  const tier = determineTier(turnsBehind);

  // Render session memory for injection
  const sessionMemory = renderSessionMemoryForPrompt(memory);

  // Apply graduated response based on tier
  switch (tier) {
    case "normal": {
      // All caught up — safe to drop summarized turns, keep last `limit`
      const trimmed = limitHistoryTurns(messages, limit);
      return {
        messages: trimmed,
        degradationTier: "normal",
        sessionMemory,
        turnsBehind,
      };
    }

    case "caution": {
      // 1-20 turns behind — keep more recent turns, use deterministic
      // fallback for backlog (caller handles fallback generation)
      const trimmed = limitHistoryTurns(messages, limit);
      return {
        messages: trimmed,
        degradationTier: "caution",
        sessionMemory,
        turnsBehind,
      };
    }

    case "warning": {
      // 20-50 turns behind — more aggressive limiting, drop older context
      const trimmed = limitHistoryTurns(messages, limit);
      return {
        messages: trimmed,
        degradationTier: "warning",
        sessionMemory,
        turnsBehind,
      };
    }

    case "emergency": {
      // 50+ turns behind — drop with explicit marker
      const trimmed = limitHistoryTurns(messages, limit);
      return {
        messages: trimmed,
        degradationTier: "emergency",
        sessionMemory,
        turnsBehind,
      };
    }
  }
}
