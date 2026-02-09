import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Unit Test: memory-companion-fallback
 *
 * Protocol: TEST-UNIT v1.0.0
 * SUT: deterministicSummary from memory-companion-fallback.ts
 *
 * Purpose: Verify zero-LLM deterministic summary extraction from conversation turns.
 */
import { describe, expect, it } from "vitest";
import { deterministicSummary } from "./memory-companion-fallback.js";
import {
  makeUser,
  makeAssistant,
  makeToolResult,
  buildConversation,
} from "./test-helpers/memory-companion-fixtures.js";

// ─── Basic extraction ────────────────────────────────────────────────────────

describe("deterministicSummary", () => {
  it("extracts structured summary from 5 user+assistant turns", () => {
    const messages = buildConversation(5);
    const result = deterministicSummary(messages);

    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.quality).toBe("deterministic");
    // Should have some structured sections
    expect(result.summary).toMatch(/USER|TOOL|FILE|DECISION/i);
  });

  it("captures user messages in user-only turns", () => {
    const messages: AgentMessage[] = [
      makeUser("Please fix the login bug"),
      makeUser("Also update the README"),
      makeUser("And deploy to staging"),
    ];
    const result = deterministicSummary(messages);
    expect(result.summary).toContain("login bug");
    expect(result.summary).toContain("README");
    expect(result.summary).toContain("staging");
  });

  it("lists all unique tool names from tool-heavy turns", () => {
    const messages: AgentMessage[] = [
      makeUser("Check the files"),
      makeAssistant("Checking...", {
        toolCalls: [
          { toolName: "read", args: '{"path":"a.ts"}' },
          { toolName: "exec", args: '{"cmd":"ls"}' },
        ],
      }),
      makeToolResult("read", "file contents"),
      makeToolResult("exec", "listing"),
      makeUser("Now search for it"),
      makeAssistant("Searching...", {
        toolCalls: [
          { toolName: "web_search", args: '{"q":"test"}' },
          { toolName: "read", args: '{"path":"b.ts"}' },
        ],
      }),
      makeToolResult("web_search", "results"),
      makeToolResult("read", "more contents"),
    ];
    const result = deterministicSummary(messages);
    expect(result.summary).toContain("read");
    expect(result.summary).toContain("exec");
    expect(result.summary).toContain("web_search");
  });

  it("returns empty summary for empty batch", () => {
    const result = deterministicSummary([]);
    expect(result.summary).toBe("");
    expect(result.quality).toBe("deterministic");
  });

  it("handles large batch (50 turns) efficiently", () => {
    const messages = buildConversation(50);
    const start = Date.now();
    const result = deterministicSummary(messages);
    const elapsed = Date.now() - start;

    expect(result.summary.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500); // Should be fast (no LLM)
  });

  it("extracts file paths from messages", () => {
    const messages: AgentMessage[] = [
      makeUser("Edit /Users/basecamp/openclaw/src/agents/history.ts"),
      makeAssistant("I updated /Users/basecamp/openclaw/src/config/io.ts and also /tmp/test.log"),
    ];
    const result = deterministicSummary(messages);
    expect(result.summary).toContain("history.ts");
    expect(result.summary).toContain("io.ts");
  });

  it("extracts decision sentences", () => {
    const messages: AgentMessage[] = [
      makeUser("What should we do about the auth system?"),
      makeAssistant(
        "We decided to use JWT instead of sessions. We rejected cookie-based auth because it doesn't work with the mobile API.",
      ),
      makeUser("OK, proceed"),
      makeAssistant(
        "I chose to implement the token refresh flow first since it's the most critical path.",
      ),
    ];
    const result = deterministicSummary(messages);
    expect(result.summary).toMatch(/decid|reject|chose/i);
    expect(result.summary).toContain("JWT");
  });
});
