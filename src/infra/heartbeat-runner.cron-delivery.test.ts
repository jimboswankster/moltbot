import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resetCronHeartbeatCooldownForTest, runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  resetSystemEventsForTest();
  resetCronHeartbeatCooldownForTest();
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

afterEach(() => {
  resetSystemEventsForTest();
  resetCronHeartbeatCooldownForTest();
});

/**
 * Helper: create a temp dir with an empty HEARTBEAT.md and a session store,
 * returning the cfg and cleanup function.
 */
async function setupEmptyHeartbeat() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-hb-"));
  const storePath = path.join(tmpDir, "sessions.json");
  const workspaceDir = path.join(tmpDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });

  // Empty HEARTBEAT.md (only headers, no actionable content)
  await fs.writeFile(
    path.join(workspaceDir, "HEARTBEAT.md"),
    "# HEARTBEAT.md\n\n## Tasks\n\n",
    "utf-8",
  );

  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        heartbeat: { every: "5m", target: "whatsapp" },
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
  const sessionKey = resolveMainSessionKey(cfg);

  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
        },
      },
      null,
      2,
    ),
  );

  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true });
  return { cfg, sessionKey, cleanup };
}

const baseDeps = {
  getQueueSize: () => 0,
  webAuthExists: async () => true,
  hasActiveWebListener: () => true,
};

describe("runHeartbeatOnce — cron delivery", () => {
  it("bypasses empty-heartbeat-file gate when cron reason + pending system events + cooldown elapsed", async () => {
    const { cfg, sessionKey, cleanup } = await setupEmptyHeartbeat();
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      // Enqueue a system event for this session (simulates cron timer enqueue)
      enqueueSystemEvent("[LEDGER POLL] Check the ledger.", { sessionKey });

      replySpy.mockResolvedValue([{ text: "Ledger checked, nothing to do." }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron:ledger-poll",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      // Should run (bypass file gate) because system events are pending
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("skips with cron-cooldown when cron reason + pending events + cooldown NOT elapsed", async () => {
    const { cfg, sessionKey, cleanup } = await setupEmptyHeartbeat();
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      // First run: primes the cooldown timestamp
      enqueueSystemEvent("[LEDGER POLL] First poll.", { sessionKey });
      replySpy.mockResolvedValue([{ text: "Done." }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const baseTime = Date.now();
      const res1 = await runHeartbeatOnce({
        cfg,
        reason: "cron:ledger-poll",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => baseTime },
      });
      expect(res1.status).toBe("ran");

      // Second run: 60s later (within 5min cooldown)
      enqueueSystemEvent("[LEDGER POLL] Second poll.", { sessionKey });
      const res2 = await runHeartbeatOnce({
        cfg,
        reason: "cron:ledger-poll",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => baseTime + 60_000 },
      });

      expect(res2.status).toBe("skipped");
      if (res2.status === "skipped") {
        expect(res2.reason).toBe("cron-cooldown");
      }
      // LLM should only have been called once (the first run)
      expect(replySpy).toHaveBeenCalledTimes(1);
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("delivers again after cooldown elapses", async () => {
    const { cfg, sessionKey, cleanup } = await setupEmptyHeartbeat();
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
      const baseTime = Date.now();

      // First run
      enqueueSystemEvent("[LEDGER POLL] First.", { sessionKey });
      replySpy.mockResolvedValue([{ text: "Done." }]);
      await runHeartbeatOnce({
        cfg,
        reason: "cron:ledger-poll",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => baseTime },
      });

      // Second run: 6 minutes later (cooldown elapsed)
      enqueueSystemEvent("[LEDGER POLL] After cooldown.", { sessionKey });
      replySpy.mockResolvedValue([{ text: "Checked again." }]);
      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron:ledger-poll",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => baseTime + 6 * 60_000 },
      });

      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(2);
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("follows normal file gate when cron reason + NO pending system events", async () => {
    const { cfg, cleanup } = await setupEmptyHeartbeat();
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      // No system events enqueued
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron:ledger-poll",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      // Should skip with empty-heartbeat-file (normal gate, no bypass)
      expect(res.status).toBe("skipped");
      if (res.status === "skipped") {
        expect(res.reason).toBe("empty-heartbeat-file");
      }
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("does not affect non-cron reasons — empty file still skips", async () => {
    const { cfg, sessionKey, cleanup } = await setupEmptyHeartbeat();
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      // Even with pending system events, non-cron reasons don't bypass the gate
      enqueueSystemEvent("Some event", { sessionKey });
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(res.status).toBe("skipped");
      if (res.status === "skipped") {
        expect(res.reason).toBe("empty-heartbeat-file");
      }
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("exec-event still bypasses file gate unconditionally", async () => {
    const { cfg, cleanup } = await setupEmptyHeartbeat();
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      replySpy.mockResolvedValue([{ text: "Exec result" }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "exec-event",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      // exec-event always bypasses, regardless of system events or file content
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });
});
