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
import { resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

const baseDeps = {
  getQueueSize: () => 0,
  webAuthExists: async () => true,
  hasActiveWebListener: () => true,
};

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

async function setupHeartbeatConfig(): Promise<{
  cfg: OpenClawConfig;
  tmpDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-escalation-"));
  const storePath = path.join(tmpDir, "sessions.json");
  const workspaceDir = path.join(tmpDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "HEARTBEAT.md"),
    "# HEARTBEAT.md\n\n## Tasks\n\n- Check triage.\n",
    "utf-8",
  );

  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        heartbeat: {
          every: "5m",
          target: "whatsapp",
          model: "ollama/llama3.1:8b",
          escalation: {
            enabled: true,
            triggerToken: "[[NEEDS_REASONING]]",
            model: "openrouter/z-ai/glm-5",
          },
        },
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

  return { cfg, tmpDir, cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }) };
}

describe("runHeartbeatOnce - escalation routing", () => {
  it("runs second heartbeat pass with heartbeatModelOverride when trigger token is emitted", async () => {
    const { cfg, tmpDir, cleanup } = await setupHeartbeatConfig();
    process.env.OPENCLAW_WORKSPACE_ROOT = tmpDir;
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
    replySpy
      .mockResolvedValueOnce([{ text: "[[NEEDS_REASONING]] triage says deeper analysis needed." }])
      .mockResolvedValueOnce([{ text: "Final escalated response." }]);

    try {
      const result = await runHeartbeatOnce({
        cfg,
        reason: "manual-test",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(2);
      const secondCall = replySpy.mock.calls[1];
      expect(secondCall?.[1]).toEqual(
        expect.objectContaining({
          isHeartbeat: true,
          heartbeatModelOverride: "openrouter/z-ai/glm-5",
        }),
      );
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      const outbound = JSON.stringify(sendWhatsApp.mock.calls[0] ?? []);
      expect(outbound).toContain("Final escalated response.");
      expect(outbound).not.toContain("[[NEEDS_REASONING]]");
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });

  it("stays single-pass when trigger token is absent", async () => {
    const { cfg, tmpDir, cleanup } = await setupHeartbeatConfig();
    process.env.OPENCLAW_WORKSPACE_ROOT = tmpDir;
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
    replySpy.mockResolvedValueOnce([{ text: "No escalation required." }]);

    try {
      const result = await runHeartbeatOnce({
        cfg,
        reason: "manual-test",
        deps: { ...baseDeps, sendWhatsApp, nowMs: () => Date.now() },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      const outbound = JSON.stringify(sendWhatsApp.mock.calls[0] ?? []);
      expect(outbound).toContain("No escalation required.");
    } finally {
      replySpy.mockRestore();
      await cleanup();
    }
  });
});
