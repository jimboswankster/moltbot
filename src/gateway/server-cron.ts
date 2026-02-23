import JSON5 from "json5";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { CliDeps } from "../cli/deps.js";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { emitSystemEvent } from "../telemetry/supabase.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  // Best-effort cache of cron job metadata (name/description/schedule/payload),
  // used to enrich telemetry events beyond raw jobId.
  let cronStoreCache: { ts: number; jobs: any[] } | null = null;
  const cronStoreCacheTtlMs = 60_000;
  const getCronJobMeta = (jobId: string) => {
    try {
      const now = Date.now();
      if (!cronStoreCache || now - cronStoreCache.ts > cronStoreCacheTtlMs) {
        const raw = fs.readFileSync(storePath, "utf-8");
        const parsed = JSON5.parse(raw);
        const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
        cronStoreCache = { ts: now, jobs };
      }
      const job = cronStoreCache.jobs.find((j) => j && j.id === jobId);
      if (!job) return null;
      return {
        id: job.id,
        name: job.name,
        telemetryId: typeof job.telemetryId === "string" ? job.telemetryId : `cron:${job.id}`,
        loadClass: job.loadClass,
        preferredWindow: job.preferredWindow,
        description: job.description,
        enabled: job.enabled,
        deleteAfterRun: job.deleteAfterRun,
        schedule: job.schedule,
        sessionTarget: job.sessionTarget,
        wakeMode: job.wakeMode,
        payload: job.payload,
        mainDeliveryStrategy: job.mainDeliveryStrategy,
        preCheck: job.preCheck,
        isolation: job.isolation,
      };
    } catch {
      return null;
    }
  };

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const runtimeConfig = loadConfig();
  const defaultAgentId = resolveDefaultAgentId(runtimeConfig);
  const workspaceDir = resolveAgentWorkspaceDir(runtimeConfig, defaultAgentId);

  const cron = new CronService({
    storePath,
    cronEnabled,
    workspaceDir,
    runPreCheck: async ({ scriptPath, workspaceDir: cwd, args }) => {
      const result = spawnSync("node", [scriptPath, ...(args ?? [])], {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
      });
      const pass = result.status === 0;
      const err = pass ? undefined : result.stderr?.trim() || `exit ${result.status ?? -1}`;
      return { pass, err };
    },
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveAgentMainSessionKey({
        cfg: runtimeConfig,
        agentId,
      });
      enqueueSystemEvent(text, { sessionKey });
    },
    requestHeartbeatNow,
    runHeartbeatOnce: async (opts) => {
      const runtimeConfig = loadConfig();
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message, runId, telemetryId }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        runId,
        telemetryId,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    runCommandJob: async ({ job, command, cwd, timeoutSeconds, runId, telemetryId }) => {
      const timeoutMs = Math.min(
        Math.max(1_000, Math.floor((timeoutSeconds ?? 300) * 1_000)),
        30 * 60_000,
      );
      const runtimeCwd =
        typeof cwd === "string" && cwd.trim() ? cwd : workspaceDir || process.cwd();
      const startedAt = Date.now();
      const result = await runCommandWithTimeout(["bash", "-lc", command], {
        cwd: runtimeCwd,
        timeoutMs,
      });
      const outputText = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const summary = outputText
        ? outputText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(-1)[0]
        : result.code === 0
          ? "command completed"
          : "command failed";
      const status = result.code === 0 && !result.killed ? ("ok" as const) : ("error" as const);

      emitSystemEvent({
        subsystem: "cron",
        event_type: "cron_command_exec",
        status,
        source: "gateway-cron",
        process_id: job.id,
        process_name: job.name ?? null,
        agent_id: job.agentId ?? null,
        duration_ms: Date.now() - startedAt,
        message: summary?.slice(0, 240) ?? null,
        details: {
          cronJobId: job.id,
          cronJobName: job.name,
          cronRunId: runId,
          telemetryId: telemetryId ?? job.telemetryId ?? `cron:${job.id}`,
          command: command.slice(0, 512),
          cwd: runtimeCwd,
          timeoutMs,
          exitCode: result.code,
          signal: result.signal,
          killed: result.killed,
          stderrChars: result.stderr.length,
          stdoutChars: result.stdout.length,
        },
      });

      return status === "ok"
        ? {
            status,
            summary,
            outputText,
            runId,
            telemetryId,
          }
        : {
            status,
            error:
              result.signal != null
                ? `command terminated by signal ${result.signal}`
                : `command exited with code ${result.code ?? -1}`,
            summary,
            outputText,
            runId,
            telemetryId,
          };
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });

      // Telemetry: emit cron lifecycle events to Supabase (best-effort).
      try {
        if (evt.action === "started") {
          emitSystemEvent({
            subsystem: "cron",
            event_type: "cron_job_started",
            status: "ok",
            source: "gateway-cron",
            process_id: evt.jobId,
            details: {
              jobId: evt.jobId,
              runId: evt.runId,
              sessionId: evt.sessionId,
              telemetryId: evt.telemetryId,
              runAtMs: evt.runAtMs,
              job: getCronJobMeta(evt.jobId),
            },
          });
        }
        if (evt.action === "finished") {
          emitSystemEvent({
            subsystem: "cron",
            event_type: "cron_job_finished",
            status: evt.status ?? "ok",
            source: "gateway-cron",
            process_id: evt.jobId,
            duration_ms: evt.durationMs ?? null,
            message: evt.summary ?? null,
            details: {
              jobId: evt.jobId,
              runId: evt.runId,
              sessionId: evt.sessionId,
              telemetryId: evt.telemetryId,
              status: evt.status,
              error: evt.error,
              runAtMs: evt.runAtMs,
              nextRunAtMs: evt.nextRunAtMs,
              job: getCronJobMeta(evt.jobId),
            },
          });
        }
      } catch {
        // swallow
      }
      if (evt.action === "finished") {
        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          runId: evt.runId,
          sessionId: evt.sessionId,
          telemetryId: evt.telemetryId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
        }).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}
