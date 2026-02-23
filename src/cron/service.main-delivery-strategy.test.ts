import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-main-strategy-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

describe("CronService mainDeliveryStrategy", () => {
  it("defaults main jobs to desk routing reason", async () => {
    const store = await makeStorePath();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    const job = await cron.add({
      name: "main desk default",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });

    await cron.run(job.id, "force");
    expect(requestHeartbeatNow).toHaveBeenCalledWith({ reason: `cron:${job.id}` });

    cron.stop();
    await store.cleanup();
  });

  it("uses main-session heartbeat reason when explicitly configured", async () => {
    const store = await makeStorePath();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    const job = await cron.add({
      name: "main session explicit",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      mainDeliveryStrategy: "main-session",
      payload: { kind: "systemEvent", text: "hello" },
    });

    await cron.run(job.id, "force");
    expect(runHeartbeatOnce).toHaveBeenCalledWith({ reason: `cron-main-session:${job.id}` });

    cron.stop();
    await store.cleanup();
  });

  it("routes external-channel strategy through immediate heartbeat with explicit delivery target", async () => {
    const store = await makeStorePath();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    const job = await cron.add({
      name: "main external direct",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      mainDeliveryStrategy: "external-channel",
      payload: {
        kind: "systemEvent",
        text: "hello",
        channel: "telegram",
        to: "-1001234567890",
      },
    });

    await cron.run(job.id, "force");
    expect(runHeartbeatOnce).toHaveBeenCalledWith({
      reason: `cron-main-session:${job.id}`,
      heartbeat: { target: "telegram", to: "-1001234567890" },
    });

    cron.stop();
    await store.cleanup();
  });

  it("skips external-channel main jobs when wakeMode is not now", async () => {
    const store = await makeStorePath();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    const job = await cron.add({
      name: "main external invalid wake",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      mainDeliveryStrategy: "external-channel",
      payload: { kind: "systemEvent", text: "hello" },
    });

    await cron.run(job.id, "force");
    expect(runHeartbeatOnce).not.toHaveBeenCalled();
    const jobs = await cron.list();
    const saved = jobs.find((entry) => entry.id === job.id);
    expect(saved?.state.lastStatus).toBe("skipped");
    expect(saved?.state.lastError).toContain("requires wakeMode=now");

    cron.stop();
    await store.cleanup();
  });
});
