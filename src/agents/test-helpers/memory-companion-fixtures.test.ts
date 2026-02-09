/**
 * Unit Test: memory-companion-fixtures
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC: TEST-QA-PASSING-FAILURE v1.0.0
 * SUT: Test helper factories from memory-companion-fixtures.ts
 * Purpose: Verify helpers produce valid AgentMessage shapes and memory structures.
 */
import { describe, expect, it } from "vitest";
import {
  buildConversation,
  loadSessionFixture,
  makeAssistant,
  makeEmptyMemory,
  makeMemoryMessage,
  makeMemoryWithEntries,
  makeToolResult,
  makeUser,
  renderMemoryForTest,
} from "./memory-companion-fixtures.js";

describe("memory-companion-fixtures", () => {
  describe("makeUser", () => {
    it("creates a user message with correct role and content", () => {
      // Observable: return value from makeUser
      const msg = makeUser("hello");
      expect(msg.role).toBe("user");
      expect((msg as any).content).toBe("hello");
    });
  });

  describe("makeAssistant", () => {
    it("creates an assistant message with text content", () => {
      // Observable: return value from makeAssistant
      const msg = makeAssistant("response text");
      expect(msg.role).toBe("assistant");
      expect(Array.isArray((msg as any).content)).toBe(true);
      expect((msg as any).content[0]).toEqual({ type: "text", text: "response text" });
    });

    it("includes thinking and tool call blocks when specified", () => {
      // Observable: return value — content array includes all block types
      const msg = makeAssistant("text", {
        thinking: "reasoning",
        toolCalls: [{ toolName: "read", args: '{"path": "file.txt"}' }],
      });
      const content = (msg as any).content;
      expect(content).toHaveLength(3);
      expect(content[0].type).toBe("thinking");
      expect(content[1].type).toBe("text");
      expect(content[2].type).toBe("toolCall");
    });
  });

  describe("makeToolResult", () => {
    it("creates a toolResult with array content (Gemini-safe)", () => {
      // Observable: return value — content is array, not string
      const msg = makeToolResult("read", "file contents", "tc-123");
      expect(msg.role).toBe("toolResult");
      expect((msg as any).toolName).toBe("read");
      expect((msg as any).toolCallId).toBe("tc-123");
      expect(Array.isArray((msg as any).content)).toBe(true);
      expect((msg as any).content[0]).toEqual({ type: "text", text: "file contents" });
    });
  });

  describe("makeMemoryMessage", () => {
    it("creates a user message with memory markers", () => {
      // Observable: return value — contains SESSION MEMORY markers
      const msg = makeMemoryMessage("Summary of conversation");
      expect(msg.role).toBe("user");
      expect((msg as any).content).toContain("[SESSION MEMORY");
      expect((msg as any).content).toContain("Summary of conversation");
      expect((msg as any).content).toContain("[END SESSION MEMORY]");
    });
  });

  describe("makeEmptyMemory", () => {
    it("returns memory with empty entries and -1 lastSummarizedTurn", () => {
      // Observable: return value — empty memory structure
      const mem = makeEmptyMemory();
      expect(mem.entries).toEqual([]);
      expect(mem.lastSummarizedTurn).toBe(-1);
    });
  });

  describe("makeMemoryWithEntries", () => {
    it("creates N entries covering correct turn ranges", () => {
      // Observable: return value — entry count, turn ranges, and lastSummarizedTurn
      const mem = makeMemoryWithEntries(3, 5);
      expect(mem.entries).toHaveLength(3);
      expect(mem.entries[0].turnRange).toEqual([0, 4]);
      expect(mem.entries[1].turnRange).toEqual([5, 9]);
      expect(mem.entries[2].turnRange).toEqual([10, 14]);
      expect(mem.lastSummarizedTurn).toBe(14);
    });

    it("respects quality parameter", () => {
      // Observable: return value — quality field on entries
      const mem = makeMemoryWithEntries(2, 5, "deterministic");
      expect(mem.entries[0].quality).toBe("deterministic");
      expect(mem.entries[0].generatedBy).toContain("deterministic");
    });
  });

  describe("buildConversation", () => {
    it("creates 4 messages per user turn (user, assistant+tool, toolResult, assistant)", () => {
      // Observable: return value — message count and role pattern
      const conv = buildConversation(3);
      expect(conv).toHaveLength(12); // 3 turns * 4 messages
      expect(conv[0].role).toBe("user");
      expect(conv[1].role).toBe("assistant");
      expect(conv[2].role).toBe("toolResult");
      expect(conv[3].role).toBe("assistant");
    });
  });

  describe("loadSessionFixture", () => {
    it("loads the 200-turn fixture and extracts messages", () => {
      // Observable: return value — non-empty array of messages with valid roles
      const messages = loadSessionFixture("de678658-200turns.jsonl");
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.length).toBe(200);
      for (const msg of messages) {
        expect(["user", "assistant", "toolResult"]).toContain(msg.role);
      }
    });
  });

  describe("renderMemoryForTest", () => {
    it("renders entries as readable text", () => {
      // Observable: return value — formatted string with turn ranges and summaries
      const mem = makeMemoryWithEntries(2, 5);
      const text = renderMemoryForTest(mem);
      expect(text).toContain("[Turns 0-4]");
      expect(text).toContain("[Turns 5-9]");
      expect(text).toContain("Summary of turns");
    });

    it("returns empty string for empty memory", () => {
      // Observable: return value — empty string
      const text = renderMemoryForTest(makeEmptyMemory());
      expect(text).toBe("");
    });
  });
});
