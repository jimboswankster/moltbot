/**
 * Test helpers for Memory Companion (F1) tests.
 *
 * Provides factory functions for creating valid AgentMessage shapes,
 * session memory structures, and utilities for loading test fixtures.
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs";
import path from "node:path";

// ---------- AgentMessage factories ----------

/**
 * Create a user message with text content.
 */
export function makeUser(text: string, timestamp?: string): AgentMessage {
  const msg: Record<string, unknown> = {
    role: "user",
    content: text,
  };
  if (timestamp) msg.timestamp = timestamp;
  return msg as unknown as AgentMessage;
}

/**
 * Create an assistant message with text content blocks.
 * Optionally includes thinking blocks to simulate real production messages.
 */
export function makeAssistant(
  text: string,
  opts?: { thinking?: string; toolCalls?: Array<{ toolName: string; args: string }> },
): AgentMessage {
  const content: Array<{ type: string; text?: string; toolName?: string; args?: string }> = [];

  if (opts?.thinking) {
    content.push({ type: "thinking", text: opts.thinking });
  }
  content.push({ type: "text", text });
  if (opts?.toolCalls) {
    for (const tc of opts.toolCalls) {
      content.push({ type: "toolCall", toolName: tc.toolName, args: tc.args });
    }
  }

  return {
    role: "assistant",
    content,
  } as unknown as AgentMessage;
}

/**
 * Create a toolResult message. Content is always an array (Gemini-safe format).
 */
export function makeToolResult(
  toolName: string,
  text: string,
  toolCallId: string = `tc-${Math.random().toString(36).slice(2, 8)}`,
): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId,
    content: [{ type: "text" as const, text }],
  } as unknown as AgentMessage;
}

/**
 * Create a session_memory system message (the kind injected by the Memory Companion).
 */
export function makeMemoryMessage(summaryText: string): AgentMessage {
  return {
    role: "user",
    content: `[SESSION MEMORY — Summary of earlier conversation]\n\n${summaryText}\n\n[END SESSION MEMORY]`,
  } as unknown as AgentMessage;
}

// ---------- Session Memory structures ----------

export interface SessionMemoryEntry {
  turnRange: [number, number];
  summary: string;
  generatedBy: string;
  generatedAt: number;
  quality: "llm" | "deterministic" | "epoch";
  previousSummary?: string; // for chaining: what batch N-1 produced (H-2)
}

export interface SessionMemory {
  entries: SessionMemoryEntry[];
  lastSummarizedTurn: number;
}

/**
 * Create an empty session memory (no summaries yet).
 */
export function makeEmptyMemory(): SessionMemory {
  return { entries: [], lastSummarizedTurn: -1 };
}

/**
 * Create a session memory with N summary entries, covering turns [0, N*batchSize).
 */
export function makeMemoryWithEntries(
  count: number,
  batchSize: number = 5,
  quality: "llm" | "deterministic" = "llm",
): SessionMemory {
  const entries: SessionMemoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * batchSize;
    const end = start + batchSize - 1;
    entries.push({
      turnRange: [start, end],
      summary: `Summary of turns ${start}-${end}: user asked about topic ${i}, assistant performed ${i + 1} tool calls.`,
      generatedBy: quality === "llm" ? "google/gemini-3-flash-preview" : "deterministic-fallback",
      generatedAt: Date.now() - (count - i) * 60_000,
      quality,
    });
  }
  return {
    entries,
    lastSummarizedTurn: count * batchSize - 1,
  };
}

// ---------- Conversation builders ----------

/**
 * Build a realistic conversation with N user turns.
 * Each user turn generates: user message → assistant message → tool call → tool result → assistant follow-up.
 * This mimics the production pattern where the agent uses tools heavily.
 */
export function buildConversation(userTurns: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < userTurns; i++) {
    messages.push(makeUser(`User question ${i}: What is the status of item ${i}?`));
    messages.push(
      makeAssistant(`Let me check item ${i}.`, {
        thinking: `I need to look up item ${i} in the database.`,
        toolCalls: [{ toolName: "read", args: `{"path": "items/${i}.json"}` }],
      }),
    );
    messages.push(
      makeToolResult(
        "read",
        `{"id": ${i}, "status": "active", "updated": "2026-02-09"}`,
        `tc-${i}`,
      ),
    );
    messages.push(makeAssistant(`Item ${i} is active and was last updated on Feb 9, 2026.`));
  }
  return messages;
}

// ---------- Fixture loader ----------

/**
 * Load a JSONL session fixture and extract messages.
 * Returns only `type: "message"` entries, with the message payload extracted.
 */
export function loadSessionFixture(fixturePath: string): AgentMessage[] {
  const resolvedPath = path.isAbsolute(fixturePath)
    ? fixturePath
    : path.resolve(__dirname, "../../../test/fixtures", fixturePath);

  const lines = fs.readFileSync(resolvedPath, "utf-8").trim().split("\n");
  const messages: AgentMessage[] = [];

  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message as AgentMessage);
    }
  }

  return messages;
}

/**
 * Render a session memory as a plain text string (for testing injection).
 */
export function renderMemoryForTest(memory: SessionMemory): string {
  if (memory.entries.length === 0) return "";
  const lines = memory.entries.map(
    (e) => `[Turns ${e.turnRange[0]}-${e.turnRange[1]}] ${e.summary}`,
  );
  return lines.join("\n");
}
