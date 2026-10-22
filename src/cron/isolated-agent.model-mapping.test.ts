import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-cron-" });
}

async function writeSessionStore(home: string) {
  const dir = path.join(home, ".openclaw", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "webchat",
          lastTo: "",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return storePath;
}

function makeCfg(
  home: string,
  storePath: string,
  overrides: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  const base: OpenClawConfig = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  return { ...base, ...overrides };
}

function makeJob(payload: CronJob["payload"]): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
    isolation: { postToMainPrefix: "Cron" },
  };
}

describe("runCronIsolatedAgentTurn model mapping", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("uses explicit model overrides for agentTurn jobs", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "openai", model: "gpt-4.1-mini" },
        },
      });

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          model: "openai/gpt-4.1-mini",
          deliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-4.1-mini");
    });
  });

  it("uses cron.agentTurnModel when payload model is default", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "openai", model: "gpt-4.1-mini" },
        },
      });

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          cron: { agentTurnModel: "openai/gpt-4.1-mini" },
        }),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          model: "default",
          deliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-4.1-mini");
    });
  });

  it("uses route-policy selectedModel before literal model fallback", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValue([
        { id: "MiniMax-M2.1", name: "MiniMax M2.1", provider: "minimax" },
        { id: "nemotron-nano-worker", name: "Nemotron Nano Worker", provider: "local-dgx" },
      ]);
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: {
            sessionId: "s",
            provider: "local-dgx",
            model: "nemotron-nano-worker",
          },
        },
      });

      const result = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          routePolicyClass: "local_dgx_nemotron_worker",
          selectedModel: "local-dgx/nemotron-nano-worker",
          modelSource: "route_policy_runtime",
          model: "minimax/MiniMax-M2.1",
          routerRequired: true,
          deliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(result.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("local-dgx");
      expect(call?.model).toBe("nemotron-nano-worker");
    });
  });

  it("fails closed when route-policy routing is required without a selectedModel", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      const result = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          routePolicyClass: "local_dgx_nemotron_worker",
          model: "minimax/MiniMax-M2.1",
          routerRequired: true,
          deliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(result).toMatchObject({
        status: "error",
        errorKind: "invalid-model",
        error: "model route required but no selectedModel was provided",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("uses configured primary when payload model is default and cron.agentTurnModel is unset", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "anthropic", model: "claude-opus-4-5" },
        },
      });

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          model: "default",
          deliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-opus-4-5");
    });
  });
});

describe("runCronIsolatedAgentTurn route-locked jobs", () => {
  const deps: CliDeps = {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };

  // A routing policy whose default worker is a cloud model, as on a real gateway.
  async function writeCloudDefaultPolicy(home: string) {
    const dir = path.join(home, ".openclaw", "workspace", "os", "config");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "routing-policy.v1.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        defaults: { lane: "coding", workerTier: "W1A", workerModel: "openai-codex/gpt-5.6-sol" },
        laneRules: [],
      }),
      "utf-8",
    );
  }

  function cfgWithCloudFallbacks(home: string, storePath: string): OpenClawConfig {
    return makeCfg(home, storePath, {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.6-sol",
            fallbacks: ["anthropic/claude-opus-4-5", "google/gemini-3-pro-preview"],
          },
          workspace: path.join(home, "openclaw"),
        },
      },
    } as Partial<OpenClawConfig>);
  }

  function localRouteJob(): CronJob {
    return makeJob({
      kind: "agentTurn",
      message: "check the inbox",
      model: "local-dgx/nemotron-nano-worker",
      selectedModel: "local-dgx/nemotron-nano-worker",
      routePolicyClass: "local_dgx_nemotron_worker",
      modelSource: "route_policy_runtime",
      routerRequired: true,
      deliver: false,
    });
  }

  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("keeps the route-selected local model instead of the policy default", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      await writeCloudDefaultPolicy(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "local-dgx", model: "nemotron-nano-worker" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: cfgWithCloudFallbacks(home, storePath),
        deps,
        job: localRouteJob(),
        message: "check the inbox",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        provider?: string;
        model?: string;
        preserveRequestedModel?: boolean;
      };
      expect(call?.provider).toBe("local-dgx");
      expect(call?.model).toBe("nemotron-nano-worker");
      expect(call?.preserveRequestedModel).toBe(true);
    });
  });

  it("fails closed on the local provider instead of falling back to cloud models", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      await writeCloudDefaultPolicy(home);
      vi.mocked(runEmbeddedPiAgent).mockRejectedValue(new Error("dgx unavailable"));

      const res = await runCronIsolatedAgentTurn({
        cfg: cfgWithCloudFallbacks(home, storePath),
        deps,
        job: localRouteJob(),
        message: "check the inbox",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      const providers = vi
        .mocked(runEmbeddedPiAgent)
        .mock.calls.map((args) => (args[0] as { provider?: string }).provider);
      expect(providers.length).toBeGreaterThan(0);
      expect(providers.every((provider) => provider === "local-dgx")).toBe(true);
    });
  });

  it("still applies the policy default to jobs without a route selection", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      await writeCloudDefaultPolicy(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "openai-codex", model: "gpt-5.6-sol" },
        },
      });

      await runCronIsolatedAgentTurn({
        cfg: cfgWithCloudFallbacks(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          model: "local-dgx/nemotron-nano-worker",
          deliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        provider?: string;
        preserveRequestedModel?: boolean;
      };
      expect(call?.provider).toBe("openai-codex");
      expect(call?.preserveRequestedModel).toBe(false);
    });
  });
});
