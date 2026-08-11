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

async function writeSessionStore(
  home: string,
  entry: { totalTokens?: number; contextTokens?: number },
) {
  const dir = path.join(home, ".openclaw", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:main:cron:job-1": {
          sessionId: "cron-session",
          updatedAt: Date.now(),
          totalTokens: entry.totalTokens,
          contextTokens: entry.contextTokens,
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
        contextTokens: 1000,
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  return { ...base, ...overrides };
}

function makeJob(payload: CronJob["payload"], state?: CronJob["state"]): CronJob {
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
    state: state ?? {},
    isolation: { postToMainPrefix: "Cron" },
  };
}

describe("runCronIsolatedAgentTurn token budget guard", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("does NOT skip when a PRIOR session left usage near the limit", async () => {
    // This case previously asserted the OPPOSITE — that a stale prior entry
    // skips the run — which turned out to encode the bug rather than a contract.
    //
    // Each isolated cron run mints a fresh session: `resolveCronSession` assigns
    // a new sessionId (so `resolveSessionTranscriptPath` yields a NEW transcript)
    // and carries neither `cliSessionIds` nor `claudeCliSessionId` (so
    // `getCliSessionId` returns undefined and there is no provider-side resume).
    // The run therefore inherits NO context and genuinely starts at zero.
    //
    // Judging that empty session by the previous one's consumption skipped it
    // forever: the guard returns "skipped", a skipped run records no usage, so
    // the inherited number never moved and no tick could ever clear it. Observed
    // 2026-08-11 — the arbiter merge-queue heartbeat logged 459 consecutive skips
    // across 232 hours frozen at exactly 183068/200000, silently removing the
    // only autonomous merge-queue drain for ten days. Two other isolated
    // agentTurn jobs were wedged identically at 187993 and 193017.
    //
    // The guard itself is kept: it is cheap defence-in-depth and becomes
    // meaningful again if these sessions are ever made resumable. What changed is
    // that a fresh session no longer arrives pre-loaded with a dead one's usage.
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { totalTokens: 950, contextTokens: 1000 });
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).not.toBe("skipped");
      expect(res.summary ?? "").not.toContain("token budget");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
    });
  });

  it("derives a stable runId from plannedRunAtMs", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { totalTokens: 10, contextTokens: 1000 });
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const plannedRunAtMs = 1_700_000_000_000;
      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }, { plannedRunAtMs }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const params = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(params?.runId).toBe(`cron:job-1:${plannedRunAtMs}`);
    });
  });
});
