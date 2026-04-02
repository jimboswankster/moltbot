import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type TelegramContextCompositionEvent = {
  schema_version: "telegram.context-composition.v1";
  ts: string;
  channel: "telegram";
  sessionKey: string;
  chatId: string;
  topicId: string | null;
  isGroup: boolean;
  historyLimit: number;
  pendingHistoryEntryCount: number;
  rawBodyChars: number;
  envelopeBodyChars: number;
  combinedBodyChars: number;
  pendingHistoryChars: number;
  pendingHistoryShare: number;
};

type BuildTelegramContextCompositionEventParams = {
  sessionKey: string;
  chatId: string | number;
  topicId?: string | number;
  isGroup: boolean;
  historyLimit: number;
  pendingHistoryEntryCount: number;
  rawBody: string;
  envelopeBody: string;
  combinedBody: string;
};

export function buildTelegramContextCompositionEvent(
  params: BuildTelegramContextCompositionEventParams,
): TelegramContextCompositionEvent {
  const rawBodyChars = params.rawBody.length;
  const envelopeBodyChars = params.envelopeBody.length;
  const combinedBodyChars = params.combinedBody.length;
  const pendingHistoryChars = Math.max(0, combinedBodyChars - envelopeBodyChars);
  const pendingHistoryShare =
    combinedBodyChars > 0 ? Number((pendingHistoryChars / combinedBodyChars).toFixed(6)) : 0;
  return {
    schema_version: "telegram.context-composition.v1",
    ts: new Date().toISOString(),
    channel: "telegram",
    sessionKey: params.sessionKey,
    chatId: String(params.chatId),
    topicId: params.topicId == null ? null : String(params.topicId),
    isGroup: params.isGroup,
    historyLimit: params.historyLimit,
    pendingHistoryEntryCount: params.pendingHistoryEntryCount,
    rawBodyChars,
    envelopeBodyChars,
    combinedBodyChars,
    pendingHistoryChars,
    pendingHistoryShare,
  };
}

export function appendTelegramContextCompositionEvent(
  event: TelegramContextCompositionEvent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = path.join(resolveStateDir(env), "logs");
  fs.mkdirSync(dir, { recursive: true });
  const pathname = path.join(dir, "telegram-context-composition.jsonl");
  fs.appendFileSync(pathname, `${JSON.stringify(event)}\n`, "utf8");
  return pathname;
}
