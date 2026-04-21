import { describe, expect, it, vi } from "vitest";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { handleToolExecutionStart } from "./pi-embedded-subscribe.handlers.tools.js";

function createCtx() {
  const warn = vi.fn();
  const debug = vi.fn();
  const ctx: EmbeddedPiSubscribeContext = {
    params: { runId: "run-test" } as EmbeddedPiSubscribeContext["params"],
    state: {
      assistantTexts: [],
      toolMetas: [],
      toolMetaById: new Map(),
      toolSummaryById: new Set(),
      blockReplyBreak: "text_end",
      reasoningMode: "medium",
      includeReasoning: false,
      shouldEmitPartialReplies: false,
      streamReasoning: false,
      deltaBuffer: "",
      blockBuffer: "",
      blockState: { thinking: false, final: false, inlineCode: { open: false, fenceLength: 0 } },
      partialBlockState: {
        thinking: false,
        final: false,
        inlineCode: { open: false, fenceLength: 0 },
      },
      assistantMessageIndex: 0,
      lastAssistantTextMessageIndex: 0,
      assistantTextBaseline: 0,
      suppressBlockChunks: false,
      compactionInFlight: false,
      pendingCompactionRetry: 0,
      compactionRetryPromise: null,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentTargets: [],
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
    },
    log: { debug, warn },
    blockChunker: null,
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: () => {},
    emitToolOutput: () => {},
    stripBlockTags: (text) => text,
    emitBlockChunk: () => {},
    flushBlockReplyBuffer: () => {},
    emitReasoningStream: () => {},
    consumeReplyDirectives: () => null,
    consumePartialReplyDirectives: () => null,
    resetAssistantMessageState: () => {},
    resetForCompactionRetry: () => {},
    finalizeAssistantTexts: () => {},
    trimMessagingToolSent: () => {},
    ensureCompactionPromise: () => {},
    noteCompactionRetry: () => {},
    resolveCompactionRetry: () => {},
    maybeResolveCompactionWait: () => {},
  };
  return { ctx, warn, debug };
}

describe("handleToolExecutionStart", () => {
  it("does not warn for read when args use filepath alias", async () => {
    const { ctx, warn } = createCtx();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { filepath: "foo.txt" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for read when args use wrapped input.filepath", async () => {
    const { ctx, warn } = createCtx();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: { input: { filepath: "foo.txt" } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns only when normalized args still lack a path", async () => {
    const { ctx, warn } = createCtx();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-3",
      args: { input: { oldText: "x" } },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/read tool called without path/);
  });
});
