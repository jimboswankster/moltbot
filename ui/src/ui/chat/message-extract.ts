import { stripThinkingTags } from "../format";

const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) return true;
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) return true;
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) return text;
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) return text;
  return text.slice(match[0].length);
}

/**
 * When the model outputs action-style JSON (e.g. {"name":"message_create","arguments":{"text":"Hello!"}}),
 * extract arguments.text for display instead of showing raw JSON.
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

export function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const content = m.content;
  let processed: string | null = null;
  if (typeof content === "string") {
    processed = role === "assistant" ? stripThinkingTags(content) : stripEnvelope(content);
  } else if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      const joined = parts.join("\n");
      processed = role === "assistant" ? stripThinkingTags(joined) : stripEnvelope(joined);
    }
  } else if (typeof m.text === "string") {
    processed = role === "assistant" ? stripThinkingTags(m.text) : stripEnvelope(m.text);
  }
  if (!processed?.trim()) return processed;
  // When assistant outputs action JSON (e.g. {"name":"message_create","arguments":{"text":"Hi"}}),
  // extract arguments.text for display instead of raw JSON
  return role === "assistant" ? unwrapActionJson(processed) : processed;
}

export function extractTextCached(message: unknown): string | null {
  if (!message || typeof message !== "object") return extractText(message);
  const obj = message as object;
  if (textCache.has(obj)) return textCache.get(obj) ?? null;
  const value = extractText(message);
  textCache.set(obj, value);
  return value;
}

export function extractThinking(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      const item = p as Record<string, unknown>;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        const cleaned = item.thinking.trim();
        if (cleaned) parts.push(cleaned);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");

  // Back-compat: older logs may still have <think> tags inside text blocks.
  const rawText = extractRawText(message);
  if (!rawText) return null;
  const matches = [
    ...rawText.matchAll(
      /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi,
    ),
  ];
  const extracted = matches
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  return extracted.length > 0 ? extracted.join("\n") : null;
}

export function extractThinkingCached(message: unknown): string | null {
  if (!message || typeof message !== "object") return extractThinking(message);
  const obj = message as object;
  if (thinkingCache.has(obj)) return thinkingCache.get(obj) ?? null;
  const value = extractThinking(message);
  thinkingCache.set(obj, value);
  return value;
}

export function extractRawText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

export function formatReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `_${line}_`);
  return lines.length ? ["_Reasoning:_", ...lines].join("\n") : "";
}
