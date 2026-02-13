/**
 * Unit Test: fitToTokenBudget + deriveContextLimits
 *
 * Protocol: TEST-UNIT v1.0.0
 * SUT: fitToTokenBudget(), deriveContextLimits() from token-budget.ts
 * Purpose: Verify token budget gate progressively sheds context to fit model context window,
 *          and deriveContextLimits returns appropriate limits for different model sizes.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { deriveContextLimits, fitToTokenBudget } from "./token-budget.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeToolResult(text: string, toolName = "exec", toolCallId = "tc-1"): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** Generate a string of approximately N tokens (at ~4 chars/token). */
function textOfTokens(approxTokens: number): string {
  return "x".repeat(approxTokens * 4);
}

// ─── fitToTokenBudget ───────────────────────────────────────────────────────

describe("fitToTokenBudget", () => {
  // -- Pass-through when under budget --

  it("returns messages unchanged when under budget", () => {
    const msgs = [makeUser("hello"), makeAssistant("hi there")];
    const result = fitToTokenBudget(msgs, 128_000);
    expect(result.messages).toBe(msgs); // same reference = no work
    expect(result.actions).toHaveLength(0);
    expect(result.shouldCompact).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.budgetTokens).toBeLessThanOrEqual(128_000);
  });

  it("subtracts output reserve from budget", () => {
    const msgs = [makeUser("hello")];
    const defaultReserve = fitToTokenBudget(msgs, 10_000);
    const customReserve = fitToTokenBudget(msgs, 10_000, { outputReserveTokens: 8000 });
    expect(defaultReserve.budgetTokens).toBeGreaterThan(customReserve.budgetTokens);
  });

  it("subtracts system prompt tokens from budget", () => {
    const msgs = [makeUser("hello")];
    const noSys = fitToTokenBudget(msgs, 10_000);
    const withSys = fitToTokenBudget(msgs, 10_000, { systemPromptTokens: 2000 });
    expect(noSys.budgetTokens).toBeGreaterThan(withSys.budgetTokens);
  });

  // -- Tool result size shedding --

  it("recaps large tool results when over budget", () => {
    // Create a session with a large tool result that exceeds a small budget
    const largeResult = makeToolResult(textOfTokens(8000), "exec", "tc-big");
    const msgs = [makeUser("do it"), makeAssistant("calling exec"), largeResult];
    const result = fitToTokenBudget(msgs, 12_000); // tight budget
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.some((a) => a.includes("recapped"))).toBe(true);
    expect(result.shouldCompact).toBe(false);
  });

  // -- Tool result count shedding --

  it("reduces kept tool results when size caps are not enough", () => {
    // Many medium tool results
    const msgs: AgentMessage[] = [makeUser("go")];
    for (let i = 0; i < 15; i++) {
      msgs.push(makeAssistant(`call ${i}`));
      msgs.push(makeToolResult(textOfTokens(1500), "exec", `tc-${i}`));
    }
    // Budget that can't hold all 15 results even after recapping
    const result = fitToTokenBudget(msgs, 16_000);
    expect(result.actions.some((a) => a.includes("reduced kept tool results"))).toBe(true);
  });

  // -- Oldest message dropping --

  it("drops oldest messages when tool shedding is insufficient", () => {
    // Many user/assistant turns with moderate content
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(makeUser(`turn ${i}: ${textOfTokens(200)}`));
      msgs.push(makeAssistant(`reply ${i}: ${textOfTokens(200)}`));
    }
    // Very tight budget — can't keep all 100 messages
    const result = fitToTokenBudget(msgs, 8_000);
    expect(result.actions.some((a) => a.includes("dropped"))).toBe(true);
    expect(result.messages.length).toBeLessThan(msgs.length);
    // Last user message must be preserved
    const lastUserInResult = result.messages.filter((m) => m.role === "user").pop();
    expect(lastUserInResult).toBeDefined();
  });

  it("never drops the last user message", () => {
    const msgs = [
      makeUser(`old: ${textOfTokens(5000)}`),
      makeAssistant(`old reply: ${textOfTokens(5000)}`),
      makeUser(`last message: ${textOfTokens(500)}`),
    ];
    const result = fitToTokenBudget(msgs, 4_000);
    // The result must contain a user message with "last message"
    const hasLastUser = result.messages.some(
      (m) =>
        m.role === "user" && typeof m.content === "string" && m.content.includes("last message"),
    );
    expect(hasLastUser).toBe(true);
  });

  it("inserts context truncation marker when messages are dropped", () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(makeUser(`turn ${i}: ${textOfTokens(300)}`));
      msgs.push(makeAssistant(`reply ${i}: ${textOfTokens(300)}`));
    }
    const result = fitToTokenBudget(msgs, 4_000);
    if (result.actions.some((a) => a.includes("dropped"))) {
      const marker = result.messages.find(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Context truncated"),
      );
      expect(marker).toBeDefined();
    }
  });

  // -- shouldCompact flag --

  it("does not set shouldCompact when shedding succeeds", () => {
    const msgs = [makeUser("hello"), makeAssistant("hi")];
    const result = fitToTokenBudget(msgs, 128_000);
    expect(result.shouldCompact).toBe(false);
  });

  // -- Does not mutate input --

  it("does not mutate the input messages array", () => {
    const msgs = [
      makeUser("hello"),
      makeToolResult(textOfTokens(5000), "exec", "tc-1"),
      makeAssistant("done"),
    ];
    const original = [...msgs];
    fitToTokenBudget(msgs, 2_000);
    expect(msgs).toEqual(original);
    expect(msgs.length).toBe(original.length);
  });

  // -- Incident reproduction --

  it("handles the 957-message incident case (128K model)", () => {
    // Simulate: 1 user turn, 440 tool results, many assistant messages
    const msgs: AgentMessage[] = [makeUser("start the project")];
    for (let i = 0; i < 440; i++) {
      msgs.push(makeAssistant(`step ${i}`));
      msgs.push(makeToolResult(`result ${i}: ${textOfTokens(50)}`, "exec", `tc-${i}`));
    }
    // After existing pipeline: limitToolResults(20) + capToolResultSize(20K)
    // would still be ~100K tokens. fitToTokenBudget must handle this.
    const result = fitToTokenBudget(msgs, 128_000);
    expect(result.shouldCompact).toBe(false);
    // Estimated tokens must fit within budget * safety margin
    expect(result.estimatedTokens * 1.2).toBeLessThanOrEqual(result.budgetTokens);
  });
});

