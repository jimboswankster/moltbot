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
import { recordA2AInboxDisplayFallback } from "../infra/a2a-telemetry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSubagentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveDefaultAgentId } from "./agent-scope.js";
import { createAgentToAgentPolicy } from "./tools/sessions-helpers.js";

export const TRANSITIONAL_A2A_INBOX_TAG = "TRANSITIONAL_A2A_INBOX";
export const A2A_INBOX_SCHEMA_VERSION = 1;
export const A2A_INBOX_MAX_EVENTS = 3;
export const A2A_INBOX_MAX_CHARS = 500;
export const A2A_INBOX_MAX_AGE_MS = 10 * 60 * 1000;

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

function resolveDisplayKeyFromEntry(
  entry: { displayName?: string; label?: string; origin?: { label?: string } } | undefined,
): string | undefined {
  const displayName = entry?.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const label = entry?.label?.trim();
  if (label) {
    return label;
  }
  const originLabel = entry?.origin?.label?.trim();
  if (originLabel) {
    return originLabel;
  }
  return undefined;
}

type A2AInboxValidationResult =
  | { ok: true; events: A2AInboxEvent[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateA2AInboxState(value: unknown): A2AInboxValidationResult {
  if (!isRecord(value)) {
    return { ok: false, error: "a2aInbox is not an object" };
  }
  const events = value.events;
  if (!Array.isArray(events)) {
    return { ok: false, error: "a2aInbox.events is not an array" };
  }

  for (const event of events) {
    if (!isRecord(event)) {
      return { ok: false, error: "a2aInbox.event is not an object" };
    }
    if (typeof event.schemaVersion !== "number") {
      return { ok: false, error: "a2aInbox.event.schemaVersion is invalid" };
    }
    if (typeof event.createdAt !== "number") {
      return { ok: false, error: "a2aInbox.event.createdAt is invalid" };
    }
    if (typeof event.runId !== "string") {
      return { ok: false, error: "a2aInbox.event.runId is invalid" };
    }
    if (typeof event.sourceSessionKey !== "string") {
      return { ok: false, error: "a2aInbox.event.sourceSessionKey is invalid" };
    }
    if (typeof event.replyText !== "string") {
      return { ok: false, error: "a2aInbox.event.replyText is invalid" };
    }
    if (event.sourceDisplayKey !== undefined && typeof event.sourceDisplayKey !== "string") {
      return { ok: false, error: "a2aInbox.event.sourceDisplayKey is invalid" };
    }
    if (event.deliveredAt !== undefined && typeof event.deliveredAt !== "number") {
      return { ok: false, error: "a2aInbox.event.deliveredAt is invalid" };
    }
    if (event.deliveredRunId !== undefined && typeof event.deliveredRunId !== "string") {
      return { ok: false, error: "a2aInbox.event.deliveredRunId is invalid" };
    }
  }

  return { ok: true, events: events as A2AInboxEvent[] };
}

function resolveInboxStoreTarget(cfg: OpenClawConfig, sessionKey: string): A2AInboxStoreTarget {
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId =
    canonicalKey === "global" || canonicalKey === "unknown"
      ? resolveDefaultAgentId(cfg)
      : resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return { storePath, canonicalKey };
}

function resolveA2ASourceDisplayKey(params: {
  cfg: OpenClawConfig;
  sourceSessionKey: string;
  sourceDisplayKey?: string;
}): { key: string; fallbackToSessionKey: boolean } {
  const { storePath, canonicalKey } = resolveInboxStoreTarget(params.cfg, params.sourceSessionKey);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[canonicalKey];
  const fromEntry = resolveDisplayKeyFromEntry(entry);
  if (fromEntry) {
    return { key: fromEntry, fallbackToSessionKey: false };
  }
  const provided = params.sourceDisplayKey?.trim();
  if (provided) {
    return { key: provided, fallbackToSessionKey: false };
  }
  return { key: params.sourceSessionKey, fallbackToSessionKey: true };
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
  const policy = createAgentToAgentPolicy(params.cfg);
  const requesterAgentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const targetAgentId = resolveAgentIdFromSessionKey(params.sourceSessionKey);
  if (!policy.isAllowed(requesterAgentId, targetAgentId)) {
    log.info("a2a_inbox_event_written", {
      runId: params.runId,
      sessionKey: params.sessionKey,
      sourceSessionKey: params.sourceSessionKey,
      eventCount: 0,
      allowed: false,
      reason: "denied",
    });
    return { written: false, eventId: null };
  }

  const { storePath, canonicalKey } = resolveInboxStoreTarget(params.cfg, params.sessionKey);
  const providedDisplayKey = params.sourceDisplayKey?.trim();
  const eventId = crypto.randomUUID();
  let written = false;

  try {
    const resolvedDisplay = resolveA2ASourceDisplayKey({
      cfg: params.cfg,
      sourceSessionKey: params.sourceSessionKey,
      sourceDisplayKey: params.sourceDisplayKey,
    });
    if (resolvedDisplay.fallbackToSessionKey && isSubagentSessionKey(params.sourceSessionKey)) {
      recordA2AInboxDisplayFallback(params.sourceSessionKey, "missing_label");
      log.warn("a2a_inbox_display_fallback", {
        runId: params.runId,
        sessionKey: canonicalKey,
        sourceSessionKey: params.sourceSessionKey,
        reason: "missing_label",
      });
      if (!providedDisplayKey) {
        log.warn("a2a_inbox_missing_label_blocked", {
          runId: params.runId,
          sessionKey: canonicalKey,
          sourceSessionKey: params.sourceSessionKey,
        });
        return { written: false, eventId: null };
      }
    }
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
        sourceDisplayKey: resolvedDisplay.key,
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
  } catch (err) {
    log.error("a2a_inbox_error", {
      runId: params.runId,
      sessionKey: canonicalKey,
      sourceSessionKey: params.sourceSessionKey,
      error: formatErrorMessage(err),
    });
    return { written: false, eventId: null };
  }

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

  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[canonicalKey];
    const inbox = entry?.a2aInbox;
    if (!inbox) {
      return undefined;
    }
    const validation = validateA2AInboxState(inbox);
    if (!validation.ok) {
      log.warn("a2a_inbox_error", {
        runId: params.runId,
        sessionKey: canonicalKey,
        validationFailed: true,
        reason: validation.error,
      });
      return undefined;
    }

    const events = validation.events;
    if (events.length === 0) {
      return undefined;
    }

    const pending: A2AInboxEvent[] = [];
    const staleEvents: A2AInboxEvent[] = [];
    const unsupportedEvents: A2AInboxEvent[] = [];
    for (const event of events) {
      if (event.schemaVersion !== A2A_INBOX_SCHEMA_VERSION) {
        unsupportedEvents.push(event);
        continue;
      }
      if (event.createdAt < now - A2A_INBOX_MAX_AGE_MS) {
        staleEvents.push(event);
        continue;
      }
      if (!event.deliveredAt) {
        pending.push(event);
      }
    }

    if (staleEvents.length > 0) {
      log.warn("a2a_inbox_error", {
        runId: params.runId,
        sessionKey: canonicalKey,
        sourceSessionKey: staleEvents[0]?.sourceSessionKey,
        eventCount: staleEvents.length,
        stale: true,
      });
    }

    if (unsupportedEvents.length > 0) {
      log.warn("a2a_inbox_error", {
        runId: params.runId,
        sessionKey: canonicalKey,
        sourceSessionKey: unsupportedEvents[0]?.sourceSessionKey,
        eventCount: unsupportedEvents.length,
        unsupportedVersion: true,
      });
    }
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
  } catch (err) {
    log.error("a2a_inbox_error", {
      runId: params.runId,
      sessionKey: canonicalKey,
      error: formatErrorMessage(err),
    });
    return undefined;
  }
}
