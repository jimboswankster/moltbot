import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { onTimer } from "./service/timer.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-stuck-"));
  return {
    storePath: path.join(dir, "cron", "jobs.config.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

// A run that neither resolves nor rejects, like an agent turn whose timeout
// fired but whose promise was never released.
function neverSettles(onStart: () => void) {
  return vi.fn(() => {
    onStart();
    return new Promise<never>(() => {});
  });
}

describe("CronService when a job's run never settles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const cases = [
    {
      name: "an isolated agent turn",
      stuckJob: {
        sessionTarget: "isolated" as const,
        wakeMode: "next-heartbeat" as const,
        payload: { kind: "agentTurn" as const, message: "work", timeoutSeconds: 60 },
      },
      stuckDep: "runIsolatedAgentJob" as const,
      advanceMs: 10 * 60_000,
    },
    {
      name: "a main-session heartbeat",
      stuckJob: {
        sessionTarget: "main" as const,
        wakeMode: "now" as const,
        payload: { kind: "systemEvent" as const, text: "brief" },
      },
      stuckDep: "runHeartbeatOnce" as const,
      advanceMs: 2 * 60 * 60_000,
    },
  ];

  it.each(cases)(
    "fails $name that outlives its deadline and keeps running other jobs",
    async ({ stuckJob, stuckDep, advanceMs }) => {
      const store = await makeStorePath();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const enqueueSystemEvent = vi.fn();
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent,
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        [stuckDep]: neverSettles(markStarted),
      });
      await cron.start();
      const stuck = await cron.add({
        ...stuckJob,
        name: "stuck",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
      });
      await cron.add({
        name: "every-minute",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      });
      const state = (cron as unknown as { state: unknown }).state as never;

      vi.setSystemTime(new Date("2025-12-13T00:01:00.500Z"));
      const tick = onTimer(state);
      await started;
      await vi.advanceTimersByTimeAsync(advanceMs);
      await tick;

      const stuckState = (await cron.list({ includeDisabled: true })).find(
        (job) => job.id === stuck.id,
      )?.state;
      expect(stuckState?.lastStatus).toBe("error");
      expect(stuckState?.runningAtMs).toBeUndefined();
      expect(enqueueSystemEvent).toHaveBeenCalledWith("tick", { agentId: undefined });

      cron.stop();
      await store.cleanup();
    },
  );
});
