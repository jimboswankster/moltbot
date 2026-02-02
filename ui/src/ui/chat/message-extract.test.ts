import { describe, expect, it } from "vitest";

import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
} from "./message-extract";

describe("extractText", () => {
  it("unwraps action JSON for assistant messages", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: '{"name": "message_create", "arguments": {"text": "Hello!"}}',
        },
      ],
    };
    expect(extractText(message)).toBe("Hello!");
  });

  it("passes through action JSON with no text (e.g. session_status)", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: '{"name": "session_status", "arguments": {}}' },
      ],
    };
    // No arguments.text, so unwrap returns original
    expect(extractText(message)).toBe('{"name": "session_status", "arguments": {}}');
  });
});

describe("extractTextCached", () => {
  it("matches extractText output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
    };
    expect(extractTextCached(message)).toBe(extractText(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "user",
      content: "plain text",
    };
    expect(extractTextCached(message)).toBe("plain text");
    expect(extractTextCached(message)).toBe("plain text");
  });
});

describe("extractThinkingCached", () => {
  it("matches extractThinking output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe(extractThinking(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe("Plan A");
    expect(extractThinkingCached(message)).toBe("Plan A");
  });
});
