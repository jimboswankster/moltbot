import type { ChannelId } from "../channels/plugins/types.js";

export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";
export type CronLoadClass = "heavy" | "medium" | "light";
export type CronPreferredWindow = "night" | "shoulder" | "day";

export type CronMessageChannel = ChannelId | "last";

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      /** Optional model override (provider/model or alias). */
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronPayloadPatch =
  | { kind: "systemEvent"; text?: string }
  | {
      kind: "agentTurn";
      message?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronIsolation = {
  postToMainPrefix?: string;
  /**
   * What to post back into the main session after an isolated run.
   * - summary: small status/summary line (default)
   * - full: the agent's final text output (optionally truncated)
   */
  postToMainMode?: "summary" | "full";
  /** Max chars when postToMainMode="full". Default: 8000. */
  postToMainMaxChars?: number;
  /**
   * How to post results back to the main agent after an isolated run.
   * - "direct" (default): inject system event + heartbeat (interrupts main agent)
   * - "desk": write to State Desk via fireDeskAnnounce (non-interrupting)
   */
  postbackStrategy?: "direct" | "desk";
};

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  plannedRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  failureCount?: number;
  nextAllowedAtMs?: number;
};

export type CronPreCheck = {
  script: string;
  args?: string[];
};

export type CronJob = {
  id: string;
  agentId?: string;
  name: string;
  telemetryId?: string;
  loadClass?: CronLoadClass;
  preferredWindow?: CronPreferredWindow;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  isolation?: CronIsolation;
  /** Optional pre-check: run before isolated agent; if script exits non-zero, skip job. */
  preCheck?: CronPreCheck;
  state: CronJobState;
  /** Optional delivery options (e.g. best-effort). */
  delivery?: { bestEffort?: boolean };
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
  preCheck?: CronPreCheck;
};

export type CronJobPatch = Partial<Omit<CronJob, "id" | "createdAtMs" | "state" | "payload">> & {
  payload?: CronPayloadPatch;
  state?: Partial<CronJobState>;
  preCheck?: CronPreCheck | null;
};
