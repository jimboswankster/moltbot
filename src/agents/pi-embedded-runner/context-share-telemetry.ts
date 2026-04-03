import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs";
import path from "node:path";

export type AgentContextShareEvent = {
  schema_version: "agent.context-share.v1";
  ts: string;
  runId: string;
  sessionId: string;
  sessionKey: string | null;
  provider: string;
  modelId: string;
  messageChannel: string | null;
  systemPromptTokens: number;
  estimatedHistoryTokens: number;
  estimatedCompositionTokens: number;
  persistedSessionTokens: number;
  persistedSessionShare: number;
  toolResultTokens: number;
  toolResultShare: number;
  memoryCompanionTokens: number;
  memoryCompanionShare: number;
  messageCount: number;
  toolResultCount: number;
};

function estimateMessageContentChars(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let chars = 0;
    for (const item of content) {
      if (typeof item === "string") {
        chars += item.length;
        continue;
      }
      if (item && typeof item === "object") {
        const maybeText = (item as { text?: unknown }).text;
        if (typeof maybeText === "string") {
          chars += maybeText.length;
          continue;
        }
      }
      try {
        chars += JSON.stringify(item).length;
      } catch {
        chars += String(item).length;
      }
    }
    return chars;
  }
  if (typeof content === "object") {
    try {
      return JSON.stringify(content).length;
    } catch {
      return String(content).length;
    }
  }
  return String(content).length;
}

function estimateHistoryTokens(messages: AgentMessage[]): {
  messageCount: number;
  totalTokens: number;
  toolResultCount: number;
  toolResultTokens: number;
} {
  let totalChars = 0;
  let toolResultChars = 0;
  let toolResultCount = 0;
  for (const message of messages) {
    const content = "content" in message ? message.content : undefined;
    const chars = estimateMessageContentChars(content);
    totalChars += chars;
    if (message.role === "toolResult") {
      toolResultCount += 1;
      toolResultChars += chars;
    }
  }
  return {
    messageCount: messages.length,
    totalTokens: Math.ceil(totalChars / 4),
    toolResultCount,
    toolResultTokens: Math.ceil(toolResultChars / 4),
  };
}

export function buildAgentContextShareEvent(params: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider: string;
  modelId: string;
  messageChannel?: string;
  systemPromptTokens: number;
  historyMessages: AgentMessage[];
  memoryCompanionChars?: number;
}): AgentContextShareEvent {
  const history = estimateHistoryTokens(params.historyMessages);
  const memoryCompanionTokens = Math.ceil(Math.max(0, params.memoryCompanionChars ?? 0) / 4);
  const estimatedCompositionTokens = params.systemPromptTokens + history.totalTokens;
  const safeDivisor = estimatedCompositionTokens > 0 ? estimatedCompositionTokens : 1;
  return {
    schema_version: "agent.context-share.v1",
    ts: new Date().toISOString(),
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey?.trim() ? params.sessionKey.trim() : null,
    provider: params.provider,
    modelId: params.modelId,
    messageChannel: params.messageChannel?.trim() ? params.messageChannel.trim() : null,
    systemPromptTokens: params.systemPromptTokens,
    estimatedHistoryTokens: history.totalTokens,
    estimatedCompositionTokens,
    persistedSessionTokens: history.totalTokens,
    persistedSessionShare: Number((history.totalTokens / safeDivisor).toFixed(6)),
    toolResultTokens: history.toolResultTokens,
    toolResultShare: Number((history.toolResultTokens / safeDivisor).toFixed(6)),
    memoryCompanionTokens,
    memoryCompanionShare: Number((memoryCompanionTokens / safeDivisor).toFixed(6)),
    messageCount: history.messageCount,
    toolResultCount: history.toolResultCount,
  };
}

export function appendAgentContextShareEvent(
  event: AgentContextShareEvent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME || "/Users/basecamp";
  const dir = path.join(home, ".openclaw", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const pathname = path.join(dir, "agent-context-share.jsonl");
  fs.appendFileSync(pathname, `${JSON.stringify(event)}\n`, "utf8");
  return pathname;
}