// ─── deriveContextLimits ────────────────────────────────────────────────────

describe("deriveContextLimits", () => {
  it("returns tight limits for small models (≤32K)", () => {
    const limits = deriveContextLimits(32_000);
    expect(limits.historyTurns).toBeLessThanOrEqual(10);
    expect(limits.toolResultsKept).toBeLessThanOrEqual(3);
    expect(limits.toolResultMaxChars).toBeLessThanOrEqual(5_000);
  });

  it("returns moderate limits for medium models (64K)", () => {
    const limits = deriveContextLimits(64_000);
    expect(limits.historyTurns).toBeLessThanOrEqual(20);
    expect(limits.toolResultsKept).toBeLessThanOrEqual(5);
    expect(limits.toolResultMaxChars).toBeLessThanOrEqual(10_000);
  });

  it("returns standard limits for 128K models", () => {
    const limits = deriveContextLimits(128_000);
    expect(limits.historyTurns).toBeLessThanOrEqual(30);
    expect(limits.toolResultsKept).toBeLessThanOrEqual(10);
    expect(limits.toolResultMaxChars).toBeLessThanOrEqual(15_000);
  });

  it("returns generous limits for large models (200K+)", () => {
    const limits = deriveContextLimits(200_000);
    expect(limits.historyTurns).toBeGreaterThanOrEqual(50);
    expect(limits.toolResultsKept).toBeGreaterThanOrEqual(15);
    expect(limits.toolResultMaxChars).toBeGreaterThanOrEqual(20_000);
  });

  it("scales monotonically — larger window never gets tighter limits", () => {
    const small = deriveContextLimits(16_000);
    const medium = deriveContextLimits(64_000);
    const large = deriveContextLimits(200_000);
    expect(medium.historyTurns).toBeGreaterThanOrEqual(small.historyTurns);
    expect(large.historyTurns).toBeGreaterThanOrEqual(medium.historyTurns);
    expect(medium.toolResultsKept).toBeGreaterThanOrEqual(small.toolResultsKept);
    expect(large.toolResultsKept).toBeGreaterThanOrEqual(medium.toolResultsKept);
  });
});
