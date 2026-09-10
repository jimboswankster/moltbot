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

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-edits-"));
  return {
    storePath: path.join(dir, "cron", "jobs.config.json"),
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

const everyTenMinutes = {
  schedule: { kind: "every" as const, everyMs: 600_000 },
  sessionTarget: "main" as const,
  wakeMode: "next-heartbeat" as const,
};

async function startWithTwoJobs(storePath: string) {
  const cron = makeCron(storePath);
  await cron.start();
  const edited = await cron.add({
    ...everyTenMinutes,
    name: "edited-on-disk",
    enabled: false,
    payload: { kind: "systemEvent", text: "unbound" },
  });
  const other = await cron.add({
    ...everyTenMinutes,
    name: "other",
    enabled: true,
    payload: { kind: "systemEvent", text: "other" },
  });
  return { cron, edited: edited.id, other: other.id };
}

// A develop merge or an operator splice lands in the checkout between ticks.
async function editOnDisk(storePath: string, id: string) {
  const doc = JSON.parse(await fs.readFile(storePath, "utf-8"));
  const job = doc.jobs.find((entry: { id: string }) => entry.id === id);
  job.enabled = true;
  job.payload.text = "bound";
  await fs.writeFile(storePath, JSON.stringify(doc, null, 2));
}

type Writer = (ctx: { cron: CronService; other: string; storePath: string }) => Promise<unknown>;
const writers: Array<[string, Writer]> = [
  ["update", ({ cron, other }) => cron.update(other, { enabled: false })],
  [
    "add",
    ({ cron }) =>
      cron.add({
        ...everyTenMinutes,
        name: "added",
        enabled: true,
        payload: { kind: "systemEvent", text: "added" },
      }),
  ],
  ["remove", ({ cron, other }) => cron.remove(other)],
  [
    "start of a second service in the same process",
    async ({ storePath }) => {
      const again = makeCron(storePath);
      await again.start();
      again.stop();
    },
  ],
];

describe("CronService writes after jobs.config.json was edited on disk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(writers)("%s keeps an edit made on disk since the last tick", async (_name, write) => {
    const store = await makeStorePath();
    const { cron, edited, other } = await startWithTwoJobs(store.storePath);
    await editOnDisk(store.storePath, edited);

    await write({ cron, other, storePath: store.storePath });

    const onDisk = JSON.parse(await fs.readFile(store.storePath, "utf-8")).jobs.find(
      (entry: { id: string }) => entry.id === edited,
    );
    expect({ enabled: onDisk.enabled, text: onDisk.payload.text }).toEqual({
      enabled: true,
      text: "bound",
    });
    cron.stop();
    await store.cleanup();
  });

  it("refuses a change while the file is mid-write, and leaves it alone", async () => {
    const store = await makeStorePath();
    const { cron, other } = await startWithTwoJobs(store.storePath);
    const complete = await fs.readFile(store.storePath, "utf-8");
    const halfWritten = complete.slice(0, complete.length / 2);
    await fs.writeFile(store.storePath, halfWritten);

    await expect(cron.update(other, { enabled: false })).rejects.toThrow(/unreadable/);

    expect(await fs.readFile(store.storePath, "utf-8")).toBe(halfWritten);
    cron.stop();
    await store.cleanup();
  });
});
