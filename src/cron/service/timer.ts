import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { computeJobNextRunAtMs, nextWakeAtMs, resolveJobPayloadTextForMain } from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist } from "./store.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function armTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
  if (!state.deps.cronEnabled) {
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    return;
  }
  const delay = Math.max(nextAt - state.deps.nowMs(), 0);
  // Avoid TimeoutOverflowWarning when a job is far in the future.
  const clampedDelay = Math.min(delay, MAX_TIMEOUT_MS);
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, clampedDelay);
  state.timer.unref?.();
}

export async function onTimer(state: CronServiceState) {
  if (state.running) {
    return;
  }
  state.running = true;
  try {
    await runDueJobs(state);
  } finally {
    state.running = false;
  }
}

export async function runDueJobs(state: CronServiceState) {
  const dueIds = await locked(state, async () => {
    await ensureLoaded(state);
    if (!state.store) {
      return [];
    }
    const now = state.deps.nowMs();
    const ids = state.store.jobs
      .filter((j) => {
        if (!j.enabled) {
          return false;
        }
        if (typeof j.state.runningAtMs === "number") {
          return false;
        }
        const next = j.state.nextRunAtMs;
        return typeof next === "number" && now >= next;
      })
      .map((j) => j.id);
    if (ids.length === 0) {
      armTimer(state);
    }
    return ids;
  });
  if (dueIds.length === 0) {
    return;
  }
  const now = state.deps.nowMs();
  for (const jobId of dueIds) {
    await executeJob(state, jobId, now, { forced: false });
  }
}

export async function executeJob(
  state: CronServiceState,
  jobId: string,
  nowMs: number,
  opts: { forced: boolean },
  snapshotOverride?: CronJob,
) {
  const startedAt = state.deps.nowMs();
  const snapshot = await locked(state, async () => {
    await ensureLoaded(state);
    const job = state.store?.jobs.find((entry) => entry.id === jobId);
    if (!job) {
      return null;
    }
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;
    job.state.nextRunAtMs = undefined;
    emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });
    await persist(state);
    armTimer(state);
    return typeof structuredClone === "function"
      ? structuredClone(job)
      : (JSON.parse(JSON.stringify(job)) as CronJob);
  });
  const runSnapshot = snapshotOverride ?? snapshot;
  if (!runSnapshot) {
    return;
  }

  let outcome: {
    status: "ok" | "error" | "skipped";
    err?: string;
    errKind?: "invalid-model";
    summary?: string;
    outputText?: string;
  } | null = null;
  try {
    outcome = await runJobCore(state, runSnapshot);
  } catch (err) {
    outcome = { status: "error", err: String(err) };
  }

  await locked(state, async () => {
    await ensureLoaded(state);
    const job = state.store?.jobs.find((entry) => entry.id === jobId);
    if (!job || !outcome) {
      return;
    }
    const endedAt = state.deps.nowMs();
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = startedAt;
    job.state.lastStatus = outcome.status;
    job.state.lastDurationMs = Math.max(0, endedAt - startedAt);
    job.state.lastError = outcome.err;

    const shouldDelete =
      job.schedule.kind === "at" && outcome.status === "ok" && job.deleteAfterRun === true;
    const invalidModel = outcome.status === "error" && outcome.errKind === "invalid-model";

    if (!shouldDelete) {
      if (invalidModel) {
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
        state.deps.log.warn(
          {
            jobId: job.id,
            model: job.payload.kind === "agentTurn" ? job.payload.model : undefined,
          },
          "cron: invalid model; disabling job until fixed",
        );
      } else if (job.schedule.kind === "at" && outcome.status === "ok") {
        // One-shot job completed successfully; disable it.
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (job.enabled) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, endedAt);
      } else {
        job.state.nextRunAtMs = undefined;
      }
    }

    emit(state, {
      jobId: job.id,
      action: "finished",
      status: outcome.status,
      error: outcome.err,
      summary: outcome.summary,
      runAtMs: startedAt,
      durationMs: job.state.lastDurationMs,
      nextRunAtMs: job.state.nextRunAtMs,
    });

    let deleted = false;
    if (shouldDelete && state.store) {
      state.store.jobs = state.store.jobs.filter((entry) => entry.id !== job.id);
      deleted = true;
      emit(state, { jobId: job.id, action: "removed" });
    }

    job.updatedAtMs = nowMs;
    if (!opts.forced && job.enabled && !deleted) {
      // Keep nextRunAtMs in sync in case the schedule advanced during a long run.
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, state.deps.nowMs());
    }
    await persist(state);
    armTimer(state);
  });
}

