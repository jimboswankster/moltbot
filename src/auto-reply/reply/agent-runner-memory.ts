import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun } from "./queue.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { lookupContextTokens } from "../../agents/context.js";
import { resolveFallbackCandidates, runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider, resolveConfiguredModelRef } from "../../agents/model-selection.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { type SessionEntry, updateSessionStoreEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { logWarn } from "../../logger.js";
import { buildThreadingToolContext, resolveEnforceFinalTag } from "./agent-runner-utils.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import { incrementCompactionCount } from "./session-updates.js";

const MEMORY_FLUSH_FAILURE_BACKOFF_BASE_MS = 60_000;
const MEMORY_FLUSH_FAILURE_BACKOFF_MAX_MS = 30 * 60_000;

export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
}): Promise<SessionEntry | undefined> {
  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg);
  if (!memoryFlushSettings) {
    return params.sessionEntry;
  }

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.followupRun.run.provider ?? "anthropic",
  });
  const resolvedFlushModel = memoryFlushSettings.model
    ? resolveModelRefFromString({
        raw: memoryFlushSettings.model,
        defaultProvider: params.followupRun.run.provider ?? "anthropic",
        aliasIndex,
      })?.ref
    : null;
  const configuredPrimary = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: params.followupRun.run.provider ?? "anthropic",
    defaultModel: params.followupRun.run.model ?? params.defaultModel,
  });
  const shouldRefreshModel =
    !resolvedFlushModel &&
    configuredPrimary &&
    (configuredPrimary.provider !== params.followupRun.run.provider ||
      configuredPrimary.model !== params.followupRun.run.model);
  const flushProvider =
    resolvedFlushModel?.provider ??
    (shouldRefreshModel ? configuredPrimary?.provider : undefined) ??
    params.followupRun.run.provider;
  const flushModel =
    resolvedFlushModel?.model ??
    (shouldRefreshModel ? configuredPrimary?.model : undefined) ??
    params.followupRun.run.model;

  const isAnyModelAvailable = (() => {
    if (!params.cfg || !params.followupRun.run.agentDir || !flushProvider) {
      return true;
    }
    const authStore = ensureAuthProfileStore(params.followupRun.run.agentDir, {
      allowKeychainPrompt: false,
    });
    if (!authStore) {
      return true;
    }
    const candidates = resolveFallbackCandidates({
      cfg: params.cfg,
      provider: flushProvider,
      model: flushModel ?? params.defaultModel,
    });
    return candidates.some((candidate) => {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      if (profileIds.length === 0) {
        return true;
      }
      return profileIds.some((id) => !isProfileInCooldown(authStore, id));
    });
  })();

  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  const now = Date.now();
  let activeSessionEntry = params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  const memoryFlushState =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    modelId: flushModel ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });
  const resolvedContextFromRegistry = lookupContextTokens(flushModel ?? params.defaultModel);
  const contextDefaulted =
    resolvedContextFromRegistry === undefined && params.agentCfgContextTokens === undefined;
  if (contextDefaulted) {
    const defaultedAt = memoryFlushState?.memoryFlushContextTokensDefaultedAt;
    if (!defaultedAt) {
      logWarn("memory flush context window defaulted; consider configuring model context size");
      if (params.storePath && params.sessionKey) {
        try {
          const updatedEntry = await updateSessionStoreEntry({
            storePath: params.storePath,
            sessionKey: params.sessionKey,
            update: async () => ({
              memoryFlushContextTokensDefaultedAt: Date.now(),
            }),
          });
          if (updatedEntry) {
            activeSessionEntry = updatedEntry;
          }
        } catch (persistErr) {
          logVerbose(
            `failed to persist memory flush context-window default warning: ${String(persistErr)}`,
          );
        }
      }
    }
  }

  const nextAllowedAt = memoryFlushState?.memoryFlushNextAllowedAt ?? 0;
  if (nextAllowedAt && now < nextAllowedAt) {
    logWarn(`memory flush suppressed by backoff until ${new Date(nextAllowedAt).toISOString()}`);
    return params.sessionEntry;
  }

  const shouldFlushMemory =
    memoryFlushSettings &&
    memoryFlushWritable &&
    !params.isHeartbeat &&
    !isCliProvider(params.followupRun.run.provider, params.cfg) &&
    shouldRunMemoryFlush({
      entry:
        params.sessionEntry ??
        (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined),
      contextWindowTokens,
      reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
      softThresholdTokens: memoryFlushSettings.softThresholdTokens,
      isAnyModelAvailable,
    });

  if (!shouldFlushMemory) {
    return params.sessionEntry;
  }

  const flushRunId = crypto.randomUUID();
  if (params.sessionKey) {
    registerAgentRunContext(flushRunId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false;
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    memoryFlushSettings.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    await runWithModelFallback({
      cfg: params.followupRun.run.config,
      provider: flushProvider,
      model: flushModel,
      agentDir: params.followupRun.run.agentDir,
      run: (provider, model) => {
        const authProfileId =
          provider === params.followupRun.run.provider
            ? params.followupRun.run.authProfileId
            : undefined;
        return runEmbeddedPiAgent({
          sessionId: params.followupRun.run.sessionId,
          sessionKey: params.sessionKey,
          messageProvider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
          agentAccountId: params.sessionCtx.AccountId,
          messageTo: params.sessionCtx.OriginatingTo ?? params.sessionCtx.To,
          messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
          // Provider threading context for tool auto-injection
          ...buildThreadingToolContext({
            sessionCtx: params.sessionCtx,
            config: params.followupRun.run.config,
            hasRepliedRef: params.opts?.hasRepliedRef,
          }),
          senderId: params.sessionCtx.SenderId?.trim() || undefined,
          senderName: params.sessionCtx.SenderName?.trim() || undefined,
          senderUsername: params.sessionCtx.SenderUsername?.trim() || undefined,
          senderE164: params.sessionCtx.SenderE164?.trim() || undefined,
          sessionFile: params.followupRun.run.sessionFile,
          workspaceDir: params.followupRun.run.workspaceDir,
          agentDir: params.followupRun.run.agentDir,
          config: params.followupRun.run.config,
          skillsSnapshot: params.followupRun.run.skillsSnapshot,
          prompt: memoryFlushSettings.prompt,
          extraSystemPrompt: flushSystemPrompt,
          ownerNumbers: params.followupRun.run.ownerNumbers,
          enforceFinalTag: resolveEnforceFinalTag(params.followupRun.run, provider),
          provider,
          model,
          authProfileId,
          authProfileIdSource: authProfileId
            ? params.followupRun.run.authProfileIdSource
            : undefined,
          thinkLevel: params.followupRun.run.thinkLevel,
          verboseLevel: params.followupRun.run.verboseLevel,
          reasoningLevel: params.followupRun.run.reasoningLevel,
          execOverrides: params.followupRun.run.execOverrides,
          bashElevated: params.followupRun.run.bashElevated,
          timeoutMs: params.followupRun.run.timeoutMs,
          runId: flushRunId,
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              const willRetry = Boolean(evt.data.willRetry);
              if (phase === "end" && !willRetry) {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
      },
    });
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      const nextCount = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      if (typeof nextCount === "number") {
        memoryFlushCompactionCount = nextCount;
      }
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            memoryFlushAt: Date.now(),
            memoryFlushCompactionCount,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
    if (!memoryCompactionCompleted) {
      logWarn("memory flush completed without compaction event; counters unchanged");
    }
  } catch (err) {
    logWarn(`memory flush run failed: ${String(err)}`);
    if (isDiagnosticsEnabled(params.cfg)) {
      emitDiagnosticEvent({
        type: "memory.flush.failed",
        sessionKey: params.sessionKey,
        sessionId: params.followupRun.run.sessionId,
        provider: flushProvider,
        model: flushModel,
        error: String(err),
      });
    }
    const baseEntry =
      activeSessionEntry ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey] : undefined);
    const failureCount = (baseEntry?.memoryFlushFailureCount ?? 0) + 1;
    const exponent = Math.min(6, Math.max(0, failureCount - 1));
    const backoffMs = Math.min(
      MEMORY_FLUSH_FAILURE_BACKOFF_BASE_MS * 2 ** exponent,
      MEMORY_FLUSH_FAILURE_BACKOFF_MAX_MS,
    );
    const nextAllowed = Date.now() + backoffMs;
    const failurePatch = {
      memoryFlushFailureCount: failureCount,
      memoryFlushLastFailureAt: Date.now(),
      memoryFlushNextAllowedAt: nextAllowed,
    };
    if (activeSessionEntry) {
      Object.assign(activeSessionEntry, failurePatch);
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => failurePatch,
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
        }
      } catch (persistErr) {
        logVerbose(`failed to persist memory flush failure state: ${String(persistErr)}`);
      }
    }
  }

  return activeSessionEntry;
}
