import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCronStore, saveCronStore } from "./store.js";

describe("cron store split config/state mode", () => {
  it("loads merged jobs from jobs.config.json + jobs.state.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-split-load-"));
    const cronDir = path.join(dir, "cron");
    const storePath = path.join(cronDir, "jobs.json");
    const configPath = path.join(cronDir, "jobs.config.json");
    const statePath = path.join(cronDir, "jobs.state.json");

    await fs.mkdir(cronDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "job-1",
              name: "job-1",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "hi" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [{ id: "job-1", state: { lastStatus: "ok", lastRunAtMs: 123 } }],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.state.lastStatus).toBe("ok");
    expect(loaded.jobs[0]?.state.lastRunAtMs).toBe(123);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes config-only jobs to jobs.config.json and runtime state to jobs.state.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-split-save-"));
    const cronDir = path.join(dir, "cron");
    const storePath = path.join(cronDir, "jobs.json");
    const configPath = path.join(cronDir, "jobs.config.json");
    const statePath = path.join(cronDir, "jobs.state.json");

    await fs.mkdir(cronDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf-8");

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        {
          id: "job-1",
          name: "job-1",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 2,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
          state: { nextRunAtMs: 999, lastStatus: "ok" },
        } as never,
      ],
    });

    const configParsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      jobs: Array<{ state?: Record<string, unknown> }>;
    };
    const stateParsed = JSON.parse(await fs.readFile(statePath, "utf-8")) as {
      jobs: Array<{ state?: Record<string, unknown> }>;
    };
    const legacyMirror = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      jobs: Array<{ state?: Record<string, unknown> }>;
    };

    expect(configParsed.jobs[0]?.state).toEqual({});
    expect(legacyMirror.jobs[0]?.state).toEqual({});
    expect(stateParsed.jobs[0]?.state).toMatchObject({ nextRunAtMs: 999, lastStatus: "ok" });

    await fs.rm(dir, { recursive: true, force: true });
  });
});
