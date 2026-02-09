/**
 * Memory Companion — Deterministic Fallback Summarizer
 *
 * Zero-LLM summary extraction from a batch of conversation messages.
 * Used when the companion LLM is unavailable (graduated safety guard
 * "caution" tier) or as a baseline quality floor.
 *
 * Extracts:
 *   1. User intents (first sentence of each user message)
 *   2. Decision sentences (H-4 aligned heuristics)
 *   3. Tool names invoked
 *   4. File paths mentioned
 *
 * Phase -1 Step 1 validated this at 86% of full-context ceiling.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeterministicSummaryResult {
  summary: string;
  quality: "deterministic";
}

// ─── Decision keywords (H-4 aligned) ────────────────────────────────────────

const DECISION_KEYWORDS = [
  "decided",
  "chose",
  "rejected",
  "instead",
  "will use",
  "should",
  "switched to",
  "migrated",
  "we chose",
  "we decided",
  "opted for",
  "going with",
];

// ─── Extraction helpers ─────────────────────────────────────────────────────

function extractText(msg: AgentMessage): string {
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: Record<string, unknown>) => c.type === "text")
      .map((c: Record<string, unknown>) => c.text as string)
      .join("\n");
  }
  return "";
}

function extractToolNames(msg: AgentMessage): string[] {
  const content = (msg as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: Record<string, unknown>) => c.type === "toolCall")
    .map((c: Record<string, unknown>) => (c.toolName as string) || "")
    .filter(Boolean);
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(
    /(?:\/(?:Users|home|var|tmp|etc|src|test|docs|workspace)[/\w._-]+(?:\.\w+)?)/g,
  );
  if (!matches) return [];
  // Deduplicate and keep meaningful paths
  const seen = new Set<string>();
  return matches.filter((p) => {
    if (p.length < 8 || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

function extractDecisions(text: string): string[] {
  const sentences: string[] = [];
  for (const raw of text.split(/[.!?\n]/)) {
    const s = raw.trim();
    if (s.length < 15) continue;
    const lower = s.toLowerCase();
    if (DECISION_KEYWORDS.some((kw) => lower.includes(kw))) {
      sentences.push(s.slice(0, 150));
    }
  }
  return sentences;
}

function extractUserIntents(messages: AgentMessage[]): string[] {
  const intents: string[] = [];
  for (const msg of messages) {
    const role = (msg as Record<string, unknown>).role as string;
    if (role !== "user") continue;
    const text = extractText(msg);
    if (!text) continue;
    // First meaningful line (skip timestamps, system prefixes)
    const lines = text.split("\n").filter((l) => l.trim().length > 15);
    if (lines.length > 0) {
      intents.push(lines[0].trim().slice(0, 150));
    }
  }
  return intents;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a deterministic (zero-LLM) summary of a batch of messages.
 *
 * Returns structured text with sections for user intents, tools, files,
 * and decisions extracted via heuristics.
 */
export function deterministicSummary(messages: AgentMessage[]): DeterministicSummaryResult {
  if (messages.length === 0) {
    return { summary: "", quality: "deterministic" };
  }

  const allText: string[] = [];
  const toolNames = new Set<string>();

  for (const msg of messages) {
    const text = extractText(msg);
    if (text) allText.push(text);

    for (const name of extractToolNames(msg)) {
      toolNames.add(name);
    }

    // Also extract tool name from toolResult messages
    const tn = (msg as Record<string, unknown>).toolName as string | undefined;
    if (tn) toolNames.add(tn);
  }

  const combinedText = allText.join("\n");
  const userIntents = extractUserIntents(messages);
  const filePaths = extractFilePaths(combinedText);
  const decisions = extractDecisions(combinedText);

  // Build structured summary
  const sections: string[] = [];

  if (userIntents.length > 0) {
    sections.push("USER INTENTS: " + userIntents.slice(0, 5).join("; "));
  }

  if (toolNames.size > 0) {
    sections.push("TOOLS: " + [...toolNames].sort().join(", "));
  }

  if (filePaths.length > 0) {
    sections.push("FILES: " + filePaths.slice(0, 8).join(", "));
  }

  if (decisions.length > 0) {
    sections.push("DECISIONS: " + decisions.slice(0, 4).join("; "));
  }

  return {
    summary: sections.join("\n"),
    quality: "deterministic",
  };
}
