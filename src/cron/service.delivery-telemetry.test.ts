import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const { emitSystemEventMock, recordRuntimeTelemetryEventMock, fireDeskAnnounceMock } = vi.hoisted(
  () => ({
    emitSystemEventMock: vi.fn(),
    recordRuntimeTelemetryEventMock: vi.fn(),
    fireDeskAnnounceMock: vi.fn(async () => true),
  }),
);

vi.mock("../telemetry/supabase.js", () => ({
  emitSystemEvent: emitSystemEventMock,
}));

vi.mock("../infra/runtime-telemetry.js", () => ({
  recordRuntimeTelemetryEvent: recordRuntimeTelemetryEventMock,
}));

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-delivery-telemetry-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

describe("CronService delivery telemetry mirror", () => {
  afterEach(() => {
    emitSystemEventMock.mockClear();
    recordRuntimeTelemetryEventMock.mockClear();
    fireDeskAnnounceMock.mockClear();
  });

  it("mirrors main-session origin events into runtime telemetry", async () => {
    const store = await makeStorePath();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    const job = await cron.add({
      name: "main session telemetry",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      mainDeliveryStrategy: "main-session",
      payload: { kind: "systemEvent", text: "deliver me" },
    });

    await cron.run(job.id, "force");

    const eventNames = recordRuntimeTelemetryEventMock.mock.calls.map((call) => call[0]?.event);
    expect(eventNames).toContain("cron_main_delivery_strategy_selected");
    expect(eventNames).toContain("system_event_enqueued");

    cron.stop();
    await store.cleanup();
  });

  it("mirrors desk handoff attempt+success events into runtime telemetry", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: "done",
      })),
    });
    await cron.start();
    const job = await cron.add({
      name: "desk strategy telemetry",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      isolation: { postbackStrategy: "desk" },
    });

    await cron.run(job.id, "force");

    const eventNames = recordRuntimeTelemetryEventMock.mock.calls.map((call) => call[0]?.event);
    expect(eventNames).toContain("cron_desk_handoff_attempt");
    expect(eventNames).toContain("cron_desk_handoff_enqueued");

    cron.stop();
    await store.cleanup();
  });
});
