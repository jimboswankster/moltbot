/**
 * After-tool-call hook wrapper.
 *
 * Invokes the plugin `after_tool_call` hook after each tool execute completes
 * (success or error). Enables delegation-logging and other plugins to observe
 * tool outcomes for telemetry and K-loop routing.
 *
 * See: os/vault/systems/llm-runtime-optimization/implementation/20260212-routing-kernel-discovery-audit.md
 */

import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const log = createSubsystemLogger("agents/tools");

export function wrapToolWithAfterToolCallHook(tool: AnyAgentTool, ctx?: HookContext): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const start = Date.now();
      let result: unknown;
      let error: string | undefined;
      try {
        result = await execute(toolCallId, params, signal, onUpdate);
        return result as any;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        const hookRunner = getGlobalHookRunner();
        if (hookRunner?.hasHooks("after_tool_call")) {
          const durationMs = Date.now() - start;
          const normalizedName = normalizeToolName(toolName);
          try {
            await hookRunner.runAfterToolCall(
              {
                toolName: normalizedName,
                params: isPlainObject(params) ? params : {},
                result,
                error,
                durationMs,
              },
              {
                toolName: normalizedName,
                agentId: ctx?.agentId,
                sessionKey: ctx?.sessionKey,
                runId: ctx?.runId,
              },
            );
          } catch (err) {
            log.warn(
              `after_tool_call hook failed: tool=${normalizedName} toolCallId=${toolCallId ?? "?"} error=${String(err)}`,
            );
          }
        }
      }
    },
  };
}
