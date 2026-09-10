import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { runDueJobs } from "./service/timer.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-unreadable-"));
  return {
    storePath: path.join(dir, "cron", "jobs.config.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

// What an external writer (git checkout or merge, a script, a hand edit)
// can leave behind at the moment a tick reads the store.
const interruptions: Array<[string, (file: string, complete: string) => Promise<void>]> = [
  ["half-written", (file, complete) => fs.writeFile(file, complete.slice(0, complete.length / 2))],
  ["momentarily missing", (file) => fs.rm(file)],
];

async function startWithOneJob(storePath: string, enqueueSystemEvent = vi.fn()) {
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await cron.start();
  const job = await cron.add({
    name: "every-minute",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
  });
  const state = (cron as unknown as { state: unknown }).state as never;
  return { cron, job, state };
}

const readOrNull = (file: string) => fs.readFile(file, "utf-8").catch(() => null);

describe("CronService when a tick finds jobs.config.json mid-write", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(interruptions)(
    "keeps its jobs, stays armed, and leaves a %s file alone",
    async (_name, interrupt) => {
      const store = await makeStorePath();
      const { cron, state } = await startWithOneJob(store.storePath);
      await interrupt(store.storePath, await fs.readFile(store.storePath, "utf-8"));
      const interrupted = await readOrNull(store.storePath);

      vi.setSystemTime(new Date("2025-12-13T00:01:00.500Z"));
      await runDueJobs(state);

      const status = await cron.status();
      expect(status.jobs).toBe(1);
      expect(status.nextWakeAtMs).not.toBeNull();
      expect(await readOrNull(store.storePath)).toBe(interrupted);

      cron.stop();
      await store.cleanup();
    },
  );

  it("picks up the store again once the external write completes", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const { cron, state } = await startWithOneJob(store.storePath, enqueueSystemEvent);
    const complete = await fs.readFile(store.storePath, "utf-8");
    await fs.writeFile(store.storePath, complete.slice(0, complete.length / 2));

    vi.setSystemTime(new Date("2025-12-13T00:01:00.500Z"));
    await runDueJobs(state);
    await fs.writeFile(store.storePath, complete.replace('"tick"', '"tock"'));
    vi.setSystemTime(new Date("2025-12-13T00:02:00.500Z"));
    await runDueJobs(state);

    expect(enqueueSystemEvent).toHaveBeenLastCalledWith("tock", { agentId: undefined });
    cron.stop();
    await store.cleanup();
  });
});
