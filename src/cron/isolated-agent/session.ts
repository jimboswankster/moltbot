import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../../config/sessions.js";

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const sessionId = crypto.randomUUID();
  const systemSent = false;
  const sessionEntry: SessionEntry = {
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    model: entry?.model,
    // `contextTokens` is a CAPABILITY of the model (its window size), so it is
    // carried across — but the usage counters below describe context consumed by
    // a session that no longer exists, and this function always mints a NEW one
    // (fresh sessionId, systemSent=false, isNewSession=true).
    contextTokens: entry?.contextTokens,
    // Usage counters are deliberately NOT inherited. Carrying them made the
    // token-budget guard in run.ts judge an empty session by the consumption of
    // a dead one:
    //
    //   tokenBudgetThreshold = floor(contextTokens * 0.9)
    //   if (totalTokens >= tokenBudgetThreshold) -> status "skipped"
    //
    // and because that guard SKIPS instead of running, the skipped run recorded
    // no new usage, so the inherited number never moved. A job that crossed 90%
    // once was then skipped on every subsequent tick, forever, with no path to
    // recovery. Observed 2026-08-11 on the arbiter merge-queue heartbeat: 459
    // consecutive skips over 232 hours with totalTokens frozen at exactly
    // 183068/200000 — which silently removed the only autonomous merge-queue
    // drain for ten days. Two other isolated agentTurn jobs were wedged the same
    // way at 187993 and 193017.
    //
    // A new session has consumed nothing, so it starts at zero and the guard
    // measures what it actually claims to measure.
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    compactionCount: undefined,
    sendPolicy: entry?.sendPolicy,
    lastChannel: entry?.lastChannel,
    lastTo: entry?.lastTo,
    lastAccountId: entry?.lastAccountId,
    skillsSnapshot: entry?.skillsSnapshot,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession: true };
}
