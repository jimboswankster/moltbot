import JSON5 from "json5";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CronJobState, CronStoreFile } from "./types.js";
import { CONFIG_DIR } from "../utils.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.config.json");

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(raw.replace("~", os.homedir()));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH;
}

type CronStateStoreFile = {
  version: 1;
  jobs: Array<{
    id: string;
    state?: CronJobState;
  }>;
};

export class CronStoreReadError extends Error {
  constructor(storePath: string, cause: unknown) {
    super(`cron store unreadable: ${storePath}`, { cause });
    this.name = "CronStoreReadError";
  }
}

async function resolveWritableStorePath(storePath: string): Promise<string> {
  try {
    const stat = await fs.promises.lstat(storePath);
    if (stat.isSymbolicLink()) {
      return await fs.promises.realpath(storePath);
    }
  } catch {
    // If storePath does not exist yet, write directly to it.
  }
  return storePath;
}

async function readJson5File(filePath: string): Promise<unknown> {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  return JSON5.parse(raw);
}

function coerceCronJobs(parsed: unknown): CronStoreFile["jobs"] {
  const jobs =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? ((parsed as { jobs: unknown[] }).jobs as never[])
      : [];
  return jobs.filter(Boolean) as never as CronStoreFile["jobs"];
}

function stripRuntimeStateForConfig(store: CronStoreFile): CronStoreFile {
  return {
    version: 1,
    jobs: store.jobs.map((job) => ({
      ...job,
      state: {},
    })),
  };
}

function projectRuntimeState(store: CronStoreFile): CronStateStoreFile {
  return {
    version: 1,
    jobs: store.jobs.map((job) => ({
      id: job.id,
      state: job.state ?? {},
    })),
  };
}

function mergeConfigAndRuntimeState(
  configStore: CronStoreFile,
  runtimeStateStore: CronStateStoreFile,
): CronStoreFile {
  const byId = new Map(
    (runtimeStateStore.jobs ?? [])
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => [entry.id, entry.state ?? {}] as const),
  );
  return {
    version: 1,
    jobs: configStore.jobs.map((job) => ({
      ...job,
      state: byId.get(job.id) ?? job.state ?? {},
    })),
  };
}

function splitPathsForStorePath(storePath: string) {
  const dir = path.dirname(storePath);
  const base = path.basename(storePath);
  const configPath = base === "jobs.config.json" ? storePath : path.join(dir, "jobs.config.json");
  return {
    configPath,
    statePath: path.join(dir, "jobs.state.json"),
  };
}

async function fileHoldsJson(filePath: string, value: unknown): Promise<boolean> {
  try {
    const existing = await readJson5File(filePath);
    return isDeepStrictEqual(existing, JSON.parse(JSON.stringify(value)));
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(value, null, 2);
  try {
    const existing = await fs.promises.readFile(filePath, "utf-8");
    if (existing === json) {
      return;
    }
  } catch {
    // File missing or unreadable; continue with write.
  }
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, filePath);
  try {
    await fs.promises.copyFile(filePath, `${filePath}.bak`);
  } catch {
    // best-effort
  }
}

/**
 * `strict` reports an unreadable store (missing, or mid-write by an external
 * writer) as a CronStoreReadError instead of as an empty job table.
 */
export async function loadCronStore(
  storePath: string,
  opts: { strict?: boolean } = {},
): Promise<CronStoreFile> {
  const writePath = await resolveWritableStorePath(storePath);
  const { configPath, statePath } = splitPathsForStorePath(writePath);
  let configPresent = false;
  try {
    await fs.promises.access(configPath, fs.constants.F_OK);
    configPresent = true;
    const configParsed = await readJson5File(configPath);
    const configStore: CronStoreFile = {
      version: 1,
      jobs: coerceCronJobs(configParsed),
    };
    try {
      const stateParsed = await readJson5File(statePath);
      const runtimeStateStore: CronStateStoreFile = {
        version: 1,
        jobs:
          stateParsed &&
          typeof stateParsed === "object" &&
          Array.isArray((stateParsed as { jobs?: unknown }).jobs)
            ? ((stateParsed as { jobs: unknown[] }).jobs as never as CronStateStoreFile["jobs"])
            : [],
      };
      return mergeConfigAndRuntimeState(configStore, runtimeStateStore);
    } catch {
      return configStore;
    }
  } catch (err) {
    if (opts.strict && configPresent) {
      throw new CronStoreReadError(configPath, err);
    }
    // No split config present; fall back to legacy single-file store.
  }

  try {
    const parsed = await readJson5File(storePath);
    return {
      version: 1,
      jobs: coerceCronJobs(parsed),
    };
  } catch (err) {
    if (opts.strict) {
      throw new CronStoreReadError(storePath, err);
    }
    return { version: 1, jobs: [] };
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  const writePath = await resolveWritableStorePath(storePath);
  const { configPath, statePath } = splitPathsForStorePath(writePath);
  try {
    await fs.promises.access(configPath, fs.constants.F_OK);
    const configStore = stripRuntimeStateForConfig(store);
    const stateStore = projectRuntimeState(store);
    // The config is committed and hand-edited; rewrite it only when the job
    // table changed, so re-serializing never dirties the checkout.
    if (!(await fileHoldsJson(configPath, configStore))) {
      await writeJsonAtomic(configPath, configStore);
    }
    await writeJsonAtomic(statePath, stateStore);
    return;
  } catch {
    // No split config file exists; persist legacy single-file store.
  }
  await writeJsonAtomic(writePath, store);
}
