import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCronSession } from "./isolated-agent/session.js";

/**
 * Regression: an isolated cron run always mints a NEW session, but it used to
 * inherit the PREVIOUS session's usage counters. The token-budget guard in
 * run.ts then compared a fresh, empty session against a dead session's
 * consumption and returned status "skipped" — which recorded no new usage, so
 * the inherited number never moved and the job was skipped forever, with no
 * path to recovery.
 *
 * Observed 2026-08-11: the arbiter merge-queue heartbeat logged 459 consecutive
 * skips across 232 hours with totalTokens frozen at exactly 183068/200000,
 * silently removing the only autonomous merge-queue drain for ten days. Two
 * other isolated agentTurn jobs were wedged the same way at 187993 and 193017.
 */
function withStore<T>(
  entry: Record<string, unknown>,
  fn: (cfg: OpenClawConfig, key: string) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-session-"));
  const storePath = path.join(dir, "sessions.json");
  const key = "cron:3dbb03c0-3c5e-47c4-87df-666f6894fb00";
  fs.writeFileSync(storePath, JSON.stringify({ [key]: entry }));
  try {
    return fn({ session: { store: storePath } } as unknown as OpenClawConfig, key);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const WEDGED = {
  sessionId: "prior-session",
  updatedAt: 1,
  systemSent: true,
  contextTokens: 200000,
  inputTokens: 170000,
  outputTokens: 13068,
  totalTokens: 183068,
  compactionCount: 4,
  model: "openai-codex/gpt-5.5",
};

function resolve() {
  return withStore(WEDGED, (cfg, sessionKey) =>
    resolveCronSession({ cfg, sessionKey, nowMs: 2, agentId: "main" }),
  );
}

describe("resolveCronSession", () => {
  it("does NOT inherit usage counters from the previous session", () => {
    const { sessionEntry } = resolve();
    expect(sessionEntry.totalTokens).toBeUndefined();
    expect(sessionEntry.inputTokens).toBeUndefined();
    expect(sessionEntry.outputTokens).toBeUndefined();
    expect(sessionEntry.compactionCount).toBeUndefined();
  });

  it("a session carrying the wedged value no longer trips the 90% budget guard", () => {
    const { sessionEntry } = resolve();
    // Mirrors the guard in run.ts.
    const contextTokens = sessionEntry.contextTokens ?? 200000;
    const totalTokens = sessionEntry.totalTokens ?? 0;
    const threshold = Math.floor(contextTokens * 0.9);
    expect(totalTokens >= threshold).toBe(false);
  });

  it("still carries model capability and preferences across", () => {
    const { sessionEntry } = resolve();
    // contextTokens is the model's window (a capability), not consumption.
    expect(sessionEntry.contextTokens).toBe(200000);
    expect(sessionEntry.model).toBe("openai-codex/gpt-5.5");
  });

  it("mints a fresh session identity", () => {
    const { sessionEntry, isNewSession } = resolve();
    expect(isNewSession).toBe(true);
    expect(sessionEntry.systemSent).toBe(false);
    expect(sessionEntry.sessionId).not.toBe("prior-session");
  });
});
