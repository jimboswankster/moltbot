import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordA2AInboxEvent } from "../a2a-inbox.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import { buildAgentToAgentAnnounceContext, isAnnounceSkip } from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

// Rate limit delay between A2A agent steps to prevent API hammering
const A2A_STEP_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitA2ATelemetry(params: {
  runId: string;
  sessionKey?: string;
  kind: string;
  details?: Record<string, unknown>;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data: {
      phase: "telemetry",
      kind: params.kind,
      ...params.details,
    },
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
}) {
  const runContextId = params.waitRunId ?? `a2a:${crypto.randomUUID()}`;
  try {
    const cfg = loadConfig();
    const deliveryMode = cfg.tools?.agentToAgent?.deliveryMode ?? "inject";
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const waitMs = Math.min(params.announceTimeoutMs, 60_000);
      const wait = await callGateway<{ status: string }>({
        method: "agent.wait",
        params: {
          runId: params.waitRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      });
      if (wait?.status === "ok") {
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      }
    }
    if (!latestReply) {
      return;
    }

    if (deliveryMode === "inbox") {
      if (params.requesterSessionKey) {
        const replyText = latestReply.trim();
        if (replyText) {
          await recordA2AInboxEvent({
            cfg,
            sessionKey: params.requesterSessionKey,
            sourceSessionKey: params.targetSessionKey,
            sourceDisplayKey: params.displayKey,
            runId: params.waitRunId ?? crypto.randomUUID(),
            replyText,
            now: Date.now(),
          });
        }
      }
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    // Rate limit: delay before announce step
    await delay(A2A_STEP_DELAY_MS);

    const announcePrompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel,
      originalMessage: params.message,
      roundOneReply: primaryReply,
      latestReply,
    });
    const announceReply = await runAgentStep({
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: AGENT_LANE_NESTED,
      inputSource: {
        type: "a2a-announce",
        sessionKey: params.requesterSessionKey,
        runId: params.waitRunId,
      },
    });
    const announceText = announceReply?.trim();
    if (announceTarget && announceText && !isAnnounceSkip(announceText)) {
      try {
        await callGateway({
          method: "send",
          params: {
            to: announceTarget.to,
            message: announceText,
            channel: announceTarget.channel,
            accountId: announceTarget.accountId,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
      } catch (err) {
        log.warn("sessions_send announce delivery failed", {
          runId: runContextId,
          channel: announceTarget.channel,
          to: announceTarget.to,
          error: formatErrorMessage(err),
        });
        emitA2ATelemetry({
          runId: runContextId,
          sessionKey: params.requesterSessionKey ?? params.targetSessionKey,
          kind: "a2a_announce_delivery_failed",
          details: {
            channel: announceTarget.channel,
            to: announceTarget.to,
            error: formatErrorMessage(err),
          },
        });
      }
    }

    if (params.requesterSessionKey) {
      const replyText =
        announceText && !isAnnounceSkip(announceText) ? announceText : latestReply?.trim();
      if (replyText) {
        await recordA2AInboxEvent({
          cfg,
          sessionKey: params.requesterSessionKey,
          sourceSessionKey: params.targetSessionKey,
          sourceDisplayKey: params.displayKey,
          runId: params.waitRunId ?? crypto.randomUUID(),
          replyText,
          now: Date.now(),
        });
      }
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
    emitA2ATelemetry({
      runId: runContextId,
      sessionKey: params.requesterSessionKey ?? params.targetSessionKey,
      kind: "a2a_announce_flow_failed",
      details: { error: formatErrorMessage(err) },
    });
  }
}
