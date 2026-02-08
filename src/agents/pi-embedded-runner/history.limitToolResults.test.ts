/**
 * Unit Test: limitToolResults
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: limitToolResults() from history.ts
 * Purpose: Verify tool result truncation preserves message format (the Gemini-bricking bug),
 *          respects keepLast count, and does not mutate inputs.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { limitToolResults } from "./history.js";

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

const CLEARED_CONTENT = [{ type: "text", text: "[Old tool result cleared to save context]" }];

describe("limitToolResults", () => {
  // -- Function identity --

  it("is a function with arity 2 (messages, keepLast)", () => {
    // Observable: function signature
    expect(typeof limitToolResults).toBe("function");
    expect(limitToolResults.length).toBe(1); // only `messages` is required; keepLast has default
    expect(limitToolResults.name).toBe("limitToolResults");
  });

  // -- Pass-through cases --

  it("returns same reference when keepLast < 0 (disabled)", () => {
    // Observable: return value identity (same reference = no work done)
    const msgs = [makeUser("hi"), makeToolResult("read", "file content")];
    const result = limitToolResults(msgs, -1);
    expect(result).toBe(msgs);
  });

  it("returns equivalent messages when no tool results exist", () => {
    // Observable: return value from limitToolResults — all messages preserved
    const msgs = [makeUser("hi"), makeAssistant("hello")];
    const result = limitToolResults(msgs, 3);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("preserves all tool results when count <= keepLast", () => {
    // Observable: return value — content arrays unchanged for each tool result
    const msgs = [
      makeUser("hi"),
      makeToolResult("read", "content1", "tc-1"),
      makeToolResult("exec", "output2", "tc-2"),
      makeToolResult("write", "ok3", "tc-3"),
      makeAssistant("done"),
    ];
    const result = limitToolResults(msgs, 3);
    expect((result[1] as any).content[0].text).toBe("content1");
    expect((result[2] as any).content[0].text).toBe("output2");
    expect((result[3] as any).content[0].text).toBe("ok3");
  });

  // -- Truncation behavior --

  it("truncates older tool results and keeps last N intact", () => {
    // Observable: return value — older tool results have cleared content, last N preserved
    const msgs = [
      makeUser("step 1"),
      makeToolResult("read", "old content 1", "tc-1"),
      makeAssistant("got it"),
      makeUser("step 2"),
      makeToolResult("exec", "old output 2", "tc-2"),
      makeAssistant("ok"),
      makeUser("step 3"),
      makeToolResult("write", "recent result 3", "tc-3"),
      makeAssistant("done"),
    ];
    const result = limitToolResults(msgs, 1);

    // All 3 tool results still present (not removed)
    expect(result.filter((m) => m.role === "toolResult")).toHaveLength(3);

    // First two truncated to cleared placeholder
    expect((result[1] as any).content).toEqual(CLEARED_CONTENT);
    expect((result[4] as any).content).toEqual(CLEARED_CONTENT);

    // Last one preserved with original content
    expect((result[7] as any).content[0].text).toBe("recent result 3");
  });

  it("truncates everything when keepLast=0", () => {
    // Observable: return value — all tool results have cleared content
    const msgs = [makeToolResult("read", "data1", "tc-1"), makeToolResult("exec", "data2", "tc-2")];
    const result = limitToolResults(msgs, 0);

    expect(result).toHaveLength(2);
    expect((result[0] as any).content).toEqual(CLEARED_CONTENT);
    expect((result[1] as any).content).toEqual(CLEARED_CONTENT);
  });

  // -- CRITICAL: Content format correctness (the Gemini-bricking regression) --

  it("REGRESSION: truncated content is always (TextContent | ImageContent)[], never a string", () => {
    // Observable: return value — content field type on truncated messages
    // This was the exact bug that bricked Gemini: setting content to a plain string
    // caused the provider SDK to silently produce no output (11ms prompt, zero response).
    const msgs = [
      makeToolResult("read", "old data", "tc-1"),
      makeToolResult("exec", "newer data", "tc-2"),
    ];
    const result = limitToolResults(msgs, 1);

    const truncated = result[0] as any;
    expect(Array.isArray(truncated.content)).toBe(true);
    expect(truncated.content).toHaveLength(1);
    expect(truncated.content[0]).toEqual({ type: "text", text: expect.any(String) });

    // Kept message also valid
    const kept = result[1] as any;
    expect(Array.isArray(kept.content)).toBe(true);
    expect(kept.content[0].text).toBe("newer data");
  });

  // -- Metadata preservation --

  it("preserves toolName and toolCallId on truncated results", () => {
    // Observable: return value — metadata fields on truncated messages
    const msgs = [
      makeToolResult("read", "old data", "tc-abc"),
      makeToolResult("exec", "new data", "tc-def"),
    ];
    const result = limitToolResults(msgs, 1);

    const truncated = result[0] as any;
    expect(truncated.toolName).toBe("read");
    expect(truncated.toolCallId).toBe("tc-abc");
    expect(truncated.role).toBe("toolResult");
  });

  it("preserves non-toolResult messages untouched", () => {
    // Observable: return value — user/assistant messages identical to input
    const msgs = [
      makeUser("q1"),
      makeToolResult("read", "r1", "tc-1"),
      makeAssistant("a1"),
      makeUser("q2"),
      makeToolResult("exec", "r2", "tc-2"),
      makeAssistant("a2"),
    ];
    const result = limitToolResults(msgs, 1);

    expect((result[0] as any).content).toBe("q1");
    expect((result[2] as any).content[0].text).toBe("a1");
    expect((result[3] as any).content).toBe("q2");
    expect((result[5] as any).content[0].text).toBe("a2");
  });

  // -- Immutability --

  it("does not mutate the original messages array or message objects", () => {
    // Observable: original array and content reference unchanged after call
    const msgs = [makeToolResult("read", "old", "tc-1"), makeToolResult("exec", "new", "tc-2")];
    const originalContent = (msgs[0] as any).content;
    const originalText = (msgs[0] as any).content[0].text;
    const result = limitToolResults(msgs, 1);

    // Original message content untouched
    expect((msgs[0] as any).content).toBe(originalContent);
    expect((msgs[0] as any).content[0].text).toBe(originalText);
    // Result is a different array
    expect(result).not.toBe(msgs);
  });

  // -- Edge cases --

  it("handles empty message array", () => {
    // Observable: return value — empty array
    const result = limitToolResults([], 3);
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  it("uses default keepLast when not provided", () => {
    // Observable: return value — default keepLast=3 applied
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(makeToolResult("read", `content-${i}`, `tc-${i}`));
    }
    const result = limitToolResults(msgs);

    // Last 3 should be intact, first 2 truncated (default keepLast=3)
    expect((result[0] as any).content).toEqual(CLEARED_CONTENT);
    expect((result[1] as any).content).toEqual(CLEARED_CONTENT);
    expect((result[2] as any).content[0].text).toBe("content-2");
    expect((result[3] as any).content[0].text).toBe("content-3");
    expect((result[4] as any).content[0].text).toBe("content-4");
  });
});
