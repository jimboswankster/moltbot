import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import type { UsageLike } from "../../usage.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";
import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import {
  loadMemoryCompanionAdapter,
  type MemoryCompanionAdapter,
} from "../../../infra/memory-companion-adapter.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../../../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../../telegram/reaction-level.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../../channel-tools.js";
import { resolveOpenClawDocsPath } from "../../docs-path.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import {
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import {
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
} from "../../pi-settings.js";
import { toClientToolDefinitions } from "../../pi-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "../../pi-tools.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { isAbortError } from "../abort.js";
import { appendCacheTtlTimestamp, isCacheTtlEligibleProvider } from "../cache-ttl.js";
import { buildEmbeddedExtensionPaths } from "../extensions.js";
import { applyExtraParamsToAgent } from "../extra-params.js";
import {
  logToolSchemasForGoogle,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "../google.js";
import {
  capToolResultSize,
  getDmHistoryLimitFromSessionKey,
  limitHistoryTurns,
  limitToolResults,
  stripLegacySessionMemoryBlocks,
  type ToolResultCapPolicy,
} from "../history.js";
import { log } from "../logger.js";
import { buildModelAliasLines } from "../model.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";
import {
  deriveContextLimits,
  fitToTokenBudget,
  resolveProviderInputCapRule,
} from "../token-budget.js";
import { splitSdkTools } from "../tool-split.js";
import { describeUnknownError, mapThinkingLevel } from "../utils.js";
import { detectAndLoadPromptImages } from "./images.js";

export function injectHistoryImagesIntoMessages(
  messages: AgentMessage[],
  historyImagesByIndex: Map<number, ImageContent[]>,
): boolean {
  if (historyImagesByIndex.size === 0) {
    return false;
  }
  let didMutate = false;

  for (const [msgIndex, images] of historyImagesByIndex) {
    // Bounds check: ensure index is valid before accessing
    if (msgIndex < 0 || msgIndex >= messages.length) {
      continue;
    }
    const msg = messages[msgIndex];
    if (msg && msg.role === "user") {
      // Convert string content to array format if needed
      if (typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content }];
        didMutate = true;
      }
      if (Array.isArray(msg.content)) {
        // Check for existing image content to avoid duplicates across turns
        const existingImageData = new Set(
          msg.content
            .filter(
              (c): c is ImageContent =>
                c != null &&
                typeof c === "object" &&
                c.type === "image" &&
                typeof c.data === "string",
            )
            .map((c) => c.data),
        );
        for (const img of images) {
          // Only add if this image isn't already in the message
          if (!existingImageData.has(img.data)) {
            msg.content.push(img);
            didMutate = true;
          }
        }
      }
    }
  }

  return didMutate;
}

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const prevCwd = process.cwd();
  const runAbortController = new AbortController();

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );
  console.log(`[attempt] checkpoint 1: mkdir workspace runId=${params.runId}`);

  await fs.mkdir(resolvedWorkspace, { recursive: true });
  console.log(`[attempt] checkpoint 2: resolveSandboxContext runId=${params.runId}`);

  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  console.log(`[attempt] checkpoint 3: sandbox resolved runId=${params.runId}`);
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  console.log(`[attempt] checkpoint 4: effectiveWorkspace created runId=${params.runId}`);

  let restoreSkillEnv: (() => void) | undefined;
  process.chdir(effectiveWorkspace);
  try {
    const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
    const skillEntries = shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(effectiveWorkspace)
      : [];
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });

    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles } =
      await resolveBootstrapContextForRun({
        workspaceDir: effectiveWorkspace,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
      });
    const workspaceNotes = hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
      ? ["Reminder: commit your changes in this workspace after edits."]
      : undefined;

    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
    console.log(`[attempt] checkpoint 5: skills resolved runId=${params.runId}`);

    // Check if the model supports native image input
    const modelHasVision = params.model.input?.includes("image") ?? false;
    console.log(`[attempt] checkpoint 6: creating tools runId=${params.runId}`);
    const toolsRaw = params.disableTools
      ? []
      : createOpenClawCodingTools({
          exec: {
            ...params.execOverrides,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: params.model.provider,
          modelId: params.modelId,
          modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          modelHasVision,
          runId: params.runId,
        });
    const tools = sanitizeToolsForGoogle({ tools: toolsRaw, provider: params.provider });
    logToolSchemasForGoogle({ tools, provider: params.provider });
    console.log(
      `[attempt] checkpoint 7: tools created (${tools.length} tools) runId=${params.runId}`,
    );

    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        }) ?? [])
      : undefined;
    if (runtimeChannel === "telegram" && params.config) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: params.config,
        accountId: params.agentAccountId ?? undefined,
      });
      if (inlineButtonsScope !== "off") {
        if (!runtimeCapabilities) {
          runtimeCapabilities = [];
        }
        if (
          !runtimeCapabilities.some((cap) => String(cap).trim().toLowerCase() === "inlinebuttons")
        ) {
          runtimeCapabilities.push("inlineButtons");
        }
      }
    }
    const reactionGuidance =
      runtimeChannel && params.config
        ? (() => {
            if (runtimeChannel === "telegram") {
              const resolved = resolveTelegramReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Telegram" } : undefined;
            }
            if (runtimeChannel === "signal") {
              const resolved = resolveSignalReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Signal" } : undefined;
            }
            return undefined;
          })()
        : undefined;
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(params.provider);
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions({
          cfg: params.config,
          channel: runtimeChannel,
        })
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: sessionAgentId,
    });
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: process.cwd(),
      runtime: {
        host: machineName,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        channel: runtimeChannel,
        capabilities: runtimeCapabilities,
        channelActions,
      },
    });
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    const promptMode = isSubagentSessionKey(params.sessionKey) ? "minimal" : "full";
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;

    const appendPrompt = buildEmbeddedSystemPrompt({
      workspaceDir: effectiveWorkspace,
      defaultThinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel ?? "off",
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      reasoningTagHint,
      heartbeatPrompt: isDefaultAgent
        ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
        : undefined,
      skillsPrompt,
      docsPath: docsPath ?? undefined,
      ttsHint,
      workspaceNotes,
      reactionGuidance,
      promptMode,
      runtimeInfo,
      messageToolHints,
      sandboxInfo,
      tools,
      modelAliasLines: buildModelAliasLines(params.config),
      userTimezone,
      userTime,
      userTimeFormat,
      contextFiles,
      memoryCitationsMode: params.config?.memory?.citations,
    });
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.modelId,
      workspaceDir: effectiveWorkspace,
      bootstrapMaxChars: resolveBootstrapMaxChars(params.config),
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: params.sessionKey ?? params.sessionId,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      systemPrompt: appendPrompt,
      bootstrapFiles: hookAdjustedBootstrapFiles,
      injectedFiles: contextFiles,
      skillsPrompt,
      tools,
    });
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);
    const systemPromptText = systemPromptOverride();

    console.log(
      `[attempt] checkpoint 8a: acquiring session lock runId=${params.runId} sessionFile=${params.sessionFile}`,
    );
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
    });
    console.log(`[attempt] checkpoint 8b: session lock acquired runId=${params.runId}`);

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: params.model?.api,
        provider: params.provider,
        modelId: params.modelId,
      });

      await prewarmSessionFile(params.sessionFile);
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
      });
      trackSessionManagerAccess(params.sessionFile);

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      const settingsManager = SettingsManager.create(effectiveWorkspace, agentDir);
      ensurePiCompactionReserveTokens({
        settingsManager,
        minReserveTokens: resolveCompactionReserveTokensFloor(params.config),
      });

      // Call for side effects (sets compaction/pruning runtime state)
      buildEmbeddedExtensionPaths({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });

      const { builtInTools, customTools } = splitSdkTools({
        tools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      // Add client tools (OpenResponses hosted tools) to customTools
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      const clientToolDefs = params.clientTools
        ? toClientToolDefinitions(
            params.clientTools,
            (toolName, toolParams) => {
              clientToolCallDetected = { name: toolName, params: toolParams };
            },
            {
              agentId: sessionAgentId,
              sessionKey: params.sessionKey,
            },
          )
        : [];

      const allCustomTools = [...customTools, ...clientToolDefs];

      console.log(`[attempt] checkpoint 9a: createAgentSession runId=${params.runId}`);
      ({ session } = await createAgentSession({
        cwd: resolvedWorkspace,
        agentDir,
        authStorage: params.authStorage,
        modelRegistry: params.modelRegistry,
        model: params.model,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        tools: builtInTools,
        customTools: allCustomTools,
        sessionManager,
        settingsManager,
      }));
      console.log(`[attempt] checkpoint 9b: session created runId=${params.runId}`);
      applySystemPromptOverrideToSession(session, systemPromptText);
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      const activeSession = session;
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });

      // Force a stable streamFn reference so vitest can reliably mock @mariozechner/pi-ai.
      activeSession.agent.streamFn = streamSimple;

      applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        params.streamParams,
      );

      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          system: systemPromptText,
          note: "after session create",
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }
      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }

      // Memory Companion: load adapter (if extension enabled) for memory-aware limiting.
      // Hoisted above try block so sessionMemory is accessible for prompt injection and post-turn.
      let mcAdapter: MemoryCompanionAdapter | null = null;
      let mcSessionMemory: string | undefined;

      try {
        const prior = await sanitizeSessionHistory({
          messages: activeSession.messages,
          modelApi: params.model.api,
          modelId: params.modelId,
          provider: params.provider,
          sessionManager,
          sessionId: params.sessionId,
          policy: transcriptPolicy,
        });
        cacheTrace?.recordStage("session:sanitized", { messages: prior });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prior)
          : prior;
        const validated = transcriptPolicy.validateAnthropicTurns
          ? validateAnthropicTurns(validatedGemini)
          : validatedGemini;

        // Strip legacy [SESSION MEMORY...][END SESSION MEMORY] blocks from historical
        // user messages. Before the Phase 1 fix, session memory was injected into the
        // user prompt and stored in the JSONL. Old sessions carry these blocks — strip
        // them so they don't waste tokens, confuse the model, or poison the classifier.
        const sanitizedMemory = stripLegacySessionMemoryBlocks(validated);

        try {
          mcAdapter = await loadMemoryCompanionAdapter(params.config, params.agentDir, log);
        } catch (err) {
          log.warn(`memory companion adapter load failed, falling back: ${err}`);
        }

        // ── Budget-derived first-pass limits (from model context window) ──
        const ctxLimits = deriveContextLimits(params.contextWindowTokens);
        const configuredToolCaps = params.config?.agents?.defaults?.tokenBudget?.toolResultCaps;
        const toolResultCapPolicy: ToolResultCapPolicy | undefined = configuredToolCaps
          ? {
              noisyTools: configuredToolCaps.noisyTools,
              noisyToolMaxChars: configuredToolCaps.noisyToolMaxChars,
            }
          : undefined;
        const channelHistoryLimit = getDmHistoryLimitFromSessionKey(
          params.sessionKey,
          params.config,
        );
        const effectiveHistoryLimit =
          channelHistoryLimit != null
            ? Math.min(channelHistoryLimit, ctxLimits.historyTurns)
            : ctxLimits.historyTurns;

        let limitedHistory: AgentMessage[];
        if (mcAdapter) {
          const mcResult = mcAdapter.limitWithMemory(
            sanitizedMemory,
            effectiveHistoryLimit,
            params.sessionFile,
          );
          limitedHistory = mcResult.messages;
          mcSessionMemory = mcResult.sessionMemory;
          if (mcResult.degradationTier !== "normal") {
            log.debug(
              `memory companion: degradation=${mcResult.degradationTier} turnsBehind=${mcResult.turnsBehind}`,
            );
          }
        } else {
          limitedHistory = limitHistoryTurns(sanitizedMemory, effectiveHistoryLimit);
        }

        const toolLimited = limitToolResults(limitedHistory, ctxLimits.toolResultsKept);
        const capped = capToolResultSize(
          toolLimited,
          ctxLimits.toolResultMaxChars,
          undefined,
          undefined,
          toolResultCapPolicy,
        );
        cacheTrace?.recordStage("session:limited", { messages: capped });

        // ── Token Budget Gate — hard guarantee against context overflow ──
        // Estimate system prompt tokens (including session memory if injected).
        // Uses the same ~4 chars/token heuristic as the rest of the token estimation pipeline.
        const effectiveSystemPromptChars = mcSessionMemory
          ? systemPromptText.length + mcSessionMemory.length + 80 // 80 chars for [SESSION MEMORY] wrapper
          : systemPromptText.length;
        const systemPromptTokens = Math.ceil(effectiveSystemPromptChars / 4);

        const budgetResult = fitToTokenBudget(capped, params.contextWindowTokens, {
          outputReserveTokens: params.streamParams?.maxTokens ?? 4096,
          systemPromptTokens,
          toolResultCapPolicy,
        });
        const inputCapRules = params.config?.agents?.defaults?.tokenBudget?.inputCaps;
        const providerInputCapRule = resolveProviderInputCapRule(
          inputCapRules,
          params.provider,
          params.modelId,
        );
        const providerBudgetResult = providerInputCapRule
          ? fitToTokenBudget(budgetResult.messages, providerInputCapRule.maxInputTokens, {
              outputReserveTokens: 0,
              systemPromptTokens,
              toolResultCapPolicy,
            })
          : null;
        const effectiveBudgetResult = providerBudgetResult ?? budgetResult;

        if (effectiveBudgetResult.actions.length > 0) {
          const capLabel = providerInputCapRule
            ? ` providerInputCap=${providerInputCapRule.provider}/${providerInputCapRule.model ?? "*"}:${providerInputCapRule.maxInputTokens}`
            : "";
          log.warn(
            `[token-budget] ${effectiveBudgetResult.actions.join("; ")} | ` +
              `estimated=${effectiveBudgetResult.estimatedTokens} budget=${effectiveBudgetResult.budgetTokens} ` +
              `contextWindow=${params.contextWindowTokens} messages=${effectiveBudgetResult.messages.length}${capLabel} ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        } else {
          log.debug(
            `[token-budget] within budget: estimated=${effectiveBudgetResult.estimatedTokens} budget=${effectiveBudgetResult.budgetTokens} ` +
              `contextWindow=${params.contextWindowTokens} messages=${effectiveBudgetResult.messages.length}`,
          );
        }
        const normalizedProvider = params.provider.trim().toLowerCase();
        const normalizedModelId = params.modelId.trim().toLowerCase();
        const isGeminiFlash =
          normalizedProvider === "google" &&
          normalizedModelId.includes("gemini") &&
          normalizedModelId.includes("flash");
        if (isGeminiFlash && effectiveBudgetResult.estimatedTokens >= 120_000) {
          log.warn(
            `[token-throughput] high estimated input for ${params.provider}/${params.modelId}: ` +
              `${effectiveBudgetResult.estimatedTokens} tokens. Large requests can rapidly consume per-minute quotas. ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        }
        cacheTrace?.recordStage("session:budget", {
          messages: effectiveBudgetResult.messages,
          options: {
            estimatedTokens: effectiveBudgetResult.estimatedTokens,
            budgetTokens: effectiveBudgetResult.budgetTokens,
            actions: effectiveBudgetResult.actions,
          },
        });

        const limited = effectiveBudgetResult.messages;

        // Validate message format before sending to model — catch malformed content early and loudly.
        for (let mi = 0; mi < limited.length; mi++) {
          const m = limited[mi];
          if (m.role === "toolResult" && !Array.isArray(m.content)) {
            console.error(
              `[attempt] FATAL: toolResult message at index ${mi} has non-array content ` +
                `(type=${typeof m.content}, toolName=${m.toolName}). ` +
                `This will cause the model to silently produce no output. ` +
                `runId=${params.runId} sessionId=${params.sessionId}`,
            );
          }
        }

        if (limited.length > 0) {
          activeSession.agent.replaceMessages(limited);
        }

        // ── Proactive compaction: if budget gate says we're still over, bail early ──
        if (effectiveBudgetResult.shouldCompact && params.allowProactiveCompaction !== false) {
          log.warn(
            `[token-budget] proactive compaction requested — skipping model call ` +
              `(estimated=${effectiveBudgetResult.estimatedTokens} budget=${effectiveBudgetResult.budgetTokens}) ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
          sessionManager.flushPendingToolResults?.();
          activeSession.dispose();
          return {
            aborted: false,
            timedOut: false,
            promptError: null,
            sessionIdUsed: params.sessionId,
            messagesSnapshot: limited,
            assistantTexts: [],
            toolMetas: [],
            lastAssistant: undefined,
            didSendViaMessagingTool: false,
            messagingToolSentTexts: [],
            messagingToolSentTargets: [],
            cloudCodeAssistFormatError: false,
            proactiveCompactRequested: true,
          };
        }
        if (effectiveBudgetResult.shouldCompact && params.allowProactiveCompaction === false) {
          log.warn(
            `[token-budget] proactive compaction suppressed after prior compaction failure; ` +
              `proceeding with direct model call (estimated=${effectiveBudgetResult.estimatedTokens} budget=${effectiveBudgetResult.budgetTokens}) ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        }
      } catch (err) {
        sessionManager.flushPendingToolResults?.();
        activeSession.dispose();
        throw err;
      }

      let aborted = Boolean(params.abortSignal?.aborted);
      let timedOut = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
      const makeAbortError = (signal: AbortSignal): Error => {
        const reason = getAbortReason(signal);
        const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
        err.name = "AbortError";
        return err;
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
        }
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        void activeSession.abort();
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> => {
        const signal = runAbortController.signal;
        if (signal.aborted) {
          return Promise.reject(makeAbortError(signal));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(makeAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
      };

      const subscription = subscribeEmbeddedPiSession({
        session: activeSession,
        runId: params.runId,
        verboseLevel: params.verboseLevel,
        reasoningMode: params.reasoningLevel ?? "off",
        toolResultFormat: params.toolResultFormat,
        shouldEmitToolResult: params.shouldEmitToolResult,
        shouldEmitToolOutput: params.shouldEmitToolOutput,
        onToolResult: params.onToolResult,
        onReasoningStream: params.onReasoningStream,
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        blockReplyBreak: params.blockReplyBreak,
        blockReplyChunking: params.blockReplyChunking,
        onPartialReply: params.onPartialReply,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onAgentEvent: params.onAgentEvent,
        enforceFinalTag: params.enforceFinalTag,
      });

      const {
        assistantTexts,
        toolMetas,
        unsubscribe,
        waitForCompactionRetry,
        getMessagingToolSentTexts,
        getMessagingToolSentTargets,
        didSendViaMessagingTool,
        getLastToolError,
        getCompactionCount,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle = {
        queueMessage: async (text: string) => {
          await activeSession.steer(text);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        abort: abortRun,
      };
      setActiveEmbeddedRun(params.sessionId, queueHandle);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const abortTimer = setTimeout(
        () => {
          if (!isProbeSession) {
            log.warn(
              `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
            );
          }
          abortRun(true);
          if (!abortWarnTimer) {
            abortWarnTimer = setTimeout(() => {
              if (!activeSession.isStreaming) {
                return;
              }
              if (!isProbeSession) {
                log.warn(
                  `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                );
              }
            }, 10_000);
          }
        },
        Math.max(1, params.timeoutMs),
      );

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      const onAbort = () => {
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isTimeoutError(reason) : false;
        abortRun(timeout, reason);
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
        }
      }

      // Get hook runner once for both before_agent_start and agent_end hooks
      const hookRunner = getGlobalHookRunner();

      let promptError: unknown = null;
      try {
        const promptStartedAt = Date.now();

        // Run before_agent_start hooks to allow plugins to inject context
        let effectivePrompt = params.prompt;
        if (hookRunner?.hasHooks("before_agent_start")) {
          try {
            const hookResult = await hookRunner.runBeforeAgentStart(
              {
                prompt: params.prompt,
                messages: activeSession.messages,
              },
              {
                agentId: params.sessionKey?.split(":")[0] ?? "main",
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
                runId: params.runId,
              },
            );
            if (hookResult?.prependContext) {
              effectivePrompt = `${hookResult.prependContext}\n\n${params.prompt}`;
              log.debug(
                `hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`,
              );
            }
          } catch (hookErr) {
            log.warn(`before_agent_start hook failed: ${String(hookErr)}`);
          }
        }

        // Memory Companion: inject session memory into system prompt (ephemeral, not stored in JSONL).
        // mcSessionMemory was populated during the history limiting phase above.
        // IMPORTANT: Session memory is appended to the SYSTEM prompt, not the user prompt.
        // Injecting into the user prompt would bake the memory block into the JSONL as part
        // of the user message, causing: (a) compounding across turns, (b) classifier
        // self-poisoning (messages starting with [SESSION MEMORY are classified as system
        // injections), and (c) user-visible "spam" in the chat UI.
        if (mcSessionMemory) {
          const memoryBlock = `\n\n[SESSION MEMORY — Summary of earlier conversation]\n${mcSessionMemory}\n[END SESSION MEMORY]`;
          activeSession.agent.setSystemPrompt(systemPromptText + memoryBlock);
          log.debug(
            `memory companion: injected session memory into system prompt (${mcSessionMemory.length} chars)`,
          );
        }

        log.debug(`embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`);
        cacheTrace?.recordStage("prompt:before", {
          prompt: effectivePrompt,
          messages: activeSession.messages,
        });

        // Repair orphaned trailing user messages so new prompts don't violate role ordering.
        const leafEntry = sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          if (leafEntry.parentId) {
            sessionManager.branch(leafEntry.parentId);
          } else {
            sessionManager.resetLeaf();
          }
          const sessionContext = sessionManager.buildSessionContext();
          activeSession.agent.replaceMessages(sessionContext.messages);
          log.warn(
            `Removed orphaned user message to prevent consecutive user turns. ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        }
        if (params.inputSource?.type) {
          const promptHash = crypto.createHash("sha256").update(effectivePrompt).digest("hex");
          sessionManager.appendCustomEntry("input-source", {
            type: params.inputSource.type,
            sessionKey: params.inputSource.sessionKey,
            runId: params.inputSource.runId,
            promptHash,
          });
          log.debug("embedded run inputSource recorded", {
            runId: params.runId,
            sessionId: params.sessionId,
            type: params.inputSource.type,
            sourceSessionKey: params.inputSource.sessionKey,
            sourceRunId: params.inputSource.runId,
            promptHash,
          });
        }

        try {
          // Detect and load images referenced in the prompt for vision-capable models.
          // This eliminates the need for an explicit "view" tool call by injecting
          // images directly into the prompt when the model supports it.
          // Also scans conversation history to enable follow-up questions about earlier images.
          const imageResult = await detectAndLoadPromptImages({
            prompt: effectivePrompt,
            workspaceDir: effectiveWorkspace,
            model: params.model,
            existingImages: params.images,
            historyMessages: activeSession.messages,
            maxBytes: MAX_IMAGE_BYTES,
            // Enforce sandbox path restrictions when sandbox is enabled
            sandboxRoot: sandbox?.enabled ? sandbox.workspaceDir : undefined,
          });

          // Inject history images into their original message positions.
          // This ensures the model sees images in context (e.g., "compare to the first image").
          const didMutate = injectHistoryImagesIntoMessages(
            activeSession.messages,
            imageResult.historyImagesByIndex,
          );
          if (didMutate) {
            // Persist message mutations (e.g., injected history images) so we don't re-scan/reload.
            activeSession.agent.replaceMessages(activeSession.messages);
          }

          cacheTrace?.recordStage("prompt:images", {
            prompt: effectivePrompt,
            messages: activeSession.messages,
            note: `images: prompt=${imageResult.images.length} history=${imageResult.historyImagesByIndex.size}`,
          });

          const shouldTrackCacheTtl =
            params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
            isCacheTtlEligibleProvider(params.provider, params.modelId);
          if (shouldTrackCacheTtl) {
            appendCacheTtlTimestamp(sessionManager, {
              timestamp: Date.now(),
              provider: params.provider,
              modelId: params.modelId,
            });
          }

          // Only pass images option if there are actually images to pass
          // This avoids potential issues with models that don't expect the images parameter
          console.log(
            `[attempt] checkpoint 10: calling activeSession.prompt runId=${params.runId}`,
          );
          if (imageResult.images.length > 0) {
            await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
          } else {
            await abortable(activeSession.prompt(effectivePrompt));
          }
          console.log(`[attempt] checkpoint 11: prompt completed runId=${params.runId}`);
        } catch (err) {
          promptError = err;
          // Log prompt errors loudly — these were previously silent in some code paths
          console.error(
            `[attempt] prompt error (was silent): runId=${params.runId} ` +
              `sessionId=${params.sessionId} error=${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          const promptDurationMs = Date.now() - promptStartedAt;
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${promptDurationMs}`,
          );

          // Detect suspiciously fast prompt completion with no output.
          // A real model call takes seconds. If it finishes in <500ms with no assistant text,
          // the model was likely never called (message format error, empty context, etc).
          const hasAssistantOutput =
            assistantTexts.length > 0 && assistantTexts.some((t) => t.length > 0);
          if (promptDurationMs < 500 && !hasAssistantOutput && !promptError && !aborted) {
            console.error(
              `[attempt] WARNING: prompt completed in ${promptDurationMs}ms with NO assistant output and NO error. ` +
                `This likely means the model was never called (malformed messages, context issues, or provider SDK silent failure). ` +
                `runId=${params.runId} sessionId=${params.sessionId} messageCount=${activeSession.messages.length}`,
            );
          }
        }

        try {
          await waitForCompactionRetry();
        } catch (err) {
          if (isAbortError(err)) {
            if (!promptError) {
              promptError = err;
            }
          } else {
            throw err;
          }
        }

        messagesSnapshot = activeSession.messages.slice();
        sessionIdUsed = activeSession.sessionId;

        // ── Silent compaction failure detection ──
        // If the SDK's auto-compaction removed an overflow error message from agent
        // state but then failed to compact (e.g., "Already compacted"), session.prompt()
        // resolves with no error and no response. Detect this and surface it so the
        // run loop can trigger reactive compaction.
        if (!promptError && !aborted && messagesSnapshot.length > 0 && getCompactionCount() > 0) {
          const lastMsg = messagesSnapshot[messagesSnapshot.length - 1];
          // If the last message is NOT an assistant message after a compaction ran,
          // it means the SDK ate an error and failed to retry successfully.
          if (lastMsg && lastMsg.role !== "assistant") {
            log.warn(
              `[sdk-compaction] possible silent compaction failure detected ` +
                `(last message role=${lastMsg.role} after ${getCompactionCount()} compaction(s)); ` +
                `runId=${params.runId} sessionId=${params.sessionId}`,
            );
          }
        }
        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: promptError ? "prompt error" : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        // Memory Companion: fire-and-forget post-turn processing.
        // Triggers background summarization of new turns.
        if (mcAdapter) {
          mcAdapter.onTurnComplete(params.sessionFile, messagesSnapshot).catch((err) => {
            log.warn(`memory companion onTurnComplete failed: ${err}`);
          });
        }

        // Run agent_end hooks to allow plugins to analyze the conversation
        // This is fire-and-forget, so we don't await
        if (hookRunner?.hasHooks("agent_end")) {
          hookRunner
            .runAgentEnd(
              {
                messages: messagesSnapshot,
                success: !aborted && !promptError,
                error: promptError ? describeUnknownError(promptError) : undefined,
                durationMs: Date.now() - promptStartedAt,
              },
              {
                agentId: params.sessionKey?.split(":")[0] ?? "main",
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
                runId: params.runId,
              },
            )
            .catch((err) => {
              log.warn(`agent_end hook failed: ${err}`);
            });
        }
      } finally {
        clearTimeout(abortTimer);
        if (abortWarnTimer) {
          clearTimeout(abortWarnTimer);
        }
        unsubscribe();
        clearActiveEmbeddedRun(params.sessionId, queueHandle);
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const lastAssistant = messagesSnapshot
        .slice()
        .toReversed()
        .find((m) => m.role === "assistant");

      const toolMetasNormalized = toolMetas
        .filter(
          (entry): entry is { toolName: string; meta?: string } =>
            typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({ toolName: entry.toolName, meta: entry.meta }));

      // ── Post-response compaction advisory: check if context is near threshold ──
      // Use the model's actual usage data (much more accurate than char/4 estimate).
      // If context tokens >= 80% of the window, advise the caller to compact before
      // the next user message to avoid overflow.
      const POST_RESPONSE_COMPACT_THRESHOLD = 0.8;
      let postResponseCompactAdvised = false;
      if (lastAssistant && !promptError && !aborted && params.contextWindowTokens > 0) {
        const usage = lastAssistant.usage as UsageLike | undefined;
        if (usage) {
          const input = (usage.input ?? usage.inputTokens ?? usage.promptTokens ?? 0) as number;
          const output = (usage.output ??
            usage.outputTokens ??
            usage.completionTokens ??
            0) as number;
          const cacheRead = (usage.cacheRead ?? 0) as number;
          const cacheWrite = (usage.cacheWrite ?? 0) as number;
          const contextTokens = input + output + cacheRead + cacheWrite;
          if (
            contextTokens > 0 &&
            contextTokens >= params.contextWindowTokens * POST_RESPONSE_COMPACT_THRESHOLD
          ) {
            log.info(
              `[post-response] context at ${((contextTokens / params.contextWindowTokens) * 100).toFixed(1)}% ` +
                `(${contextTokens}/${params.contextWindowTokens}); advising compaction ` +
                `runId=${params.runId} sessionId=${params.sessionId}`,
            );
            postResponseCompactAdvised = true;
          }
        }
      }

      return {
        aborted,
        timedOut,
        promptError,
        sessionIdUsed,
        systemPromptReport,
        messagesSnapshot,
        assistantTexts,
        toolMetas: toolMetasNormalized,
        lastAssistant,
        lastToolError: getLastToolError?.(),
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
        // Client tool call detected (OpenResponses hosted tools)
        clientToolCall: clientToolCallDetected ?? undefined,
        postResponseCompactAdvised,
        sdkCompactionOccurred: getCompactionCount() > 0,
      };
    } finally {
      // Always tear down the session (and release the lock) before we leave this attempt.
      sessionManager?.flushPendingToolResults?.();
      session?.dispose();
      await sessionLock.release();
    }
  } finally {
    restoreSkillEnv?.();
    process.chdir(prevCwd);
  }
}
