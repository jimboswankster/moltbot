import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Limits the number of full tool results kept in history.
 * Older tool results are truncated to save context tokens.
 * This is a universal protection for all providers (Gemini, OpenAI, etc).
 *
 * IMPORTANT: toolResult.content MUST be (TextContent | ImageContent)[], not a string.
 * Setting it to a plain string will cause providers (especially Gemini) to silently
 * produce no output — the prompt completes in ~11ms with zero assistant response.
 */
export function limitToolResults(messages: AgentMessage[], keepLast: number = 3): AgentMessage[] {
  if (keepLast < 0) return messages;

  let toolResultCount = 0;
  let truncatedCount = 0;
  // Shallow copy to allow modification
  const result = [...messages];

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role === "toolResult") {
      toolResultCount++;
      if (toolResultCount > keepLast) {
        // Truncate this tool result to a single text content block.
        // content must be (TextContent | ImageContent)[] — not a plain string.
        const cleared = {
          ...msg,
          content: [{ type: "text" as const, text: "[Old tool result cleared to save context]" }],
        };

        // Runtime guard: if content is not an array, something is very wrong.
        if (!Array.isArray(cleared.content)) {
          console.error(
            `[limitToolResults] FATAL: content is not an array after truncation (got ${typeof cleared.content}). ` +
              `This will cause the prompt to silently produce no output. index=${i} toolName=${msg.toolName}`,
          );
        }

        result[i] = cleared;
        truncatedCount++;
      }
    }
  }

  if (truncatedCount > 0) {
    console.log(
      `[limitToolResults] truncated ${truncatedCount}/${toolResultCount} tool results (kept last ${keepLast})`,
    );
  }

  return result;
}

/**
 * Caps individual tool result content size to prevent monster results (80K–370K chars)
 * from inflating per-request token cost. Applied AFTER limitToolResults so it only
 * affects the kept (last N) results. Truncated results keep head + tail with a marker.
 *
 * F2 fix: see ARCHITECTURE-HEALTH.md § Weak Point 4.
 */
export function capToolResultSize(
  messages: AgentMessage[],
  maxChars: number = 20_000,
  headChars: number = 8_000,
  tailChars: number = 8_000,
): AgentMessage[] {
  if (maxChars <= 0) return messages;

  const result = [...messages];
  let cappedCount = 0;

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "toolResult" || !Array.isArray(msg.content)) continue;

    // Measure total text length across all text content blocks
    let totalChars = 0;
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        totalChars += block.text.length;
      }
    }

    if (totalChars <= maxChars) continue;

    // Cap: concatenate all text, then take head + marker + tail
    const allText = msg.content
      .filter(
        (b: { type: string; text?: string }) => b.type === "text" && typeof b.text === "string",
      )
      .map((b) => (b as { type: string; text: string }).text)
      .join("\n");

    const truncatedChars = allText.length - headChars - tailChars;
    const head = allText.slice(0, headChars);
    const tail = allText.slice(-tailChars);
    const capped = `${head}\n\n[...truncated ${truncatedChars} chars (${Math.round(truncatedChars / 4)} est. tokens) to save context...]\n\n${tail}`;

    result[i] = {
      ...msg,
      content: [{ type: "text" as const, text: capped }],
    };
    cappedCount++;
  }

  if (cappedCount > 0) {
    console.log(
      `[capToolResultSize] capped ${cappedCount} tool result(s) exceeding ${maxChars} chars`,
    );
  }

  return result;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 */
export function getDmHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) {
    return undefined;
  }

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);
  if (provider === "webchat") {
    return 30; // Safety limit for webchat sessions
  }
  if (kind !== "dm") {
    return undefined;
  }

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) {
      return undefined;
    }
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  };

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ): { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> } | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    return entry as { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> };
  };

  return getLimit(resolveProviderConfig(config, provider));
}
