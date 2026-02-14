import { getTelemetrySupabaseClient } from "../../telemetry/supabase.js";

export type OutboundSanitizeResult = {
  text: string;
  changed: boolean;
  removedTags: string[];
};

export function sanitizeOutboundText(text: string): OutboundSanitizeResult {
  const original = text ?? "";
  let next = original;
  const removedTags: string[] = [];

  if (next.includes("TRANSITIONAL_A2A_INBOX")) {
    // Remove internal A2A inbox prompt blocks.
    const re = /(?:^|\n)TRANSITIONAL_A2A_INBOX[\s\S]*?(?:\n\s*\n|$)/g;
    const replaced = next.replace(re, "\n");
    if (replaced !== next) {
      next = replaced;
      removedTags.push("TRANSITIONAL_A2A_INBOX");
    }
  }

  if (removedTags.length > 0) {
    next = next.replace(/\n{3,}/g, "\n\n").trim();
  }

  return {
    text: next,
    changed: next !== original,
    removedTags,
  };
}

export async function emitOutboundSanitizedDeskSignal(params: {
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  removedTags: string[];
  beforeBytes: number;
  afterBytes: number;
}): Promise<void> {
  const client = getTelemetrySupabaseClient();
  if (!client) return;
  if (!params.removedTags.length) return;

  try {
    await client.from("state_signals").insert({
      agent_id: params.agentId ?? "main",
      source: "outbound-sanitize",
      kind: "outbound_sanitized",
      summary: `[Outbound] Sanitized internal blocks before delivery (${params.removedTags.join(",")})`,
      payload: {
        removed_tags: params.removedTags,
        before_bytes: params.beforeBytes,
        after_bytes: params.afterBytes,
        channel: params.channel,
        session_key: params.sessionKey,
      },
      priority: "high",
      acknowledged: false,
    });
  } catch {
    // ignore (sanitization must never break delivery)
  }
}
