import { describe, expect, it } from "vitest";
import { buildAgentContextShareEvent } from "./context-share-telemetry.js";

describe("agent context share telemetry", () => {
  it("computes persisted, tool, and memory shares from history messages", () => {
    const event = buildAgentContextShareEvent({
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:group:-100:topic:237",
      provider: "openai",
      modelId: "gpt-test",
      messageChannel: "telegram",
      systemPromptTokens: 20,
      memoryCompanionChars: 40,
      historyMessages: [
        { role: "user", content: "u".repeat(40) },
        { role: "assistant", content: "a".repeat(20) },
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: "tool-1",
          content: [{ type: "text", text: "t".repeat(80) }],
        },
      ],
    });

    expect(event.schema_version).toBe("agent.context-share.v1");
    expect(event.estimatedHistoryTokens).toBe(35);
    expect(event.toolResultTokens).toBe(20);
    expect(event.memoryCompanionTokens).toBe(10);
    expect(event.estimatedCompositionTokens).toBe(55);
    expect(event.persistedSessionShare).toBeCloseTo(35 / 55, 5);
    expect(event.toolResultShare).toBeCloseTo(20 / 55, 5);
    expect(event.memoryCompanionShare).toBeCloseTo(10 / 55, 5);
  });
});
