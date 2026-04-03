import type { VerboseLevel } from "../auto-reply/thinking.js";
import { recordRuntimeTelemetryEvent } from "./runtime-telemetry.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
};

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();
const runStartById = new Map<string, number>();
const toolStartById = new Map<string, number>();

function buildToolEventKey(runId: string, toolCallId: string) {
  return `${runId}:${toolCallId}`;
}

function recordMirroredRuntimeTelemetry(event: AgentEventPayload) {
  if (event.stream === "lifecycle") {
    const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
    if (phase === "start") {
      runStartById.set(event.runId, event.ts);
      recordRuntimeTelemetryEvent({
        event: "agent.run_started",
        subsystem: "agent-ops",
        status: "ok",
        details: {
          runId: event.runId,
          sessionKey: event.sessionKey ?? null,
        },
      });
      return;
    }
    if (phase === "end" || phase === "error") {
      const startedAt = runStartById.get(event.runId);
      if (startedAt !== undefined) {
        runStartById.delete(event.runId);
      }
      const durationMs =
        typeof startedAt === "number" && Number.isFinite(startedAt) ? event.ts - startedAt : null;
      recordRuntimeTelemetryEvent({
        event: phase === "end" ? "agent.run_completed" : "agent.run_failed",
        subsystem: "agent-ops",
        severity: phase === "end" ? "info" : "error",
        status: phase === "end" ? "ok" : "failed",
        details: {
          runId: event.runId,
          sessionKey: event.sessionKey ?? null,
          durationMs,
          error:
            phase === "error" && typeof event.data?.error === "string" ? event.data.error : null,
        },
      });
      return;
    }
    return;
  }

  if (event.stream !== "tool") {
    return;
  }

  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  const toolCallId = typeof event.data?.toolCallId === "string" ? event.data.toolCallId.trim() : "";
  const name = typeof event.data?.name === "string" ? event.data.name : null;
  if (!toolCallId) {
    return;
  }
  const key = buildToolEventKey(event.runId, toolCallId);
  if (phase === "start") {
    toolStartById.set(key, event.ts);
    recordRuntimeTelemetryEvent({
      event: "agent.tool_call_started",
      subsystem: "agent-ops",
      status: "ok",
      details: {
        runId: event.runId,
        sessionKey: event.sessionKey ?? null,
        toolCallId,
        toolName: name,
      },
    });
    return;
  }
  if (phase !== "result") {
    return;
  }
  const startedAt = toolStartById.get(key);
  if (startedAt !== undefined) {
    toolStartById.delete(key);
  }
  const durationMs =
    typeof startedAt === "number" && Number.isFinite(startedAt) ? event.ts - startedAt : null;
  const isError = event.data?.isError === true;
  recordRuntimeTelemetryEvent({
    event: isError ? "agent.tool_call_failed" : "agent.tool_call_completed",
    subsystem: "agent-ops",
    severity: isError ? "error" : "info",
    status: isError ? "failed" : "ok",
    details: {
      runId: event.runId,
      sessionKey: event.sessionKey ?? null,
      toolCallId,
      toolName: name,
      durationMs,
      meta: typeof event.data?.meta === "string" ? event.data.meta : null,
    },
  });
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
  runStartById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
  runStartById.clear();
  toolStartById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  // Diagnostic logging for lifecycle events
  if (event.stream === "lifecycle") {
    const phaseRaw = event.data?.phase;
    const phase =
      typeof phaseRaw === "string" ? phaseRaw : phaseRaw == null ? "" : JSON.stringify(phaseRaw);
    console.log(
      `[agent-events] lifecycle event: runId=${event.runId} phase=${phase} sessionKey=${sessionKey ?? "(unknown)"} listeners=${listeners.size}`,
    );
  }
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
  recordMirroredRuntimeTelemetry(enriched);
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
