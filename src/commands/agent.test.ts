import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { decideDeterministicRoute, extractRoutingHints } from "../agents/deterministic-router.js";
import { FailoverError } from "../agents/failover-error.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resetModelCandidateCooldownsForTest } from "../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import * as configModule from "../config/config.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { recordRuntimeTelemetryEvent } from "../infra/runtime-telemetry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { agentCommand } from "./agent.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configModule, "loadConfig");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-" });
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  telegramOverrides?: Partial<NonNullable<OpenClawConfig["telegram"]>>,
  agentsList?: Array<{ id: string; default?: boolean }>,
) {
  configSpy.mockReturnValue({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: { "anthropic/claude-opus-4-5": {} },
        workspace: path.join(home, "openclaw"),
        ...agentOverrides,
      },
      list: agentsList,
    },
    session: { store: storePath, mainKey: "main" },
    telegram: telegramOverrides ? { ...telegramOverrides } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModelCandidateCooldownsForTest();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
});

describe("agentCommand", () => {
  it("creates a session entry when deriving from --to", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hello", to: "+1555" }, runtime);

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.sessionId).toBeTruthy();
    });
  });

  it("persists thinking and verbose overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1222", thinking: "high", verbose: "on" }, runtime);

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { thinkingLevel?: string; verboseLevel?: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.verboseLevel).toBe("on");

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("high");
      expect(callArgs?.verboseLevel).toBe("on");
    });
  });

  it("resumes when session-id is provided", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(store), { recursive: true });
      fs.writeFileSync(
        store,
        JSON.stringify(
          {
            foo: {
              sessionId: "session-123",
              updatedAt: Date.now(),
              systemSent: true,
            },
          },
          null,
          2,
        ),
      );
      mockConfig(home, store);

      await agentCommand({ message: "resume me", sessionId: "session-123" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionId).toBe("session-123");
    });
  });

  it("does not duplicate agent events from embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      const assistantEvents: Array<{ runId: string; text?: string }> = [];
      const stop = onAgentEvent((evt) => {
        if (evt.stream !== "assistant") {
          return;
        }
        assistantEvents.push({
          runId: evt.runId,
          text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
        });
      });

      vi.mocked(runEmbeddedPiAgent).mockImplementationOnce(async (params) => {
        const runId = (params as { runId?: string } | undefined)?.runId ?? "run";
        const data = { text: "hello", delta: "hello" };
        (
          params as {
            onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
          }
        ).onAgentEvent?.({ stream: "assistant", data });
        emitAgentEvent({ runId, stream: "assistant", data });
        return {
          payloads: [{ text: "hello" }],
          meta: { agentMeta: { provider: "p", model: "m" } },
        } as never;
      });

      await agentCommand({ message: "hi", to: "+1555" }, runtime);
      stop();

      const matching = assistantEvents.filter((evt) => evt.text === "hello");
      expect(matching).toHaveLength(1);
    });
  });

  it("uses provider/model from agents.defaults.model.primary", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "anthropic/claude-opus-4-5": {},
          "openai/gpt-4.1-mini": {},
        },
      });

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.provider).toBe("openai");
      expect(callArgs?.model).toBe("gpt-4.1-mini");
    });
  });

  it("keeps explicit sessionKey even when sessionId exists elsewhere", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(store), { recursive: true });
      fs.writeFileSync(
        store,
        JSON.stringify(
          {
            "agent:main:main": {
              sessionId: "sess-main",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          sessionId: "sess-main",
          sessionKey: "agent:main:subagent:abc",
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionKey).toBe("agent:main:subagent:abc");

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(saved["agent:main:subagent:abc"]?.sessionId).toBe("sess-main");
    });
  });

  it("derives session key from --agent when no routing target is provided", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand({ message: "hi", agentId: "ops" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionKey).toBe("agent:ops:main");
      expect(callArgs?.sessionFile).toContain(`${path.sep}agents${path.sep}ops${path.sep}sessions`);
    });
  });

  it("rejects unknown agent overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await expect(agentCommand({ message: "hi", agentId: "ghost" }, runtime)).rejects.toThrow(
        'Unknown agent id "ghost"',
      );
    });
  });

  it("defaults thinking to low for reasoning-capable models", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: true,
        },
      ]);

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });

  it("prints JSON payload when requested", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
        meta: {
          durationMs: 42,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1999", json: true }, runtime);

      const logged = (runtime.log as MockInstance).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(logged) as {
        payloads: Array<{ text: string; mediaUrl?: string | null }>;
        meta: { durationMs: number };
      };
      expect(parsed.payloads[0].text).toBe("json-reply");
      expect(parsed.payloads[0].mediaUrl).toBe("http://x.test/a.jpg");
      expect(parsed.meta.durationMs).toBe(42);
    });
  });

  it("passes the message through as the agent prompt", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "ping", to: "+1333" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.prompt).toBe("ping");
    });
  });

  it("passes through telegram accountId when delivering", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, { botToken: "t-1" });
      setTelegramRuntime(createPluginRuntime());
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
      );
      const deps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "123" }),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "";
      try {
        await agentCommand(
          {
            message: "hi",
            to: "123",
            deliver: true,
            channel: "telegram",
          },
          runtime,
          deps,
        );

        expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
          "123",
          "ok",
          expect.objectContaining({ accountId: undefined, verbose: false }),
        );
      } finally {
        if (prevTelegramToken === undefined) {
          delete process.env.TELEGRAM_BOT_TOKEN;
        } else {
          process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
        }
      }
    });
  });

  it("uses reply channel as the message channel context", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand({ message: "hi", agentId: "ops", replyChannel: "slack" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.messageChannel).toBe("slack");
    });
  });

  it("prefers runContext for embedded routing", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          to: "+1555",
          channel: "whatsapp",
          runContext: { messageChannel: "slack", accountId: "acct-2" },
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.messageChannel).toBe("slack");
      expect(callArgs?.agentAccountId).toBe("acct-2");
    });
  });

  it("forwards accountId to embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1555", accountId: "kev" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.agentAccountId).toBe("kev");
    });
  });

  it("logs output when delivery is disabled", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand({ message: "hi", agentId: "ops" }, runtime);

      expect(runtime.log).toHaveBeenCalledWith("ok");
    });
  });

  it("keeps fallback chain provider parity under deterministic routing", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: {
          primary: "openai-codex/gpt-5.1",
          fallbacks: ["openrouter/z-ai/glm-5", "openai/gpt-5.1", "minimax/MiniMax-M2.5"],
        },
        models: {
          "openai-codex/gpt-5.1": {},
          "openrouter/z-ai/glm-5": {},
          "openai/gpt-5.1": {},
          "minimax/MiniMax-M2.5": {},
          "ollama/glm-5:cloud": {},
        },
      });

      const policy = {
        enabled: true,
        defaults: {
          workerModel: "minimax/MiniMax-M2.5",
        },
        laneRules: [
          {
            id: "reasoning-policy-default",
            enabled: true,
            if: { taskClassesAny: ["policy-review"] },
            then: { workerModel: "ollama/glm-5:cloud" },
          },
        ],
      } as const;

      const attempts: Array<{
        requested: string;
        selected: string;
        lane: string | undefined;
      }> = [];

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        const lane = (params as { lane?: string }).lane;
        const requestedProvider = String((params as { provider?: string }).provider ?? "");
        const requestedModel = String((params as { model?: string }).model ?? "");
        const prompt = String((params as { prompt?: string }).prompt ?? "");
        const extraSystemPrompt = String(
          (params as { extraSystemPrompt?: string }).extraSystemPrompt ?? "",
        );
        const hints = extractRoutingHints({ prompt, extraSystemPrompt, lane });
        const decision = decideDeterministicRoute({
          policy,
          policyPath: "/tmp/routing-policy.v1.json",
          hints,
          provider: requestedProvider,
          model: requestedModel,
        });
        const selectedProvider = decision.provider ?? requestedProvider;
        const selectedModel = decision.model ?? requestedModel;

        attempts.push({
          requested: `${requestedProvider}/${requestedModel}`,
          selected: `${selectedProvider}/${selectedModel}`,
          lane,
        });

        if (selectedProvider === "ollama") {
          throw new FailoverError("No available auth profile for ollama (all in cooldown).", {
            reason: "rate_limit",
            provider: selectedProvider,
            model: selectedModel,
            status: 429,
          });
        }

        return {
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: selectedProvider, model: selectedModel },
          },
        };
      });

      await agentCommand({ message: "Please review this policy and risks.", to: "+1555" }, runtime);

      expect(attempts).toEqual([
        {
          requested: "openai-codex/gpt-5.1",
          selected: "ollama/glm-5:cloud",
          lane: undefined,
        },
        {
          requested: "openrouter/z-ai/glm-5",
          selected: "openrouter/z-ai/glm-5",
          lane: "fallback:openrouter/z-ai/glm-5",
        },
      ]);
    });
  });

  it("chaos: preserves full fallback-chain parity when all attempts fail", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: {
          primary: "openai-codex/gpt-5.1",
          fallbacks: ["openrouter/z-ai/glm-5", "openai/gpt-5.1", "minimax/MiniMax-M2.5"],
        },
        models: {
          "openai-codex/gpt-5.1": {},
          "openrouter/z-ai/glm-5": {},
          "openai/gpt-5.1": {},
          "minimax/MiniMax-M2.5": {},
          "ollama/glm-5:cloud": {},
        },
      });

      const policy = {
        enabled: true,
        defaults: {
          workerModel: "minimax/MiniMax-M2.5",
        },
        laneRules: [
          {
            id: "reasoning-policy-default",
            enabled: true,
            if: { taskClassesAny: ["policy-review"] },
            then: { workerModel: "ollama/glm-5:cloud" },
          },
        ],
      } as const;

      const attempts: Array<{
        requested: string;
        selected: string;
        lane: string | undefined;
      }> = [];

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        const lane = (params as { lane?: string }).lane;
        const requestedProvider = String((params as { provider?: string }).provider ?? "");
        const requestedModel = String((params as { model?: string }).model ?? "");
        const prompt = String((params as { prompt?: string }).prompt ?? "");
        const extraSystemPrompt = String(
          (params as { extraSystemPrompt?: string }).extraSystemPrompt ?? "",
        );
        const hints = extractRoutingHints({ prompt, extraSystemPrompt, lane });
        const decision = decideDeterministicRoute({
          policy,
          policyPath: "/tmp/routing-policy.v1.json",
          hints,
          provider: requestedProvider,
          model: requestedModel,
        });
        const selectedProvider = decision.provider ?? requestedProvider;
        const selectedModel = decision.model ?? requestedModel;

        attempts.push({
          requested: `${requestedProvider}/${requestedModel}`,
          selected: `${selectedProvider}/${selectedModel}`,
          lane,
        });

        throw new FailoverError(`forced failure from ${selectedProvider}/${selectedModel}`, {
          reason: "rate_limit",
          provider: selectedProvider,
          model: selectedModel,
          status: 429,
        });
      });

      await expect(
        agentCommand({ message: "Please review this policy and risks.", to: "+1555" }, runtime),
      ).rejects.toThrow("All models failed (4)");

      expect(attempts).toEqual([
        {
          requested: "openai-codex/gpt-5.1",
          selected: "ollama/glm-5:cloud",
          lane: undefined,
        },
        {
          requested: "openrouter/z-ai/glm-5",
          selected: "openrouter/z-ai/glm-5",
          lane: "fallback:openrouter/z-ai/glm-5",
        },
        {
          requested: "openai/gpt-5.1",
          selected: "openai/gpt-5.1",
          lane: "fallback:openai/gpt-5.1",
        },
        {
          requested: "minimax/MiniMax-M2.5",
          selected: "minimax/MiniMax-M2.5",
          lane: "fallback:minimax/MiniMax-M2.5",
        },
      ]);
    });
  });

  it("telemetry contract: fallback lanes never log requested/selected provider mismatch", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: {
          primary: "openai-codex/gpt-5.1",
          fallbacks: ["openrouter/z-ai/glm-5", "openai/gpt-5.1", "minimax/MiniMax-M2.5"],
        },
        models: {
          "openai-codex/gpt-5.1": {},
          "openrouter/z-ai/glm-5": {},
          "openai/gpt-5.1": {},
          "minimax/MiniMax-M2.5": {},
          "ollama/glm-5:cloud": {},
        },
      });

      delete process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
      process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";

      const telemetryPath = path.join(home, ".openclaw", "logs", "runtime-telemetry.jsonl");

      const policy = {
        enabled: true,
        defaults: {
          workerModel: "minimax/MiniMax-M2.5",
        },
        laneRules: [
          {
            id: "reasoning-policy-default",
            enabled: true,
            if: { taskClassesAny: ["policy-review"] },
            then: { workerModel: "ollama/glm-5:cloud" },
          },
        ],
      } as const;

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        const lane = (params as { lane?: string }).lane;
        const requestedProvider = String((params as { provider?: string }).provider ?? "");
        const requestedModel = String((params as { model?: string }).model ?? "");
        const prompt = String((params as { prompt?: string }).prompt ?? "");
        const extraSystemPrompt = String(
          (params as { extraSystemPrompt?: string }).extraSystemPrompt ?? "",
        );
        const hints = extractRoutingHints({ prompt, extraSystemPrompt, lane });
        const decision = decideDeterministicRoute({
          policy,
          policyPath: "/tmp/routing-policy.v1.json",
          hints,
          provider: requestedProvider,
          model: requestedModel,
        });
        const selectedProvider = decision.provider ?? requestedProvider;
        const selectedModel = decision.model ?? requestedModel;

        recordRuntimeTelemetryEvent({
          event: "agent.model_route_selected",
          subsystem: "agent-embedded",
          details: {
            requestedProvider,
            requestedModel,
            selectedProvider,
            selectedModel,
            lane: lane ?? null,
            source: hints.source,
          },
        });

        if (!lane) {
          throw new FailoverError("forced primary failure", {
            reason: "rate_limit",
            provider: selectedProvider,
            model: selectedModel,
            status: 429,
          });
        }

        return {
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: selectedProvider, model: selectedModel },
          },
        };
      });

      await agentCommand({ message: "Please review this policy and risks.", to: "+1555" }, runtime);

      expect(fs.existsSync(telemetryPath)).toBe(true);
      const rows = fs
        .readFileSync(telemetryPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { event?: string; details?: Record<string, unknown> });

      const fallbackRouteRows = rows.filter((row) => {
        if (row.event !== "agent.model_route_selected") return false;
        const lane = String(row.details?.lane ?? "");
        return lane.startsWith("fallback:");
      });
      expect(fallbackRouteRows.length).toBeGreaterThan(0);
      for (const row of fallbackRouteRows) {
        expect(row.details?.requestedProvider).toBe(row.details?.selectedProvider);
        expect(row.details?.requestedModel).toBe(row.details?.selectedModel);
      }
    });
  });

  it("trustedTaskClass overrides keyword routing and preserves telegram codex stabilization", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const workspaceRoot = path.join(home, ".openclaw", "workspace", "os", "config");
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(workspaceRoot, "routing-policy.v1.json"),
        JSON.stringify(
          {
            version: 1,
            enabled: true,
            defaults: {
              workerModel: "minimax/MiniMax-M2.5",
            },
            laneRules: [
              {
                id: "coding-default",
                enabled: true,
                if: { taskClassesAny: ["implementation"] },
                then: { workerModel: "minimax/MiniMax-M2.5" },
              },
              {
                id: "telegram-codex-stabilization",
                enabled: true,
                if: { taskClassesAny: ["telegram-codex-stabilization"] },
                then: { workerModel: "openai-codex/gpt-5.3-codex" },
              },
            ],
          },
          null,
          2,
        ),
      );

      mockConfig(home, store, {
        model: {
          primary: "openai-codex/gpt-5.1",
          fallbacks: ["minimax/MiniMax-M2.5"],
        },
        models: {
          "openai-codex/gpt-5.1": {},
          "openai-codex/gpt-5.3-codex": {},
          "minimax/MiniMax-M2.5": {},
        },
      });

      await agentCommand(
        {
          message: "implement the change and add tests",
          to: "+1555",
          trustedTaskClass: "telegram-codex-stabilization",
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.provider).toBe("openai-codex");
      expect(callArgs?.model).toBe("gpt-5.3-codex");
      expect(callArgs?.trustedTaskClass).toBe("telegram-codex-stabilization");
    });
  });
});
