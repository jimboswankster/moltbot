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
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let originalWorkspaceRoot: string | undefined;

beforeEach(() => {
  resetSystemEventsForTest();
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
  originalWorkspaceRoot = process.env.OPENCLAW_WORKSPACE_ROOT;
});

afterEach(() => {
  resetSystemEventsForTest();
  if (originalWorkspaceRoot === undefined) {
    delete process.env.OPENCLAW_WORKSPACE_ROOT;
  } else {
    process.env.OPENCLAW_WORKSPACE_ROOT = originalWorkspaceRoot;
  }
});

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

  const queuePath = path.join(tmpDir, "os", "coordination", "events", "cron-events.jsonl");
  const queuePathFromWorkspace = path.join(
    workspaceDir,
    "os",
    "coordination",
    "events",
    "cron-events.jsonl",
  );
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true });
  return { cfg, sessionKey, queuePath, queuePathFromWorkspace, tmpDir, cleanup };
}

const baseDeps = {
  getQueueSize: () => 0,
  webAuthExists: async () => true,
  hasActiveWebListener: () => true,
};

describe("runHeartbeatOnce - cron delivery routing", () => {
  it("routes cron reasons with pending events into queue file without LLM call", async () => {
    const { cfg, sessionKey, queuePath, tmpDir, cleanup } = await setupEmptyHeartbeat();
    process.env.OPENCLAW_WORKSPACE_ROOT = tmpDir;
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      enqueueSystemEvent("[CRON] Route me to desk queue.", { sessionKey });
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron:cron-event-router",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(res.status).toBe("ran");
      expect(replySpy).not.toHaveBeenCalled();

      const raw = await fs.readFile(queuePath, "utf-8");
      const lines = raw.trim().split(/\r?\n/);
      expect(lines.length).toBe(1);
      const payload = JSON.parse(lines[0] ?? "{}") as {
        reason?: string;
        events?: string[];
        text?: string;
        source?: string;
      };
      expect(payload.reason).toBe("cron:cron-event-router");
      expect(Array.isArray(payload.events)).toBe(true);
      expect(payload.text).toContain("[CRON] Route me to desk queue.");
      expect(payload.source).toBe("cron");
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("does not route to queue when cron reason has no pending events and falls back to normal reply flow", async () => {
    const { cfg, queuePath, tmpDir, cleanup } = await setupEmptyHeartbeat();
    process.env.OPENCLAW_WORKSPACE_ROOT = tmpDir;
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
      replySpy.mockResolvedValue([{ text: "No pending cron event payloads." }]);

      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron:cron-event-router",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      await expect(fs.access(queuePath)).rejects.toBeTruthy();
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("treats cron-main-session as non-queue path and executes reply flow", async () => {
    const { cfg, sessionKey, queuePath, tmpDir, cleanup } = await setupEmptyHeartbeat();
    process.env.OPENCLAW_WORKSPACE_ROOT = tmpDir;
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      enqueueSystemEvent("[BRIEF] Deliver to user-facing lane.", { sessionKey });
      replySpy.mockResolvedValue([{ text: "Morning brief delivered." }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron-main-session:morning-brief",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      await expect(fs.access(queuePath)).rejects.toBeTruthy();
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("routes cron reasons to the agent workspace root when OPENCLAW_WORKSPACE_ROOT is unset", async () => {
    const { cfg, sessionKey, queuePathFromWorkspace, cleanup } = await setupEmptyHeartbeat();
    delete process.env.OPENCLAW_WORKSPACE_ROOT;
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      enqueueSystemEvent("[CRON] Workspace-root fallback queue path.", { sessionKey });
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron:cron-event-router",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(res.status).toBe("ran");
      expect(replySpy).not.toHaveBeenCalled();
      const raw = await fs.readFile(queuePathFromWorkspace, "utf-8");
      const lines = raw.trim().split(/\r?\n/);
      expect(lines.length).toBe(1);
      const payload = JSON.parse(lines[0] ?? "{}") as {
        reason?: string;
        text?: string;
        source?: string;
      };
      expect(payload.reason).toBe("cron:cron-event-router");
      expect(payload.text).toContain("Workspace-root fallback queue path.");
      expect(payload.source).toBe("cron");
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("records heartbeat delivery telemetry with cron correlation on successful send", async () => {
    const { cfg, sessionKey, tmpDir, cleanup } = await setupEmptyHeartbeat();
    const telemetryPath = path.join(tmpDir, "runtime-telemetry.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      enqueueSystemEvent("[BRIEF] Deliver with trace telemetry.", { sessionKey });
      replySpy.mockResolvedValue([{ text: "Morning brief delivered." }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron-main-session:morning-brief:run-123",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(res.status).toBe("ran");
      const telemetryRaw = await fs.readFile(telemetryPath, "utf-8");
      const rows = telemetryRaw
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { event?: string; details?: Record<string, unknown> });
      const sentRow = rows.find((row) => row.event === "heartbeat.delivery_sent");
      expect(sentRow).toBeDefined();
      expect(sentRow?.details?.cronJobId).toBe("morning-brief");
      expect(sentRow?.details?.cronRunId).toBe("run-123");
      expect(sentRow?.details?.reason).toBe("cron-main-session:morning-brief:run-123");
    } finally {
      replySpy.mockRestore();
      delete process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
      await cleanup();
    }
  });
});
