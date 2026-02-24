import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const fireDeskAnnounceMock = vi.fn(async () => true);

vi.mock("../agents/subagent-announce.js", () => ({
  fireDeskAnnounce: fireDeskAnnounceMock,
}));

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-desk-"));
  return {
    storePath: path.join(dir, "cron", "jobs.config.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

describe("CronService desk postback", () => {
  afterEach(() => {
    fireDeskAnnounceMock.mockClear();
  });

  it("defaults requester session key to main when job.agentId is missing", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runCommandJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "desk-ok",
      outputText: "desk-ok",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob,
    });

    await cron.start();
    const job = await cron.add({
      name: "desk-default-agent",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "command",
        command: "echo desk",
      },
      isolation: {
        postbackStrategy: "desk",
        postToMainPrefix: "Desk",
        postToMainMode: "summary",
      },
    });

    const result = await cron.run(job.id, "force");
    expect(result.ok).toBe(true);
    expect(fireDeskAnnounceMock).toHaveBeenCalledTimes(1);
    const firstCall = fireDeskAnnounceMock.mock.calls[0]?.[0] as
      | { requesterSessionKey?: string; trace?: { traceId?: string; cronJobId?: string } }
      | undefined;
    expect(firstCall?.requesterSessionKey).toBe("agent:main:main");
    expect(firstCall?.trace?.cronJobId).toBe(job.id);
    expect(typeof firstCall?.trace?.traceId).toBe("string");
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });
});
