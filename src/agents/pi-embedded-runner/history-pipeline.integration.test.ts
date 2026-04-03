/**
 * Contract Test: History Pipeline Chain
 *
 * Protocol: TEST-CONTRACT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: getSessionHistoryLimitFromSessionKey(), limitHistoryTurns(), limitToolResults() from history.ts
 * Contract source: attempt.ts pipeline (lines 574-582) — the same chain that runs before every prompt.
 *
 * Purpose: Verify the full history processing chain produces valid message formats.
 * This catches the class of bug where limitToolResults corrupts toolResult.content
 * (e.g., setting it to a string instead of (TextContent | ImageContent)[]),
 * which causes Gemini to silently produce zero output.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getSessionHistoryLimitFromSessionKey,
  limitHistoryTurns,
  limitToolResults,
} from "./history.js";

// --- Test helpers (construct valid AgentMessage shapes) ---

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
    content: [{ type: "toolCall" as const, toolCallId, toolName, arguments: {} }],
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
 * Validates that all toolResult messages have correct content format.
 * Mirrors the runtime validation in attempt.ts (post-pipeline guard).
 */
function validateToolResultFormats(messages: AgentMessage[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "toolResult") continue;
    const content = (m as any).content;
    if (!Array.isArray(content)) {
      errors.push(
        `index ${i}: content is ${typeof content}, expected array (toolName=${(m as any).toolName})`,
      );
      continue;
    }
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      if (!block || typeof block !== "object") {
        errors.push(`index ${i}: content[${j}] is not an object`);
      } else if (block.type !== "text" && block.type !== "image") {
        errors.push(
          `index ${i}: content[${j}].type is "${block.type}", expected "text" or "image"`,
        );
      }
    }
  }
  return errors;
}

// --- Pipeline runner (mirrors attempt.ts lines 574-582) ---

function runPipeline(
  messages: AgentMessage[],
  sessionKey: string,
  config: OpenClawConfig = {} as OpenClawConfig,
  keepLastTools = 3,
): AgentMessage[] {
  const historyLimit = getSessionHistoryLimitFromSessionKey(sessionKey, config);
  const limited = limitHistoryTurns(messages, historyLimit);
  return limitToolResults(limited, keepLastTools);
}

// --- Tests ---

describe("history pipeline contract", () => {
  it("full chain produces valid message format for a 10-turn webchat session", () => {
    // Observable: return value from pipeline — validateToolResultFormats returns zero errors
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUser(`question ${i}`));
      messages.push(makeToolCall("read", `tc-${i}`));
      messages.push(makeToolResult("read", `file content ${i} `.repeat(100), `tc-${i}`));
      messages.push(makeAssistant(`answer ${i}`));
    }

    const result = runPipeline(messages, "agent:main:webchat:session:test123");
    const errors = validateToolResultFormats(result);
    expect(errors).toEqual([]);

    // Verify truncation counts (10 tool results, keep 3 → 7 truncated)
    const toolResults = result.filter((m) => m.role === "toolResult");
    const intact = toolResults.filter(
      (m) => (m as any).content[0]?.text !== "[Old tool result cleared to save context]",
    );
    expect(intact).toHaveLength(3);
    expect(toolResults.length - intact.length).toBe(7);
  });

  it("webchat sessions get history-limited (80 turns) then tool-limited", () => {
    // Observable: getSessionHistoryLimitFromSessionKey returns a webchat safety limit;
    //             limitHistoryTurns reduces user turns; pipeline output is valid
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(makeUser(`turn ${i}`));
      messages.push(makeToolCall("exec", `tc-${i}`));
      messages.push(makeToolResult("exec", `output ${i}`, `tc-${i}`));
      messages.push(makeAssistant(`response ${i}`));
    }

    const result = runPipeline(messages, "agent:main:webchat:session:abc");

    // History limit applied: user turns capped
    const userCount = result.filter((m) => m.role === "user").length;
    expect(userCount).toBeLessThanOrEqual(80);
    expect(userCount).toBeGreaterThan(0);

    // Format still valid after both limits applied
    expect(validateToolResultFormats(result)).toEqual([]);
  });

  it("non-webchat main sessions skip history limit but get tool-limited", () => {
    // Observable: getSessionHistoryLimitFromSessionKey returns undefined for agent:main:main;
    //             all messages preserved; tool results truncated
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUser(`turn ${i}`));
      messages.push(makeToolResult("read", `content ${i}`, `tc-${i}`));
      messages.push(makeAssistant(`reply ${i}`));
    }

    const result = runPipeline(messages, "agent:main:main");

    // No history limiting — all messages preserved
    expect(result).toHaveLength(messages.length);

    // Tool limiting applied — 7 of 10 truncated
    const truncated = result.filter(
      (m) =>
        m.role === "toolResult" &&
        (m as any).content[0]?.text === "[Old tool result cleared to save context]",
    );
    expect(truncated).toHaveLength(7);

    // Format valid
    expect(validateToolResultFormats(result)).toEqual([]);
  });

  it("telegram topic sessions inherit provider group historyLimit", () => {
    const config = {
      channels: {
        telegram: {
          historyLimit: 5,
        },
      },
    } as OpenClawConfig;
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(makeUser(`turn ${i}`));
      messages.push(makeAssistant(`reply ${i}`));
    }

    const result = runPipeline(messages, "agent:main:telegram:group:-100123:topic:237", config);

    expect(result.filter((m) => m.role === "user")).toHaveLength(5);
    expect(validateToolResultFormats(result)).toEqual([]);
  });

  // -- Error detection (negative tests) --

  it("REGRESSION: detects corrupted toolResult content (string instead of array)", () => {
    // Observable: validateToolResultFormats detects the exact bug that bricked Gemini
    // This is not testing the SUT pipeline — it's testing the contract validator
    // to ensure our safety net catches format corruption from any source.
    const corrupted: AgentMessage[] = [
      makeUser("hi"),
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "tc-1",
        content: "this is a string, not an array",
      } as unknown as AgentMessage,
      makeAssistant("ok"),
    ];

    const errors = validateToolResultFormats(corrupted);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/content is string.*expected array/);
  });

  it("detects toolResult with non-object content blocks", () => {
    // Observable: validateToolResultFormats catches invalid content block types
    const badBlocks: AgentMessage[] = [
      {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "tc-1",
        content: [null, "plain string"],
      } as unknown as AgentMessage,
    ];

    const errors = validateToolResultFormats(badBlocks);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/not an object/);
  });

  // -- Edge cases --

  it("handles empty tool result content gracefully", () => {
    // Observable: pipeline output — empty text content is valid format
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

    const result = runPipeline(messages, "agent:main:main");
    expect(validateToolResultFormats(result)).toEqual([]);
  });

  it("image tool results remain valid after truncation", () => {
    // Observable: pipeline output — image content blocks have valid format
    const imageResult: AgentMessage = {
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
      imageResult,
      makeAssistant("a2"),
      makeUser("q3"),
      makeToolResult("exec", "recent", "tc-3"),
      makeAssistant("a3"),
    ];

    const result = runPipeline(messages, "agent:main:main", {} as OpenClawConfig, 1);
    expect(validateToolResultFormats(result)).toEqual([]);

    // All tool results still have array content
    for (const m of result) {
      if (m.role === "toolResult") {
        expect(Array.isArray((m as any).content)).toBe(true);
      }
    }
  });
});
