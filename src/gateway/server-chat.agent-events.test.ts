import { describe, expect, it, vi } from "vitest";
import { createAgentEventHandler, createChatRunState } from "./server-chat.js";

describe("agent event handler", () => {
  it("emits chat delta for assistant text-only events", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("appends deltaText instead of re-sending accumulated text", () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const current = now;
      now += 200;
      return current;
    });
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "I", delta: "I" },
    });

    handler({
      runId: "run-1",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "I will", delta: " will" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(2);
    const firstPayload = chatCalls[0]?.[1] as {
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const secondPayload = chatCalls[1]?.[1] as {
      deltaText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(firstPayload.deltaText).toBe("I");
    expect(firstPayload.message?.content?.[0]?.text).toBe("I");
    expect(secondPayload.deltaText).toBe(" will");
    expect(secondPayload.message?.content?.[0]?.text).toBe("I will");
    nowSpy.mockRestore();
  });

  it("drops duplicate accumulated text without delta", () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const current = now;
      now += 200;
      return current;
    });
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "I", delta: "I" },
    });

    handler({
      runId: "run-1",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "I", delta: "" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("drops duplicate deltas when full text does not advance", () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const current = now;
      now += 200;
      return current;
    });
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "I", delta: "I" },
    });

    handler({
      runId: "run-1",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "I will", delta: " will" },
    });

    handler({
      runId: "run-1",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "I will", delta: " will" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("respects stream buffer adapter decisions", () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const current = now;
      now += 200;
      return current;
    });
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const streamBufferAdapter = vi.fn(({ seq }: { seq: number }) => {
      if (seq === 1) {
        return { allow: true };
      }
      if (seq === 2) {
        return { allow: true, coalesceMs: 500 };
      }
      return { allow: false };
    });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
      streamBufferAdapter,
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello", delta: "Hello" },
    });

    handler({
      runId: "run-1",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello again", delta: " again" },
    });

    handler({
      runId: "run-1",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello again!", delta: "!" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });
});
