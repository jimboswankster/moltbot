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
        description: job.description,
        enabled: job.enabled,
        deleteAfterRun: job.deleteAfterRun,
        schedule: job.schedule,
        sessionTarget: job.sessionTarget,
        wakeMode: job.wakeMode,
        payload: job.payload,
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
    runIsolatedAgentJob: async ({ job, message }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
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