async function runJobCore(
  state: CronServiceState,
  job: CronJob,
): Promise<{
  status: "ok" | "error" | "skipped";
  err?: string;
  errKind?: "invalid-model";
  summary?: string;
  outputText?: string;
}> {
  if (job.sessionTarget === "main") {
    const text = resolveJobPayloadTextForMain(job);
    if (!text) {
      const kind = job.payload.kind;
      return {
        status: "skipped",
        err:
          kind === "systemEvent"
            ? "main job requires non-empty systemEvent text"
            : 'main job requires payload.kind="systemEvent"',
      };
    }
    state.deps.enqueueSystemEvent(text, { agentId: job.agentId });
    if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
      const reason = `cron:${job.id}`;
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const maxWaitMs = 2 * 60_000;
      const waitStartedAt = state.deps.nowMs();

      let heartbeatResult: HeartbeatRunResult;
      for (;;) {
        heartbeatResult = await state.deps.runHeartbeatOnce({ reason });
        if (
          heartbeatResult.status !== "skipped" ||
          heartbeatResult.reason !== "requests-in-flight"
        ) {
          break;
        }
        if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
          heartbeatResult = {
            status: "skipped",
            reason: "timeout waiting for main lane to become idle",
          };
          break;
        }
        await delay(250);
      }

      if (heartbeatResult.status === "ran") {
        return { status: "ok", summary: text };
      }
      if (heartbeatResult.status === "skipped") {
        return { status: "skipped", err: heartbeatResult.reason, summary: text };
      }
      return { status: "error", err: heartbeatResult.reason, summary: text };
    }
    // wakeMode is "next-heartbeat" or runHeartbeatOnce not available
    state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
    return { status: "ok", summary: text };
  }

  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", err: "isolated job requires payload.kind=agentTurn" };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
  });
  const outcome =
    res.status === "ok"
      ? { status: "ok" as const, summary: res.summary, outputText: res.outputText }
      : res.status === "skipped"
        ? { status: "skipped" as const, summary: res.summary, outputText: res.outputText }
        : {
            status: "error" as const,
            err: res.error ?? "cron job failed",
            errKind: res.errorKind,
            summary: res.summary,
            outputText: res.outputText,
          };

  const prefix = job.isolation?.postToMainPrefix?.trim() || "Cron";
  const mode = job.isolation?.postToMainMode ?? "summary";
  let body = (outcome.summary ?? outcome.err ?? outcome.status).trim();
  if (mode === "full") {
    // Prefer full agent output if available; fall back to summary.
    const maxCharsRaw = job.isolation?.postToMainMaxChars;
    const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(0, maxCharsRaw as number) : 8000;
    const fullText = (outcome.outputText ?? "").trim();
    if (fullText) {
      body = fullText.length > maxChars ? `${fullText.slice(0, maxChars)}…` : fullText;
    }
  }
  const statusPrefix = outcome.status === "ok" ? prefix : `${prefix} (${outcome.status})`;
  state.deps.enqueueSystemEvent(`${statusPrefix}: ${body}`, {
    agentId: job.agentId,
  });
  if (job.wakeMode === "now") {
    state.deps.requestHeartbeatNow({ reason: `cron:${job.id}:post` });
  }

  return outcome;
}

export function wake(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  state.deps.enqueueSystemEvent(text);
  if (opts.mode === "now") {
    state.deps.requestHeartbeatNow({ reason: "wake" });
  }
  return { ok: true } as const;
}

export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
