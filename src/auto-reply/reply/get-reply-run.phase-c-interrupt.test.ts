import { describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(),
  getQueueSize: vi.fn(),
}));

const piEmbeddedMocks = vi.hoisted(() => ({
  abortEmbeddedPiRun: vi.fn(),
  isEmbeddedPiRunActive: vi.fn(),
  isEmbeddedPiRunStreaming: vi.fn(),
  resolveEmbeddedSessionLane: vi.fn(),
}));

const queueResolverMocks = vi.hoisted(() => ({
  resolveQueueSettings: vi.fn(),
}));

const runnerMocks = vi.hoisted(() => ({
  runReplyAgent: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: queueMocks.clearCommandLane,
  getQueueSize: queueMocks.getQueueSize,
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: piEmbeddedMocks.abortEmbeddedPiRun,
  isEmbeddedPiRunActive: piEmbeddedMocks.isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming: piEmbeddedMocks.isEmbeddedPiRunStreaming,
  resolveEmbeddedSessionLane: piEmbeddedMocks.resolveEmbeddedSessionLane,
}));

vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return {
    ...actual,
    resolveQueueSettings: queueResolverMocks.resolveQueueSettings,
  };
});

vi.mock("./agent-runner.js", () => ({
  runReplyAgent: runnerMocks.runReplyAgent,
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn(async ({ baseBody }) => baseBody),
}));

vi.mock("./session-updates.js", () => ({
  prependSystemEvents: vi.fn(
    async (params: { prefixedBodyBase: string }) => params.prefixedBodyBase,
  ),
  ensureSkillSnapshot: vi.fn(async (params: { sessionEntry: unknown }) => ({
    sessionEntry: params.sessionEntry,
    systemSent: true,
    skillsSnapshot: undefined,
  })),
}));

vi.mock("./untrusted-context.js", () => ({
  appendUntrustedContext: vi.fn((body: string) => body),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn(() => "instant"),
}));

vi.mock("./groups.js", () => ({
  buildGroupIntro: vi.fn(() => ""),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn(() => true),
}));

vi.mock("../media-note.js", () => ({
  buildInboundMediaNote: vi.fn(() => undefined),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  resolveGroupSessionKey: vi.fn(() => null),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn(() => "main"),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn(() => false),
}));

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn(async () => undefined),
}));

import { runPreparedReply } from "./get-reply-run.js";

describe("runPreparedReply phase-c interrupt path", () => {
  it("uses command-control intent and clears/aborts active telegram session lane", async () => {
    queueMocks.clearCommandLane.mockReset();
    queueMocks.getQueueSize.mockReset();
    piEmbeddedMocks.abortEmbeddedPiRun.mockReset();
    piEmbeddedMocks.isEmbeddedPiRunActive.mockReset();
    piEmbeddedMocks.isEmbeddedPiRunStreaming.mockReset();
    piEmbeddedMocks.resolveEmbeddedSessionLane.mockReset();
    queueResolverMocks.resolveQueueSettings.mockReset();
    runnerMocks.runReplyAgent.mockReset();

    queueMocks.getQueueSize.mockReturnValue(2);
    queueMocks.clearCommandLane.mockReturnValue(2);
    piEmbeddedMocks.abortEmbeddedPiRun.mockReturnValue(true);
    piEmbeddedMocks.isEmbeddedPiRunActive.mockReturnValue(false);
    piEmbeddedMocks.isEmbeddedPiRunStreaming.mockReturnValue(false);
    piEmbeddedMocks.resolveEmbeddedSessionLane.mockImplementation(
      (key: string) => `session:${key}`,
    );
    queueResolverMocks.resolveQueueSettings.mockReturnValue({
      mode: "interrupt",
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize",
    });
    runnerMocks.runReplyAgent.mockResolvedValue(undefined);

    const typing = {
      cleanup: vi.fn(),
      onReplyStart: vi.fn(async () => {}),
    };

    await runPreparedReply({
      ctx: {
        Body: "hello",
        CommandBody: "/status with args",
        RawBody: "/status with args",
        MessageSid: "m-1",
      },
      sessionCtx: {
        Body: "hello",
        BodyStripped: "hello",
        Provider: "telegram",
        MessageSid: "m-1",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:111",
      },
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: {},
      sessionCfg: {},
      commandAuthorized: false,
      command: {
        isAuthorizedSender: false,
        ownerList: [],
      },
      commandSource: "/status with args",
      allowTextCommands: false,
      directives: {},
      defaultActivation: "mention",
      resolvedThinkLevel: "low",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      elevatedEnabled: false,
      elevatedAllowed: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      modelState: {
        resolveDefaultThinkingLevel: vi.fn(async () => "low"),
      },
      provider: "anthropic",
      model: "claude-opus-4-5",
      typing: typing as unknown as Parameters<typeof runPreparedReply>[0]["typing"],
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      timeoutMs: 1000,
      isNewSession: false,
      resetTriggered: false,
      systemSent: true,
      sessionEntry: {
        sessionId: "sid-1",
      },
      sessionStore: {
        "agent:main:telegram:group:-100123:topic:99": {
          sessionId: "sid-1",
        },
      },
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      sessionId: "sid-1",
      storePath: "/tmp/sessions.json",
      workspaceDir: "/tmp/workspace",
      abortedLastRun: false,
    });

    expect(queueResolverMocks.resolveQueueSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100123:topic:99",
        intent: "command-control",
      }),
    );
    expect(queueMocks.getQueueSize).toHaveBeenCalledWith(
      "session:agent:main:telegram:group:-100123:topic:99",
    );
    expect(queueMocks.clearCommandLane).toHaveBeenCalledWith(
      "session:agent:main:telegram:group:-100123:topic:99",
    );
    expect(piEmbeddedMocks.abortEmbeddedPiRun).toHaveBeenCalledWith("sid-1");
    expect(runnerMocks.runReplyAgent).toHaveBeenCalled();
  });
});
