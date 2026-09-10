import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const JOB_ID = "committed-format-1";

// The committed store is edited by hand and by scripts; Python's json.dump
// (ensure_ascii=True, the default) escapes every non-ASCII character.
function pythonStyleStore(enabled: boolean) {
  const store = {
    version: 1,
    jobs: [
      {
        id: JOB_ID,
        name: "committed format",
        enabled,
        createdAtMs: 1_765_584_000_000,
        updatedAtMs: 1_765_584_000_000,
        schedule: { kind: "every", everyMs: 600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        mainDeliveryStrategy: "desk",
        payload: { kind: "systemEvent", text: "a → b" },
        state: {},
      },
    ],
  };
  return JSON.stringify(store, null, 2).replace(/→/g, "\\u2192");
}

async function makeStore(contents: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-format-"));
  const storePath = path.join(dir, "cron", "jobs.config.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, contents, "utf-8");
  return {
    storePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function makeCron(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService committed config format", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a committed jobs.config.json byte-identical when the job table is unchanged", async () => {
    const committed = pythonStyleStore(true);
    const store = await makeStore(committed);
    const cron = makeCron(store.storePath);

    await cron.start();

    expect(await fs.readFile(store.storePath, "utf-8")).toBe(committed);
    cron.stop();
    await store.cleanup();
  });

  it("still persists a real change to the job table", async () => {
    const store = await makeStore(pythonStyleStore(true));
    const cron = makeCron(store.storePath);

    await cron.start();
    await cron.update(JOB_ID, { enabled: false });

    const onDisk = JSON.parse(await fs.readFile(store.storePath, "utf-8"));
    expect(onDisk.jobs[0].enabled).toBe(false);
    cron.stop();
    await store.cleanup();
  });
});
