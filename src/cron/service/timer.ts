import crypto from "node:crypto";
import path from "node:path";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { emitSystemEvent } from "../../telemetry/supabase.js";
import { computeJobNextRunAtMs, nextWakeAtMs, resolveJobPayloadTextForMain } from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist, reloadFromDisk } from "./store.js";

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
    await reloadFromDisk(state);
    if (!state.store) {
      return [];
    }
    const now = state.deps.nowMs();
    let mutated = false;
    const ids = state.store.jobs
      .filter((j) => {
        if (!j.enabled) {
          return false;
        }
        if (typeof j.state.runningAtMs === "number") {
          return false;
        }
        const nextAllowed = j.state.nextAllowedAtMs;
        let next = j.state.nextRunAtMs;
        if (typeof next !== "number") {
          next = computeJobNextRunAtMs(j, now);
          if (typeof next === "number") {
            j.state.nextRunAtMs = next;
            mutated = true;
          }
        }
        if (typeof nextAllowed === "number" && now < nextAllowed) {
          if (!next || next < nextAllowed) {
            j.state.nextRunAtMs = nextAllowed;
            mutated = true;
          }
          return false;
        }
        return typeof next === "number" && now >= next;
      })
      .map((j) => j.id);
    if (mutated) {
      await persist(state);
    }
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
  const runId = crypto.randomUUID();
  const snapshot = await locked(state, async () => {
    await reloadFromDisk(state);
    const job = state.store?.jobs.find((entry) => entry.id === jobId);
    if (!job) {
      return null;
    }
    if (!opts.forced) {
      if (!job.enabled) {
        return null;
      }
      if (typeof job.state.runningAtMs === "number") {
        return null;
      }
      const nextAllowed = job.state.nextAllowedAtMs;
      if (typeof nextAllowed === "number" && startedAt < nextAllowed) {
        return null;
      }
      const nextRunAtMs = job.state.nextRunAtMs;
      if (typeof nextRunAtMs !== "number" || startedAt < nextRunAtMs) {
        return null;
      }
    }
    const plannedRunAtMs =
      !opts.forced &&
      job.state.lastStatus === "error" &&
      typeof job.state.plannedRunAtMs === "number"
        ? job.state.plannedRunAtMs
        : (job.state.nextRunAtMs ?? startedAt);
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;
    job.state.plannedRunAtMs = plannedRunAtMs;
    job.state.nextRunAtMs = undefined;
    emit(state, {
      jobId: job.id,
      action: "started",
      runId,
      telemetryId: job.telemetryId ?? `cron:${job.id}`,
      runAtMs: startedAt,
    });
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
    runId?: string;
    sessionId?: string;
    telemetryId?: string;
    outputText?: string;
  } | null = null;
  try {
    outcome = await runJobCore(state, runSnapshot, {
      runId,
      telemetryId: runSnapshot.telemetryId ?? `cron:${runSnapshot.id}`,
    });
  } catch (err) {
    outcome = {
      status: "error",
      err: String(err),
      runId,
      telemetryId: runSnapshot.telemetryId ?? `cron:${runSnapshot.id}`,
    };
  }

  await locked(state, async () => {
    await reloadFromDisk(state);
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
    if (outcome.status === "ok") {
      job.state.failureCount = undefined;
      job.state.nextAllowedAtMs = undefined;
      job.state.plannedRunAtMs = undefined;
    }
    if (outcome.status === "skipped") {
      job.state.plannedRunAtMs = undefined;
    }
    if (outcome.status === "error" && job.enabled) {
      const failureCount = (job.state.failureCount ?? 0) + 1;
      const exponent = Math.min(6, Math.max(0, failureCount - 1));
      const backoffMs = Math.min(60_000 * 2 ** exponent, 30 * 60_000);
      job.state.failureCount = failureCount;
      job.state.nextAllowedAtMs = endedAt + backoffMs;
    }

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
        const nextRun = computeJobNextRunAtMs(job, endedAt);
        const nextAllowed = job.state.nextAllowedAtMs;
        if (typeof nextAllowed === "number") {
          job.state.nextRunAtMs = nextRun ? Math.max(nextRun, nextAllowed) : nextAllowed;
        } else {
          job.state.nextRunAtMs = nextRun;
        }
      } else {
        job.state.nextRunAtMs = undefined;
      }
    }

    emit(state, {
      jobId: job.id,
      action: "finished",
      runId: outcome.runId ?? runId,
      sessionId: outcome.sessionId,
      telemetryId: outcome.telemetryId ?? job.telemetryId ?? `cron:${job.id}`,
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
      const nextRun = computeJobNextRunAtMs(job, state.deps.nowMs());
      const nextAllowed = job.state.nextAllowedAtMs;
      if (typeof nextAllowed === "number") {
        job.state.nextRunAtMs = nextRun ? Math.max(nextRun, nextAllowed) : nextAllowed;
      } else {
        job.state.nextRunAtMs = nextRun;
      }
    }
    await persist(state);
    armTimer(state);
  });
}

