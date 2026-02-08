import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { limitToolResults } from "./history.js";

/**
 * Helper: create a toolResult message with proper content array format.
 */
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
  return {
    role: "user",
    content: text,
  } as unknown as AgentMessage;
}

describe("limitToolResults", () => {
  it("returns messages unchanged when keepLast < 0", () => {
    const msgs = [makeUser("hi"), makeToolResult("read", "file content")];
    const result = limitToolResults(msgs, -1);
    expect(result).toBe(msgs); // same reference
  });

  it("returns messages unchanged when no tool results exist", () => {
    const msgs = [makeUser("hi"), makeAssistant("hello")];
    const result = limitToolResults(msgs, 3);
    expect(result).toEqual(msgs);
  });

  it("returns messages unchanged when tool results <= keepLast", () => {
    const msgs = [
      makeUser("hi"),
      makeToolResult("read", "content1", "tc-1"),
      makeToolResult("exec", "output2", "tc-2"),
      makeToolResult("write", "ok3", "tc-3"),
      makeAssistant("done"),
    ];
    const result = limitToolResults(msgs, 3);
    // Content should be unchanged
    for (let i = 0; i < msgs.length; i++) {
      expect(result[i]).toEqual(msgs[i]);
    }
  });

  it("truncates older tool results when count > keepLast", () => {
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

    // Only the LAST tool result (index 7) should be kept intact
    const toolResults = result.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(3); // all still present

    // First two should be truncated
    expect((result[1] as any).content).toEqual([
      { type: "text", text: "[Old tool result cleared to save context]" },
    ]);
    expect((result[4] as any).content).toEqual([
      { type: "text", text: "[Old tool result cleared to save context]" },
    ]);

    // Last one should be intact
    expect((result[7] as any).content).toEqual([{ type: "text", text: "recent result 3" }]);
  });

  it("CRITICAL: truncated content is always an array, never a string", () => {
    const msgs = [
      makeToolResult("read", "old data", "tc-1"),
      makeToolResult("exec", "newer data", "tc-2"),
    ];
    const result = limitToolResults(msgs, 1);

    // The truncated message MUST have array content
    const truncated = result[0];
    expect(truncated.role).toBe("toolResult");
    expect(Array.isArray((truncated as any).content)).toBe(true);
    expect((truncated as any).content).toHaveLength(1);
    expect((truncated as any).content[0].type).toBe("text");
    expect(typeof (truncated as any).content[0].text).toBe("string");

    // The kept message should also still be an array
    const kept = result[1];
    expect(Array.isArray((kept as any).content)).toBe(true);
  });

  it("preserves non-toolResult messages untouched", () => {
    const msgs = [
      makeUser("q1"),
      makeToolResult("read", "r1", "tc-1"),
      makeAssistant("a1"),
      makeUser("q2"),
      makeToolResult("exec", "r2", "tc-2"),
      makeAssistant("a2"),
    ];
    const result = limitToolResults(msgs, 1);

    // User and assistant messages should be identical
    expect(result[0]).toEqual(msgs[0]);
    expect(result[2]).toEqual(msgs[2]);
    expect(result[3]).toEqual(msgs[3]);
    expect(result[5]).toEqual(msgs[5]);
  });

  it("does not mutate the original array", () => {
    const msgs = [makeToolResult("read", "old", "tc-1"), makeToolResult("exec", "new", "tc-2")];
    const originalContent = (msgs[0] as any).content;
    limitToolResults(msgs, 1);

    // Original message should be unchanged
    expect((msgs[0] as any).content).toBe(originalContent);
    expect((msgs[0] as any).content[0].text).toBe("old");
  });

  it("handles keepLast=0 (truncate everything)", () => {
    const msgs = [makeToolResult("read", "data1", "tc-1"), makeToolResult("exec", "data2", "tc-2")];
    const result = limitToolResults(msgs, 0);

    for (const m of result) {
      expect((m as any).content).toEqual([
        { type: "text", text: "[Old tool result cleared to save context]" },
      ]);
    }
  });

  it("handles empty message array", () => {
    expect(limitToolResults([], 3)).toEqual([]);
  });

  it("preserves toolName and toolCallId on truncated results", () => {
    const msgs = [
      makeToolResult("read", "old data", "tc-abc"),
      makeToolResult("exec", "new data", "tc-def"),
    ];
    const result = limitToolResults(msgs, 1);

    const truncated = result[0] as any;
    expect(truncated.toolName).toBe("read");
    expect(truncated.toolCallId).toBe("tc-abc");
  });
});
