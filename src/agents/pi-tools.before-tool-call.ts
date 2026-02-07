import crypto from "node:crypto";
import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const SIDE_EFFECT_TOOLS = new Set([
  "sessions_send",
  "sessions_spawn",
  "message",
  "browser",
  "nodes",
  "canvas",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

function buildIdempotencyKey(params: {
  runId: string;
  toolName: string;
  payload: Record<string, unknown>;
}) {
  const seed = `${params.runId}:${params.toolName}:${stableStringify(params.payload)}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function applyToolIdempotency(params: {
  toolName: string;
  toolCallId?: string;
  args: unknown;
  ctx?: HookContext;
}): unknown {
  const runId = params.ctx?.runId;
  if (!runId || !runId.startsWith("cron:")) {
    return params.args;
  }
  if (!isPlainObject(params.args)) {
    return params.args;
  }
  const toolName = normalizeToolName(params.toolName || "tool");
  if (!SIDE_EFFECT_TOOLS.has(toolName)) {
    return params.args;
  }
  const existing = params.args.idempotencyKey;
  if (typeof existing === "string" && existing.trim()) {
    return params.args;
  }
  const payload = { ...params.args };
  delete payload.idempotencyKey;
  const idempotencyKey = buildIdempotencyKey({
    runId: params.ctx.runId,
    toolName,
    payload,
  });
  return { ...params.args, idempotencyKey };
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const hookRunner = getGlobalHookRunner();
  const injectedParams = applyToolIdempotency({
    toolName: args.toolName,
    toolCallId: args.toolCallId,
    args: args.params,
    ctx: args.ctx,
  });
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: injectedParams };
  }

  const toolName = normalizeToolName(args.toolName || "tool");
  const params = injectedParams;
  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
        runId: args.ctx?.runId,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      const merged = isPlainObject(params)
        ? { ...params, ...hookResult.params }
        : hookResult.params;
      const nextParams = applyToolIdempotency({
        toolName,
        toolCallId: args.toolCallId,
        args: merged,
        ctx: args.ctx,
      });
      return { blocked: false, params: nextParams };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      return await execute(toolCallId, outcome.params, signal, onUpdate);
    },
  };
}

export const __testing = {
  runBeforeToolCallHook,
  isPlainObject,
};
