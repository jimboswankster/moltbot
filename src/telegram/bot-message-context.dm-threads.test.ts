import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, saveSessionStore } from "../config/sessions.js";
import { buildTelegramMessageContext } from "./bot-message-context.js";

async function cleanupTempDir(root: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 4) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

describe("buildTelegramMessageContext dm thread sessions", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  } as never;

  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContext({
      primaryCtx: {
        message,
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [],
      storeAllowFrom: [],
      options: {},
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: baseConfig,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info: vi.fn() },
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

  it("uses thread session key for dm topics", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: 1234, type: "private" },
      date: 1700000000,
      text: "hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:42");
  });

  it("keeps legacy dm session key when no thread id", async () => {
    const ctx = await buildContext({
      message_id: 2,
      chat: { id: 1234, type: "private" },
      date: 1700000001,
      text: "hello",
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});

describe("buildTelegramMessageContext group sessions without forum", () => {
  const baseConfig = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  } as never;

  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContext({
      primaryCtx: {
        message,
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [],
      storeAllowFrom: [],
      options: { forceWasMentioned: true },
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: baseConfig,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info: vi.fn() },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
    });

  it("ignores message_thread_id for regular groups (not forums)", async () => {
    // When someone replies to a message in a non-forum group, Telegram sends
    // message_thread_id but this should NOT create a separate session
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42, // This is a reply thread, NOT a forum topic
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    // Session key should NOT include :topic:42
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890");
    // MessageThreadId should be undefined (not a forum)
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
  });

  it("keeps same session for regular group with and without message_thread_id", async () => {
    const ctxWithThread = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    const ctxWithoutThread = await buildContext({
      message_id: 2,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000001,
      text: "@bot world",
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctxWithThread).not.toBeNull();
    expect(ctxWithoutThread).not.toBeNull();
    // Both messages should use the same session key
    expect(ctxWithThread?.ctxPayload?.SessionKey).toBe(ctxWithoutThread?.ctxPayload?.SessionKey);
  });

  it("uses topic session for forum groups with message_thread_id", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 99,
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    // Session key SHOULD include :topic:99 for forums
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(99);
  });
});

describe("buildTelegramMessageContext telegram model policy role enforcement", () => {
  const sessionKey = "agent:main:telegram:group:-1001234567890:topic:237";

  const buildPolicyContext = async (params: {
    storePath: string;
    cfgOverrides?: Record<string, unknown>;
    resolveTelegramGroupConfig?: () => {
      groupConfig?: Record<string, unknown>;
      topicConfig?: Record<string, unknown>;
    };
    logger?: { info: ReturnType<typeof vi.fn> };
  }) => {
    const logger = params.logger ?? { info: vi.fn() };
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" },
        list: [
          { id: "main", default: true, model: "anthropic/claude-opus-4-5" },
          { id: "ops", model: "openai/gpt-4.1-mini" },
        ],
      },
      channels: {
        telegram: {
          modelPolicyRoles: { coo: "main", ops: "ops" },
        },
      },
      session: { store: params.storePath },
      messages: { groupChat: { mentionPatterns: [] } },
      ...(params.cfgOverrides ?? {}),
    } as never;
    const resolveGroupConfig =
      params.resolveTelegramGroupConfig ??
      (() => ({
        groupConfig: { requireMention: false },
        topicConfig: { modelPolicyRole: "coo" },
      }));

    return await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 100,
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Test Forum",
            is_forum: true,
          },
          date: 1700000100,
          text: "@bot hello",
          message_thread_id: 237,
          from: { id: 42, first_name: "Alice" },
        },
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [],
      storeAllowFrom: [],
      options: { forceWasMentioned: true },
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger,
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: resolveGroupConfig as never,
    });
  };

  it("applies role-mapped model policy to existing topic session overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-model-policy-"));
    try {
      const storePath = path.join(root, "sessions.json");
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "topic-237-session",
          updatedAt: Date.now(),
          providerOverride: "minimax",
          modelOverride: "text-01",
        },
      });

      const logger = { info: vi.fn() };
      const ctx = await buildPolicyContext({ storePath, logger });

      expect(ctx).not.toBeNull();

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.providerOverride).toBe("anthropic");
      expect(store[sessionKey]?.modelOverride).toBe("claude-opus-4-5");
      expect(logger.info).toHaveBeenCalled();
    } finally {
      await cleanupTempDir(root);
    }
  });

  it("does not mutate when session override already matches enforced model (mutation guard)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-model-policy-"));
    try {
      const storePath = path.join(root, "sessions.json");
      const updatedAt = Date.now() - 10_000;
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "topic-237-session",
          updatedAt,
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-5",
        },
      });

      const logger = { info: vi.fn() };
      const ctx = await buildPolicyContext({ storePath, logger });
      expect(ctx).not.toBeNull();

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.updatedAt).toBe(updatedAt);
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      await cleanupTempDir(root);
    }
  });

  it("does not mutate when role is unknown/unmapped (edge path)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-model-policy-"));
    try {
      const storePath = path.join(root, "sessions.json");
      const updatedAt = Date.now() - 10_000;
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "topic-237-session",
          updatedAt,
          providerOverride: "minimax",
          modelOverride: "text-01",
        },
      });

      const logger = { info: vi.fn() };
      const ctx = await buildPolicyContext({
        storePath,
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: false },
          topicConfig: { modelPolicyRole: "unknown-role" },
        }),
        logger,
      });
      expect(ctx).not.toBeNull();

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.providerOverride).toBe("minimax");
      expect(store[sessionKey]?.modelOverride).toBe("text-01");
      expect(store[sessionKey]?.updatedAt).toBe(updatedAt);
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      await cleanupTempDir(root);
    }
  });

  it("topic modelPolicyAgentId takes precedence over role mapping (edge precedence)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-model-policy-"));
    try {
      const storePath = path.join(root, "sessions.json");
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "topic-237-session",
          updatedAt: Date.now(),
          providerOverride: "minimax",
          modelOverride: "text-01",
        },
      });

      const ctx = await buildPolicyContext({
        storePath,
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: false, modelPolicyRole: "coo" },
          topicConfig: { modelPolicyRole: "coo", modelPolicyAgentId: "ops" },
        }),
      });
      expect(ctx).not.toBeNull();

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.providerOverride).toBe("openai");
      expect(store[sessionKey]?.modelOverride).toBe("gpt-4.1-mini");
    } finally {
      await cleanupTempDir(root);
    }
  });

  it("uses group-level role when topic role is absent (edge fallback)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-model-policy-"));
    try {
      const storePath = path.join(root, "sessions.json");
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "topic-237-session",
          updatedAt: Date.now(),
          providerOverride: "minimax",
          modelOverride: "text-01",
        },
      });

      const ctx = await buildPolicyContext({
        storePath,
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: false, modelPolicyRole: "ops" },
          topicConfig: {},
        }),
      });
      expect(ctx).not.toBeNull();

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.providerOverride).toBe("openai");
      expect(store[sessionKey]?.modelOverride).toBe("gpt-4.1-mini");
    } finally {
      await cleanupTempDir(root);
    }
  });

  it("creates session entry and applies policy override on first turn when target session is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-model-policy-"));
    try {
      const storePath = path.join(root, "sessions.json");
      await saveSessionStore(storePath, {});

      const ctx = await buildPolicyContext({ storePath });
      expect(ctx).not.toBeNull();

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]).toBeDefined();
      expect(store[sessionKey]?.providerOverride).toBe("anthropic");
      expect(store[sessionKey]?.modelOverride).toBe("claude-opus-4-5");
    } finally {
      await cleanupTempDir(root);
    }
  });
});
