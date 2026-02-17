import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "./ui-types";
import { handleSendChat } from "./app-chat";
import * as chatController from "./controllers/chat";

vi.mock("./controllers/chat", () => ({
  abortChatRun: vi.fn(),
  loadChatHistory: vi.fn(),
  sendChatMessage: vi.fn(),
}));

vi.mock("./app-scroll", () => ({
  scheduleChatScroll: vi.fn(),
}));

vi.mock("./app-settings", () => ({
  setLastActiveSessionKey: vi.fn(),
}));

vi.mock("./app-tool-stream", () => ({
  resetToolStream: vi.fn(),
}));

vi.mock("./controllers/sessions", () => ({
  loadSessions: vi.fn(),
}));

vi.mock("../../../src/sessions/session-key-utils.js", () => ({
  parseAgentSessionKey: vi.fn(() => null),
}));

type TestHost = {
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: Array<Record<string, unknown>>;
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: null;
  chatAvatarUrl: string | null;
  refreshSessionsAfterChat: Set<string>;
};

function createHost(overrides: Partial<TestHost> = {}): TestHost {
  return {
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    sessionKey: "agent:main:main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    refreshSessionsAfterChat: new Set<string>(),
    ...overrides,
  };
}

describe("app-chat handleSendChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues when a run is active without aborting the current run", async () => {
    const host = createHost({
      chatMessage: "follow-up instruction",
      chatRunId: "run-active",
    });
    const abortSpy = vi.mocked(chatController.abortChatRun);
    const sendSpy = vi.mocked(chatController.sendChatMessage);
    abortSpy.mockResolvedValue(true);
    sendSpy.mockResolvedValue("run-next");

    await handleSendChat(host as never);

    expect(abortSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("follow-up instruction");
    expect(host.chatMessage).toBe("");
  });

  it("sends immediately when idle", async () => {
    const host = createHost({
      chatMessage: "first message",
      chatRunId: null,
    });
    const sendSpy = vi.mocked(chatController.sendChatMessage);
    sendSpy.mockResolvedValue("run-1");

    await handleSendChat(host as never);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(host.chatQueue).toHaveLength(0);
  });
});
