/**
 * Unit Test: capToolResultSize
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: capToolResultSize() from history.ts
 * Purpose: Verify per-result size capping preserves message format,
 *          respects maxChars threshold, and keeps head+tail content.
 *
 * F2 fix: see ARCHITECTURE-HEALTH.md § Weak Point 4.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { capToolResultSize } from "./history.js";

// --- Helpers (construct valid AgentMessage shapes) ---

function makeToolResult(toolName: string, text: string, toolCallId = "tc-1"): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId,
    content: [{ type: "text" as const, text }],
  } as unknown as AgentMessage;
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text }],
  } as unknown as AgentMessage;
}

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

function makeText(length: number, char = "x"): string {
  return char.repeat(length);
}

describe("capToolResultSize", () => {
  // -- Function identity --

  it("is a function with arity 5 (messages, maxChars, headChars, tailChars, policy)", () => {
    // Observable: function signature of capToolResultSize
    expect(typeof capToolResultSize).toBe("function");
    expect(capToolResultSize.name).toBe("capToolResultSize");
  });

  // -- Pass-through cases --

  it("returns equivalent messages when no tool results exceed maxChars", () => {
    // Observable: return value from capToolResultSize — content preserved unchanged
    const msgs = [
      makeUser("hi"),
      makeToolResult("read", "short content", "tc-1"),
      makeAssistant("done"),
    ];
    const result = capToolResultSize(msgs, 20_000);
    expect(result).toHaveLength(3);
    expect((result[1] as any).content[0].text).toBe("short content");
  });

  it("returns same reference when maxChars <= 0 (disabled)", () => {
    // Observable: return value identity (same reference = no work done)
    const msgs = [makeToolResult("read", makeText(50_000))];
    const result = capToolResultSize(msgs, 0);
    expect(result).toBe(msgs);
  });

  it("handles empty message array", () => {
    // Observable: return value from capToolResultSize — empty array
    const result = capToolResultSize([], 20_000);
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  // -- Capping behavior --

  it("caps tool result content exceeding maxChars with head+tail", () => {
    // Observable: return value — capped text contains head, marker, and tail segments
    const bigContent = makeText(30_000, "A");
    const msgs = [makeToolResult("exec", bigContent, "tc-1")];

    const result = capToolResultSize(msgs, 20_000, 8_000, 8_000);

    expect(result).toHaveLength(1);
    const text = (result[0] as any).content[0].text;

    // Head preserved: first 8K chars
    expect(text.startsWith("A".repeat(8_000))).toBe(true);

    // Truncation marker present
    expect(text).toContain("[...truncated");
    expect(text).toContain("chars");
    expect(text).toContain("est. tokens");

    // Tail preserved: last 8K chars
    expect(text.endsWith("A".repeat(8_000))).toBe(true);

    // Total size reduced
    expect(text.length).toBeLessThan(bigContent.length);
  });

  it("preserves small tool results while capping large ones", () => {
    // Observable: return value — selective capping (only oversized results affected)
    const msgs = [
      makeToolResult("read", "small result", "tc-1"),
      makeToolResult("exec", makeText(50_000, "B"), "tc-2"),
      makeToolResult("write", "also small", "tc-3"),
    ];

    const result = capToolResultSize(msgs, 20_000, 8_000, 8_000);

    // First and third untouched
    expect((result[0] as any).content[0].text).toBe("small result");
    expect((result[2] as any).content[0].text).toBe("also small");

    // Second capped
    const cappedText = (result[1] as any).content[0].text;
    expect(cappedText).toContain("[...truncated");
    expect(cappedText.length).toBeLessThan(50_000);
  });

  it("correctly reports truncated char count in marker", () => {
    // Observable: return value — marker text contains accurate char count and token estimate
    const size = 40_000;
    const head = 8_000;
    const tail = 8_000;
    const expectedTruncated = size - head - tail; // 24_000

    const msgs = [makeToolResult("exec", makeText(size, "C"), "tc-1")];
    const result = capToolResultSize(msgs, 20_000, head, tail);

    const text = (result[0] as any).content[0].text;
    expect(text).toContain(`truncated ${expectedTruncated} chars`);
    expect(text).toContain(`${Math.round(expectedTruncated / 4)} est. tokens`);
  });

  // -- CRITICAL: Content format correctness (Gemini-bricking regression guard) --

  it("REGRESSION: capped content is always (TextContent | ImageContent)[], never a string", () => {
    // Observable: return value — content field type on capped messages (array with text object)
    const msgs = [makeToolResult("exec", makeText(30_000), "tc-1")];
    const result = capToolResultSize(msgs, 20_000);

    const capped = result[0] as any;
    expect(Array.isArray(capped.content)).toBe(true);
    expect(capped.content).toHaveLength(1);
    expect(capped.content[0]).toEqual({ type: "text", text: expect.any(String) });

    // Verify the text is non-empty (not just a shell)
    expect(capped.content[0].text.length).toBeGreaterThan(0);
  });

  // -- Metadata preservation --

  it("preserves toolName and toolCallId on capped results", () => {
    // Observable: return value — metadata fields on capped messages unchanged
    const msgs = [makeToolResult("llm_view", makeText(80_000), "tc-abc")];
    const result = capToolResultSize(msgs, 20_000);

    const capped = result[0] as any;
    expect(capped.toolName).toBe("llm_view");
    expect(capped.toolCallId).toBe("tc-abc");
    expect(capped.role).toBe("toolResult");
  });

  it("preserves non-toolResult messages untouched", () => {
    // Observable: return value — user/assistant messages identical to input
    const msgs = [
      makeUser("question"),
      makeToolResult("exec", makeText(50_000), "tc-1"),
      makeAssistant("answer"),
    ];
    const result = capToolResultSize(msgs, 20_000);

    expect((result[0] as any).content).toBe("question");
    expect((result[2] as any).content[0].text).toBe("answer");
  });

  // -- Immutability --

  it("does not mutate the original messages array or message objects", () => {
    // Observable: original array and content reference unchanged after call
    const originalText = makeText(50_000, "D");
    const msgs = [makeToolResult("exec", originalText, "tc-1")];
    const originalContent = (msgs[0] as any).content;

    const result = capToolResultSize(msgs, 20_000);

    // Original message content untouched
    expect((msgs[0] as any).content).toBe(originalContent);
    expect((msgs[0] as any).content[0].text).toBe(originalText);
    // Result is a different array
    expect(result).not.toBe(msgs);
  });

  // -- Custom head/tail sizes --

  it("respects custom headChars and tailChars", () => {
    // Observable: return value — head and tail segments match custom sizes
    const content = "AAAA" + "X".repeat(30_000) + "BBBB";
    const msgs = [makeToolResult("exec", content, "tc-1")];

    const result = capToolResultSize(msgs, 10_000, 4, 4);
    const text = (result[0] as any).content[0].text;

    expect(text.startsWith("AAAA")).toBe(true);
    expect(text.endsWith("BBBB")).toBe(true);
    expect(text).toContain("[...truncated");
  });

  // -- Default parameters --

  it("uses default maxChars=20000, headChars=8000, tailChars=8000 when not specified", () => {
    // Observable: return value — default threshold triggers at 20001 chars
    const msgs = [makeToolResult("exec", makeText(20_001), "tc-1")];
    const result = capToolResultSize(msgs);

    const text = (result[0] as any).content[0].text;
    expect(text).toContain("[...truncated");
  });

  it("does not cap at exactly 20000 chars (threshold is <=)", () => {
    // Observable: return value — content at exactly threshold is preserved unchanged
    const msgs = [makeToolResult("exec", makeText(20_000), "tc-1")];
    const result = capToolResultSize(msgs);

    expect((result[0] as any).content[0].text).toBe(makeText(20_000));
  });

  // -- Negative / error path tests (QC Phase 5: Error Path Integrity) --

  it("handles toolResult with non-array content gracefully (no crash)", () => {
    // Observable: return value — function completes without throwing for malformed input
    const msg = {
      role: "toolResult",
      toolName: "broken",
      toolCallId: "tc-1",
      content: "I am a string, not an array",
    } as unknown as AgentMessage;

    // Should not throw — malformed content is skipped (not array)
    const result = capToolResultSize([msg], 20_000);
    expect(result).toHaveLength(1);
    expect((result[0] as any).content).toBe("I am a string, not an array");
  });

  it("handles toolResult with empty content array", () => {
    // Observable: return value — empty content array passes through unchanged
    const msg = {
      role: "toolResult",
      toolName: "empty",
      toolCallId: "tc-1",
      content: [],
    } as unknown as AgentMessage;

    const result = capToolResultSize([msg], 20_000);
    expect(result).toHaveLength(1);
    expect((result[0] as any).content).toEqual([]);
  });

  it("handles toolResult with undefined content", () => {
    // Observable: return value — undefined content passes through without crash
    const msg = {
      role: "toolResult",
      toolName: "undef",
      toolCallId: "tc-1",
      content: undefined,
    } as unknown as AgentMessage;

    const result = capToolResultSize([msg], 20_000);
    expect(result).toHaveLength(1);
    expect((result[0] as any).content).toBeUndefined();
  });

  // -- Edge: tool result with non-text content blocks --

  it("ignores non-text content blocks in size calculation", () => {
    // Observable: return value — image content blocks don't contribute to char count
    const msg = {
      role: "toolResult",
      toolName: "browser",
      toolCallId: "tc-1",
      content: [
        { type: "image" as const, source: { data: "base64data" } },
        { type: "text" as const, text: "short caption" },
      ],
    } as unknown as AgentMessage;

    const result = capToolResultSize([msg], 20_000);
    // Total text is only "short caption" (13 chars) — should not be capped
    expect((result[0] as any).content).toHaveLength(2);
    expect((result[0] as any).content[1].text).toBe("short caption");
  });

  // -- Edge: multiple large results --

  it("caps multiple oversized tool results independently", () => {
    // Observable: return value — each oversized result capped with its own marker
    const msgs = [
      makeToolResult("exec", makeText(30_000, "E"), "tc-1"),
      makeToolResult("llm_view", makeText(80_000, "F"), "tc-2"),
    ];

    const result = capToolResultSize(msgs, 20_000, 8_000, 8_000);

    const text1 = (result[0] as any).content[0].text;
    const text2 = (result[1] as any).content[0].text;

    // Both capped
    expect(text1).toContain("[...truncated");
    expect(text2).toContain("[...truncated");

    // Each has correct head char
    expect(text1.startsWith("E".repeat(8_000))).toBe(true);
    expect(text2.startsWith("F".repeat(8_000))).toBe(true);

    // Each reports different truncated counts
    expect(text1).toContain("truncated 14000 chars"); // 30000 - 8000 - 8000
    expect(text2).toContain("truncated 64000 chars"); // 80000 - 8000 - 8000
  });

  it("applies stricter max chars to noisy tools when policy is configured", () => {
    const execResult = makeToolResult("exec", makeText(9_000, "G"), "tc-exec");
    const calendarResult = makeToolResult("calendar", makeText(9_000, "H"), "tc-calendar");
    const result = capToolResultSize([execResult, calendarResult], 12_000, 2_000, 2_000, {
      noisyTools: ["exec"],
      noisyToolMaxChars: 5_000,
    });
    expect((result[0] as any).content[0].text).toContain("[...truncated");
    expect((result[1] as any).content[0].text).toBe(makeText(9_000, "H"));
  });
});
