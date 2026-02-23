import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from "../types.js";

export type CronEvent = {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished";
  runId?: string;
  sessionId?: string;
  telemetryId?: string;
  runAtMs?: number;
  durationMs?: number;
  status?: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  nextRunAtMs?: number;
};

export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type CronServiceDeps = {
  nowMs?: () => number;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  /** Workspace root for preCheck scripts (resolved from config). */
  workspaceDir?: string;
  enqueueSystemEvent: (text: string, opts?: { agentId?: string }) => void;
  requestHeartbeatNow: (opts?: { reason?: string }) => void;
  runHeartbeatOnce?: (opts?: { reason?: string }) => Promise<HeartbeatRunResult>;
  runIsolatedAgentJob: (params: {
    job: CronJob;
    message: string;
    runId?: string;
    telemetryId?: string;
  }) => Promise<{
    status: "ok" | "error" | "skipped";
    summary?: string;
    runId?: string;
    sessionId?: string;
    telemetryId?: string;
    /** Last non-empty agent text output (not truncated). */
    outputText?: string;
    error?: string;
    errorKind?: "invalid-model";
  }>;
  /**
   * Optional deterministic command runner for isolated cron jobs with payload.kind="command".
   */
  runCommandJob?: (params: {
    job: CronJob;
    command: string;
    cwd?: string;
    timeoutSeconds?: number;
    runId?: string;
    telemetryId?: string;
  }) => Promise<{
    status: "ok" | "error" | "skipped";
    summary?: string;
    runId?: string;
    telemetryId?: string;
    outputText?: string;
    error?: string;
  }>;
  /**
   * Optional pre-check for isolated jobs. If job.preCheck is set, run this before invoking the agent.
   * Return { pass: true } to proceed, { pass: false, err? } to skip.
   */
  runPreCheck?: (params: {
    scriptPath: string;
    workspaceDir: string;
    args?: string[];
  }) => Promise<{ pass: boolean; err?: string }>;
  onEvent?: (evt: CronEvent) => void;
};

export type CronServiceDepsInternal = Omit<CronServiceDeps, "nowMs"> & {
  nowMs: () => number;
};

export type CronServiceState = {
  deps: CronServiceDepsInternal;
  store: CronStoreFile | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  op: Promise<unknown>;
  warnedDisabled: boolean;
};

export function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
  };
}

export type CronRunMode = "due" | "force";
export type CronWakeMode = "now" | "next-heartbeat";

export type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: false };

export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

export type CronAddResult = CronJob;
export type CronUpdateResult = CronJob;

export type CronListResult = CronJob[];
export type CronAddInput = CronJobCreate;
export type CronUpdateInput = CronJobPatch;
