import { formatTokenCount } from "../utils/usage-format.js";
import { formatRawAssistantErrorForUi } from "../agents/pi-embedded-helpers.js";

/**
 * When text is action-style JSON (e.g. {"name":"message_create","arguments":{"text":"Hello!"}}),
 * extract arguments.text for display.
 */
function unwrapActionJson(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.startsWith("{") &&
    trimmed.endsWith("}") &&
    (trimmed.includes('"name"') || trimmed.includes("'name'")) &&
    (trimmed.includes('"arguments"') || trimmed.includes("'arguments'"))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const args = parsed.arguments as Record<string, unknown> | undefined;
      const innerText = typeof args?.text === "string" ? args.text.trim() : "";
      if (innerText) return innerText;
    } catch {
      // Not valid JSON or missing structure; return as-is
    }
  }
  return text;
}

/**
 * Extract arguments.text from tool_use blocks that represent message sends.
 */
function textFromToolBlock(block: Record<string, unknown>): string | null {
  const type = String(block.type ?? "").toLowerCase();
  const name = String(block.name ?? block.id ?? "").toLowerCase();
  if (type !== "tool_use" && type !== "tool_call") return null;
  const msgTools = ["message_create", "message", "agent_send", "send_message"];
  if (!msgTools.some((t) => name.includes(t))) return null;
  let args = block.arguments ?? block.args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args.trim());
      args = typeof parsed === "object" && parsed !== null ? parsed : undefined;
    } catch {
      args = undefined;
    }
  }
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const text = (args as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

export function resolveFinalAssistantText(params: {
  finalText?: string | null;
  streamedText?: string | null;
}) {
  const finalText = params.finalText ?? "";
  if (finalText.trim()) return finalText;
  const streamedText = params.streamedText ?? "";
  if (streamedText.trim()) return streamedText;
  return "(no output)";
}

export function composeThinkingAndContent(params: {
  thinkingText?: string;
  contentText?: string;
  showThinking?: boolean;
}) {
  const thinkingText = params.thinkingText?.trim() ?? "";
  const contentText = params.contentText?.trim() ?? "";
  const parts: string[] = [];

  if (params.showThinking && thinkingText) {
    parts.push(`[thinking]\n${thinkingText}`);
  }
  if (contentText) {
    parts.push(contentText);
  }

  return parts.join("\n\n").trim();
}

/**
 * Extract ONLY thinking blocks from message content.
 * Model-agnostic: returns empty string if no thinking blocks exist.
 */
export function extractThinkingFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return "";
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "thinking" && typeof rec.thinking === "string") {
      parts.push(rec.thinking);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Extract ONLY text content blocks from message (excludes thinking).
 * Model-agnostic: works for any model with text content blocks.
 */
export function extractContentFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const content = record.content;

  if (typeof content === "string") return content.trim();

  // Check for error BEFORE returning empty for non-array content
  if (!Array.isArray(content)) {
    const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
    if (stopReason === "error") {
      const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
      return formatRawAssistantErrorForUi(errorMessage);
    }
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      // Unwrap action JSON (e.g. {"name":"message_create","arguments":{"text":"Hi"}})
      parts.push(unwrapActionJson(rec.text));
    }
    const toolText = textFromToolBlock(rec);
    if (toolText) parts.push(toolText);
  }

  // If no text blocks found, check for error
  if (parts.length === 0) {
    const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
    if (stopReason === "error") {
      const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
      return formatRawAssistantErrorForUi(errorMessage);
    }
  }

  return parts.join("\n").trim();
}

function extractTextBlocks(content: unknown, opts?: { includeThinking?: boolean }): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const thinkingParts: string[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    }
    if (
      opts?.includeThinking &&
      record.type === "thinking" &&
      typeof record.thinking === "string"
    ) {
      thinkingParts.push(record.thinking);
    }
  }

  return composeThinkingAndContent({
    thinkingText: thinkingParts.join("\n").trim(),
    contentText: textParts.join("\n").trim(),
    showThinking: opts?.includeThinking ?? false,
  });
}

export function extractTextFromMessage(
  message: unknown,
  opts?: { includeThinking?: boolean },
): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const text = extractTextBlocks(record.content, opts);
  if (text) return text;

  const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
  if (stopReason !== "error") return "";

  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
  return formatRawAssistantErrorForUi(errorMessage);
}

export function isCommandMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return (message as Record<string, unknown>).command === true;
}

export function formatTokens(total?: number | null, context?: number | null) {
  if (total == null && context == null) return "tokens ?";
  const totalLabel = total == null ? "?" : formatTokenCount(total);
  if (context == null) return `tokens ${totalLabel}`;
  const pct =
    typeof total === "number" && context > 0
      ? Math.min(999, Math.round((total / context) * 100))
      : null;
  return `tokens ${totalLabel}/${formatTokenCount(context)}${pct !== null ? ` (${pct}%)` : ""}`;
}

export function formatContextUsageLine(params: {
  total?: number | null;
  context?: number | null;
  remaining?: number | null;
  percent?: number | null;
}) {
  const totalLabel = typeof params.total === "number" ? formatTokenCount(params.total) : "?";
  const ctxLabel = typeof params.context === "number" ? formatTokenCount(params.context) : "?";
  const pct = typeof params.percent === "number" ? Math.min(999, Math.round(params.percent)) : null;
  const remainingLabel =
    typeof params.remaining === "number" ? `${formatTokenCount(params.remaining)} left` : null;
  const pctLabel = pct !== null ? `${pct}%` : null;
  const extra = [remainingLabel, pctLabel].filter(Boolean).join(", ");
  return `tokens ${totalLabel}/${ctxLabel}${extra ? ` (${extra})` : ""}`;
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
