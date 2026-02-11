import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  stripHeartbeatToken,
} from "../../auto-reply/heartbeat.js";
import { truncateUtf16Safe } from "../../utils.js";

type DeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  channelData?: Record<string, unknown>;
};

/**
 * Returns the last payload that is suitable for delivery (has text, media, or channelData).
 */
export function pickLastDeliverablePayload(
  payloads: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    channelData?: Record<string, unknown>;
  }>,
): DeliveryPayload | undefined {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const p = payloads[i];
    if (!p) continue;
    const hasText = (p.text ?? "").trim().length > 0;
    const hasMedia = (p.mediaUrls?.length ?? 0) > 0 || Boolean(p.mediaUrl);
    const hasChannelData = p.channelData && Object.keys(p.channelData).length > 0;
    if (hasText || hasMedia || hasChannelData) {
      return p as DeliveryPayload;
    }
  }
  return undefined;
}

export function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

export function pickSummaryFromPayloads(payloads: Array<{ text?: string | undefined }>) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

export function pickLastNonEmptyTextFromPayloads(payloads: Array<{ text?: string | undefined }>) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  return undefined;
}

/**
 * Check if all payloads are just heartbeat ack responses (HEARTBEAT_OK).
 * Returns true if delivery should be skipped because there's no real content.
 */
export function isHeartbeatOnlyResponse(payloads: DeliveryPayload[], ackMaxChars: number) {
  if (payloads.length === 0) {
    return true;
  }
  return payloads.every((payload) => {
    // If there's media, we should deliver regardless of text content.
    const hasMedia = (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl);
    if (hasMedia) {
      return false;
    }
    // Use heartbeat mode to check if text is just HEARTBEAT_OK or short ack.
    const result = stripHeartbeatToken(payload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
    });
    return result.shouldSkip;
  });
}

export function resolveHeartbeatAckMaxChars(agentCfg?: { heartbeat?: { ackMaxChars?: number } }) {
  const raw = agentCfg?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  return Math.max(0, raw);
}
