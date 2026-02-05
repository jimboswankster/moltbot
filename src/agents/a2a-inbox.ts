import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  mergeSessionEntry,
  updateSessionStore,
  type A2AInboxEvent,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { resolveSessionStoreKey } from "../gateway/session-utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveDefaultAgentId } from "./agent-scope.js";

export const TRANSITIONAL_A2A_INBOX_TAG = "TRANSITIONAL_A2A_INBOX";
export const A2A_INBOX_SCHEMA_VERSION = 1;
export const A2A_INBOX_MAX_EVENTS = 3;
export const A2A_INBOX_MAX_CHARS = 500;

const log = createSubsystemLogger("agents/a2a-inbox");

export type { A2AInboxEvent };

export type A2AInboxPromptBlockResult = {
  text: string;
  includedRunIds: string[];
  truncated: boolean;
};

type A2AInboxStoreTarget = {
  storePath: string;
  canonicalKey: string;
};

function resolveInboxStoreTarget(cfg: OpenClawConfig, sessionKey: string): A2AInboxStoreTarget {
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId =
    canonicalKey === "global" || canonicalKey === "unknown"
      ? resolveDefaultAgentId(cfg)
      : resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return { storePath, canonicalKey };
}

export function buildA2AInboxPromptBlock(params: {
  events: A2AInboxEvent[];
  maxEvents: number;
  maxChars: number;
}): A2AInboxPromptBlockResult {
  const events = params.events
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  const selected = events.slice(0, Math.max(0, params.maxEvents));

  let text = TRANSITIONAL_A2A_INBOX_TAG;
  let remaining = Math.max(0, params.maxChars - text.length);
  const includedRunIds: string[] = [];
  let truncated = false;

  for (const event of selected) {
    const display = event.sourceDisplayKey?.trim() || event.sourceSessionKey;
    const header = `\n- source: ${display} (${event.sourceSessionKey})\n  runId: ${event.runId}\n  text: `;
    if (header.length > remaining) {
      truncated = true;
      break;
    }
    text += header;
    remaining -= header.length;

    if (event.replyText.length > remaining) {
      const sliceLen = Math.max(0, remaining - 3);
      text += `${event.replyText.slice(0, sliceLen)}...`;
      truncated = true;
      remaining = 0;
      includedRunIds.push(event.runId);
      break;
    }

    text += event.replyText;
    remaining -= event.replyText.length;
    includedRunIds.push(event.runId);
  }

  return { text, includedRunIds, truncated };
}

export async function recordA2AInboxEvent(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sourceSessionKey: string;
  sourceDisplayKey?: string;
  runId: string;
  replyText: string;
  now?: number;
}): Promise<{ written: boolean; eventId: string | null }> {
  const now = params.now ?? Date.now();
  const { storePath, canonicalKey } = resolveInboxStoreTarget(params.cfg, params.sessionKey);
  const eventId = crypto.randomUUID();
  let written = false;

  await updateSessionStore(storePath, (store) => {
    const existing = store[canonicalKey];
    const inbox = existing?.a2aInbox;
    const events = Array.isArray(inbox?.events) ? inbox?.events : [];
    if (events.some((event) => event.runId === params.runId)) {
      return;
    }
    const nextEvent: A2AInboxEvent = {
      schemaVersion: A2A_INBOX_SCHEMA_VERSION,
      createdAt: now,
      runId: params.runId,
      sourceSessionKey: params.sourceSessionKey,
      sourceDisplayKey: params.sourceDisplayKey,
      replyText: params.replyText,
    };
    const next = mergeSessionEntry(existing, {
      sessionId: existing?.sessionId ?? crypto.randomUUID(),
      updatedAt: now,
      a2aInbox: {
        events: [...events, nextEvent],
      },
    });
    store[canonicalKey] = next;
    written = true;
  });

  if (written) {
    log.info("a2a_inbox_event_written", {
      runId: params.runId,
      sessionKey: canonicalKey,
      sourceSessionKey: params.sourceSessionKey,
      eventCount: 1,
      eventId,
    });
  }

  return { written, eventId: written ? eventId : null };
}

export async function injectA2AInboxPrependContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  runId?: string;
  now?: number;
}): Promise<{ prependContext?: string } | undefined> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const { storePath, canonicalKey } = resolveInboxStoreTarget(params.cfg, sessionKey);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[canonicalKey];
  const events = Array.isArray(entry?.a2aInbox?.events) ? entry?.a2aInbox?.events : [];
  if (events.length === 0) {
    return undefined;
  }

  const pending = events.filter((event) => !event.deliveredAt);
  if (pending.length === 0) {
    return undefined;
  }

  const block = buildA2AInboxPromptBlock({
    events: pending,
    maxEvents: A2A_INBOX_MAX_EVENTS,
    maxChars: A2A_INBOX_MAX_CHARS,
  });
  if (!block.text) {
    return undefined;
  }

  await updateSessionStore(storePath, (mutable) => {
    const current = mutable[canonicalKey];
    if (!current?.a2aInbox?.events) {
      return;
    }
    const nextEvents = current.a2aInbox.events.map((event) => {
      if (!block.includedRunIds.includes(event.runId)) {
        return event;
      }
      return { ...event, deliveredAt: now, deliveredRunId: params.runId };
    });
    mutable[canonicalKey] = mergeSessionEntry(current, {
      updatedAt: now,
      a2aInbox: {
        events: nextEvents,
      },
    });
  });

  const sourceSessionKey = pending[0]?.sourceSessionKey;
  const eventCount = block.includedRunIds.length;
  if (eventCount > 0) {
    log.info("a2a_inbox_injected", {
      runId: params.runId,
      sessionKey: canonicalKey,
      sourceSessionKey,
      eventCount,
    });
    log.info("a2a_inbox_cleared", {
      runId: params.runId,
      sessionKey: canonicalKey,
      sourceSessionKey,
      eventCount,
    });
  }

  return { prependContext: block.text };
}
