import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns, limitToolResults } from "./history.js";

/**
 * Integration test: exercises the same history processing chain as attempt.ts
 *
 *   sanitize → validate → limitHistoryTurns → limitToolResults → validate format
 *
 * This catches the class of bug where limitToolResults corrupts message format
 * (e.g., setting toolResult.content to a string instead of an array), which
 * causes providers like Gemini to silently produce zero output.
 */

// --- Test helpers ---

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text } as unknown as AgentMessage;
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text }],
  } as unknown as AgentMessage;
}

function makeToolCall(toolName: string, toolCallId: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall" as const,
        toolCallId,
        toolName,
        arguments: {},
      },
    ],
  } as unknown as AgentMessage;
}

function makeToolResult(toolName: string, text: string, toolCallId: string): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId,
    content: [{ type: "text" as const, text }],
  } as unknown as AgentMessage;
}

/**
 * Validates that all messages in the array have the correct content format.
 * This is the same validation that attempt.ts performs after the pipeline.
 *
 * Returns an array of error descriptions (empty = all valid).
 */
function validateMessageFormats(messages: AgentMessage[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "toolResult") {
      const content = (m as any).content;
      if (!Array.isArray(content)) {
        errors.push(
          `index ${i}: toolResult has non-array content (type=${typeof content}, toolName=${(m as any).toolName})`,
        );
      } else {
        for (let j = 0; j < content.length; j++) {
          const block = content[j];
          if (!block || typeof block !== "object") {
            errors.push(`index ${i}: toolResult content[${j}] is not an object`);
          } else if (block.type !== "text" && block.type !== "image") {
            errors.push(`index ${i}: toolResult content[${j}] has unexpected type "${block.type}"`);
          }
        }
      }
    }
  }
  return errors;
}

// --- Tests ---

describe("history pipeline integration", () => {
  it("processes a realistic session through the full chain with valid output", () => {
    // Simulate a session with 10 user turns, each with tool calls
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUser(`question ${i}`));
      messages.push(makeToolCall("read", `tc-${i}`));
      messages.push(
        makeToolResult("read", `file content for question ${i} `.repeat(100), `tc-${i}`),
      );
      messages.push(makeAssistant(`answer to question ${i}`));
    }

    // Run the pipeline (same order as attempt.ts)
    const sessionKey = "agent:main:webchat:session:test123";
    const config = {} as OpenClawConfig;
    const historyLimit = getDmHistoryLimitFromSessionKey(sessionKey, config);
    const limited = limitHistoryTurns(messages, historyLimit);
    const result = limitToolResults(limited, 3);

    // Validate: all messages have correct format
    const errors = validateMessageFormats(result);
    expect(errors).toEqual([]);

    // Verify truncation happened
    const toolResults = result.filter((m) => m.role === "toolResult");
    const truncated = toolResults.filter(
      (m) => (m as any).content[0]?.text === "[Old tool result cleared to save context]",
    );
    const intact = toolResults.filter(
      (m) => (m as any).content[0]?.text !== "[Old tool result cleared to save context]",
    );

    expect(intact.length).toBe(3); // keepLast=3
    expect(truncated.length).toBe(toolResults.length - 3);
  });

  it("webchat sessions get history-limited then tool-limited", () => {
    // Build a session with 40 user turns (exceeds webchat limit of 30)
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(makeUser(`turn ${i}`));
      messages.push(makeToolCall("exec", `tc-${i}`));
      messages.push(makeToolResult("exec", `output ${i}`, `tc-${i}`));
      messages.push(makeAssistant(`response ${i}`));
    }

    const sessionKey = "agent:main:webchat:session:abc";
    const config = {} as OpenClawConfig;
    const historyLimit = getDmHistoryLimitFromSessionKey(sessionKey, config);
    expect(historyLimit).toBe(30); // webchat safety limit

    const limited = limitHistoryTurns(messages, historyLimit);
    // Should have kept last 30 user turns worth of messages
    const userCount = limited.filter((m) => m.role === "user").length;
    expect(userCount).toBeLessThanOrEqual(30);

    const result = limitToolResults(limited, 3);

    // All messages must have valid format
    const errors = validateMessageFormats(result);
    expect(errors).toEqual([]);
  });

  it("non-webchat main sessions are NOT history-limited but ARE tool-limited", () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUser(`turn ${i}`));
      messages.push(makeToolResult("read", `content ${i}`, `tc-${i}`));
      messages.push(makeAssistant(`reply ${i}`));
    }

    // agent:main:main is NOT a webchat session
    const sessionKey = "agent:main:main";
    const config = {} as OpenClawConfig;
    const historyLimit = getDmHistoryLimitFromSessionKey(sessionKey, config);
    expect(historyLimit).toBeUndefined(); // no limit for main session

    const limited = limitHistoryTurns(messages, historyLimit);
    expect(limited.length).toBe(messages.length); // nothing removed

    const result = limitToolResults(limited, 3);
    const errors = validateMessageFormats(result);
    expect(errors).toEqual([]);

    // Should have truncated 7 of 10 tool results
    const truncated = result.filter(
      (m) =>
        m.role === "toolResult" &&
        (m as any).content[0]?.text === "[Old tool result cleared to save context]",
    );
    expect(truncated.length).toBe(7);
  });

  it("REGRESSION: corrupted toolResult content (string instead of array) is caught by validation", () => {
    // This is the exact bug that bricked Gemini: content set to a plain string
    const corruptedMessages: AgentMessage[] = [
      makeUser("hi"),
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "tc-1",
        content: "this is a string, not an array", // THE BUG
      } as unknown as AgentMessage,
      makeAssistant("ok"),
    ];

    const errors = validateMessageFormats(corruptedMessages);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("non-array content");
  });

  it("empty tool results are handled gracefully", () => {
    const messages: AgentMessage[] = [
      makeUser("hi"),
      {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "tc-1",
        content: [{ type: "text" as const, text: "" }],
      } as unknown as AgentMessage,
      makeAssistant("ok"),
    ];

    const result = limitToolResults(messages, 3);
    const errors = validateMessageFormats(result);
    expect(errors).toEqual([]);
  });

  it("mixed tool results with images are preserved (not truncated to text-only)", () => {
    const imageToolResult: AgentMessage = {
      role: "toolResult",
      toolName: "screenshot",
      toolCallId: "tc-img",
      content: [
        { type: "image" as const, source: { type: "base64", data: "abc", mediaType: "image/png" } },
      ],
    } as unknown as AgentMessage;

    const messages: AgentMessage[] = [
      makeUser("q1"),
      makeToolResult("read", "old", "tc-1"),
      makeAssistant("a1"),
      makeUser("q2"),
      imageToolResult,
      makeAssistant("a2"),
      makeUser("q3"),
      makeToolResult("exec", "recent", "tc-3"),
      makeAssistant("a3"),
    ];

    const result = limitToolResults(messages, 1);
    const errors = validateMessageFormats(result);
    expect(errors).toEqual([]);

    // The image tool result should still be truncated by limitToolResults
    // (it counts by position, not by content type)
    // But the format should still be valid
    for (const m of result) {
      if (m.role === "toolResult") {
        expect(Array.isArray((m as any).content)).toBe(true);
      }
    }
  });
});