async function runJobCore(
  state: CronServiceState,
  job: CronJob,
  runContext: { runId: string; telemetryId: string },
): Promise<{
  status: "ok" | "error" | "skipped";
  err?: string;
  errKind?: "invalid-model";
  summary?: string;
  runId?: string;
  sessionId?: string;
  telemetryId?: string;
  outputText?: string;
}> {
  if (job.sessionTarget === "main") {
    const text = resolveJobPayloadTextForMain(job);
    if (!text) {
      const kind = job.payload.kind;
      return {
        status: "skipped",
        runId: runContext.runId,
        telemetryId: runContext.telemetryId,
        err:
          kind === "systemEvent"
            ? "main job requires non-empty systemEvent text"
            : 'main job requires payload.kind="systemEvent"',
      };
    }
    state.deps.enqueueSystemEvent(text, { agentId: job.agentId });
    // Telemetry: record delivery intent for main-lane system events.
    emitSystemEvent({
      subsystem: "delivery",
      event_type: "system_event_enqueued",
      status: "ok",
      source: "cron",
      process_id: job.id,
      process_name: job.name ?? null,
      agent_id: job.agentId ?? null,
      message: text.slice(0, 240),
      details: {
        cronJobId: job.id,
        cronRunId: runContext.runId,
        telemetryId: runContext.telemetryId,
        cronJobName: job.name,
        sessionTarget: job.sessionTarget,
        wakeMode: job.wakeMode,
        textChars: text.length,
      },
    });
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
        return {
          status: "ok",
          summary: text,
          runId: runContext.runId,
          telemetryId: runContext.telemetryId,
        };
      }
      if (heartbeatResult.status === "skipped") {
        return {
          status: "skipped",
          err: heartbeatResult.reason,
          summary: text,
          runId: runContext.runId,
          telemetryId: runContext.telemetryId,
        };
      }
      return {
        status: "error",
        err: heartbeatResult.reason,
        summary: text,
        runId: runContext.runId,
        telemetryId: runContext.telemetryId,
      };
    }
    // wakeMode is "next-heartbeat" or runHeartbeatOnce not available
    state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
    return {
      status: "ok",
      summary: text,
      runId: runContext.runId,
      telemetryId: runContext.telemetryId,
    };
  }

  if (job.payload.kind !== "agentTurn" && job.payload.kind !== "command") {
    return {
      status: "skipped",
      err: "isolated job requires payload.kind=agentTurn or payload.kind=command",
      runId: runContext.runId,
      telemetryId: runContext.telemetryId,
    };
  }

  if (job.preCheck && state.deps.runPreCheck && state.deps.workspaceDir) {
    const scriptPath = path.join(state.deps.workspaceDir, job.preCheck.script);
    const result = await state.deps.runPreCheck({
      scriptPath,
      workspaceDir: state.deps.workspaceDir,
      args: job.preCheck.args,
    });
    if (!result.pass) {
      return {
        status: "skipped",
        err: result.err ?? "preCheck gate skipped",
        runId: runContext.runId,
        telemetryId: runContext.telemetryId,
      };
    }
  }

  const outcome =
    job.payload.kind === "command"
      ? await (async () => {
          if (!state.deps.runCommandJob) {
            return {
              status: "error" as const,
              err: "command runner unavailable",
              runId: runContext.runId,
              telemetryId: runContext.telemetryId,
            };
          }
          const commandResult = await state.deps.runCommandJob({
            job,
            command: job.payload.command,
            cwd: job.payload.cwd,
            timeoutSeconds: job.payload.timeoutSeconds,
            runId: runContext.runId,
            telemetryId: runContext.telemetryId,
          });
          emitSystemEvent({
            subsystem: "cron",
            event_type: "cron_command_job_executed",
            status: commandResult.status,
            source: "cron-command",
            process_id: job.id,
            process_name: job.name ?? null,
            agent_id: job.agentId ?? null,
            message: (commandResult.summary ?? commandResult.error ?? "").slice(0, 240),
            details: {
              cronJobId: job.id,
              cronRunId: commandResult.runId ?? runContext.runId,
              telemetryId: commandResult.telemetryId ?? runContext.telemetryId,
              cronJobName: job.name,
              sessionTarget: job.sessionTarget,
              wakeMode: job.wakeMode,
              command: job.payload.command.slice(0, 512),
              cwd: job.payload.cwd ?? null,
              timeoutSeconds: job.payload.timeoutSeconds ?? null,
            },
          });
          return commandResult.status === "ok"
            ? {
                status: "ok" as const,
                summary: commandResult.summary,
                outputText: commandResult.outputText,
                runId: commandResult.runId ?? runContext.runId,
                telemetryId: commandResult.telemetryId ?? runContext.telemetryId,
              }
            : commandResult.status === "skipped"
              ? {
                  status: "skipped" as const,
                  err: commandResult.error,
                  summary: commandResult.summary,
                  outputText: commandResult.outputText,
                  runId: commandResult.runId ?? runContext.runId,
                  telemetryId: commandResult.telemetryId ?? runContext.telemetryId,
                }
              : {
                  status: "error" as const,
                  err: commandResult.error ?? "cron command failed",
                  summary: commandResult.summary,
                  outputText: commandResult.outputText,
                  runId: commandResult.runId ?? runContext.runId,
                  telemetryId: commandResult.telemetryId ?? runContext.telemetryId,
                };
        })()
      : await (async () => {
          const res = await state.deps.runIsolatedAgentJob({
            job,
            message: job.payload.message,
            runId: runContext.runId,
            telemetryId: runContext.telemetryId,
          });
          return res.status === "ok"
            ? {
                status: "ok" as const,
                summary: res.summary,
                outputText: res.outputText,
                runId: res.runId ?? runContext.runId,
                sessionId: res.sessionId,
                telemetryId: res.telemetryId ?? runContext.telemetryId,
              }
            : res.status === "skipped"
              ? {
                  status: "skipped" as const,
                  summary: res.summary,
                  outputText: res.outputText,
                  runId: res.runId ?? runContext.runId,
                  sessionId: res.sessionId,
                  telemetryId: res.telemetryId ?? runContext.telemetryId,
                }
              : {
                  status: "error" as const,
                  err: res.error ?? "cron job failed",
                  errKind: res.errorKind,
                  summary: res.summary,
                  outputText: res.outputText,
                  runId: res.runId ?? runContext.runId,
                  sessionId: res.sessionId,
                  telemetryId: res.telemetryId ?? runContext.telemetryId,
                };
        })();

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
  const requesterAgentId =
    typeof job.agentId === "string" && job.agentId.trim().length > 0 ? job.agentId.trim() : "main";
  const requesterSessionKey = `agent:${requesterAgentId}:main`;
  const triggerMessage = `${statusPrefix}: ${body}`;
  const traceId = `${job.id}:${outcome.runId ?? runContext.runId}`;
  const trace = {
    traceId,
    cronJobId: job.id,
    cronRunId: outcome.runId ?? runContext.runId,
    telemetryId: outcome.telemetryId ?? runContext.telemetryId,
    source: "cron",
  } as const;

  // Desk postback strategy: route result to State Desk instead of direct interrupt
  if (job.isolation?.postbackStrategy === "desk") {
    emitSystemEvent({
      subsystem: "delivery",
      event_type: "cron_desk_handoff_attempt",
      status: "ok",
      source: "cron-desk",
      process_id: job.id,
      process_name: job.name ?? null,
      agent_id: requesterAgentId,
      message: triggerMessage.slice(0, 240),
      details: {
        ...trace,
        cronJobName: job.name,
        sessionTarget: job.sessionTarget,
        wakeMode: job.wakeMode,
        requesterSessionKey,
      },
    });
    try {
      const { fireDeskAnnounce } = await import("../../agents/subagent-announce.js");
      const handled = await fireDeskAnnounce({
        childSessionKey: `cron:${job.id}`,
        childRunId: job.id,
        requesterSessionKey,
        task: job.name ?? job.id,
        label: job.name ?? job.id,
        triggerMessage,
        outcome: { status: outcome.status, error: outcome.err },
        trace,
      });
      if (handled) {
        emitSystemEvent({
          subsystem: "delivery",
          event_type: "cron_desk_handoff_enqueued",
          status: "ok",
          source: "cron-desk",
          process_id: job.id,
          process_name: job.name ?? null,
          agent_id: requesterAgentId,
          message: triggerMessage.slice(0, 240),
          details: {
            ...trace,
            cronJobName: job.name,
            requesterSessionKey,
            postbackStrategy: "desk",
          },
        });
        return outcome;
      }
      // H2 Fail-to-Direct: desk handler failed, fall through to direct postback
      emitSystemEvent({
        subsystem: "delivery",
        event_type: "cron_desk_handoff_fallback",
        status: "degraded",
        source: "cron-desk",
        process_id: job.id,
        process_name: job.name ?? null,
        agent_id: requesterAgentId,
        message: "desk handler returned false; using direct postback",
        details: {
          ...trace,
          cronJobName: job.name,
          requesterSessionKey,
          reason: "desk_handler_returned_false",
        },
      });
    } catch {
      // fireDeskAnnounce not available or threw — fall through to direct
      emitSystemEvent({
        subsystem: "delivery",
        event_type: "cron_desk_handoff_fallback",
        status: "degraded",
        source: "cron-desk",
        process_id: job.id,
        process_name: job.name ?? null,
        agent_id: requesterAgentId,
        message: "desk handler unavailable or threw; using direct postback",
        details: {
          ...trace,
          cronJobName: job.name,
          requesterSessionKey,
          reason: "desk_handler_threw_or_unavailable",
        },
      });
    }
  }

  const postbackText = triggerMessage;
  state.deps.enqueueSystemEvent(postbackText, {
    agentId: job.agentId,
  });
  // Telemetry: isolated job postback (system event to main lane)
  emitSystemEvent({
    subsystem: "delivery",
    event_type: "system_event_enqueued",
    status: outcome.status === "ok" ? "ok" : outcome.status,
    source: "cron-postback",
    process_id: job.id,
    process_name: job.name ?? null,
    agent_id: job.agentId ?? null,
    message: postbackText.slice(0, 240),
    details: {
      cronJobId: job.id,
      cronRunId: outcome.runId ?? runContext.runId,
      telemetryId: outcome.telemetryId ?? runContext.telemetryId,
      cronJobName: job.name,
      sessionTarget: job.sessionTarget,
      wakeMode: job.wakeMode,
      postbackMode: mode,
      textChars: postbackText.length,
    },
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
