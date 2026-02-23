import { describe, expect, it } from "vitest";
import { normalizeCronJobCreate } from "./normalize.js";

describe("normalizeCronJobCreate", () => {
  it("maps legacy payload.provider to payload.channel and strips provider", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        provider: " TeLeGrAm ",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.channel).toBe("telegram");
    expect("provider" in payload).toBe(false);
  });

  it("trims agentId and drops null", () => {
    const normalized = normalizeCronJobCreate({
      name: "agent-set",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      agentId: " Ops ",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.agentId).toBe("ops");

    const cleared = normalizeCronJobCreate({
      name: "agent-clear",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      agentId: null,
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    }) as unknown as Record<string, unknown>;

    expect(cleared.agentId).toBeNull();
  });

  it("canonicalizes payload.channel casing", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy provider",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: "Telegram",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.channel).toBe("telegram");
  });

  it("coerces ISO schedule.at to atMs (UTC)", () => {
    const normalized = normalizeCronJobCreate({
      name: "iso at",
      enabled: true,
      schedule: { at: "2026-01-12T18:00:00" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.atMs).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });

  it("coerces ISO schedule.atMs string to atMs (UTC)", () => {
    const normalized = normalizeCronJobCreate({
      name: "iso atMs",
      enabled: true,
      schedule: { kind: "at", atMs: "2026-01-12T18:00:00" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.atMs).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });

  it("defaults isolated agentTurn jobs to desk postback", () => {
    const normalized = normalizeCronJobCreate({
      name: "desk-default",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "run task",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.isolation).toEqual({ postbackStrategy: "desk" });
  });

  it("preserves explicit isolation postbackStrategy", () => {
    const normalized = normalizeCronJobCreate({
      name: "explicit-direct",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "run task",
      },
      isolation: {
        postbackStrategy: "direct",
      },
    }) as unknown as Record<string, unknown>;

    const isolation = normalized.isolation as Record<string, unknown>;
    expect(isolation.postbackStrategy).toBe("direct");
  });

  it("defaults main systemEvent jobs to desk mainDeliveryStrategy", () => {
    const normalized = normalizeCronJobCreate({
      name: "main-desk-default",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "systemEvent",
        text: "hello",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.mainDeliveryStrategy).toBe("desk");
  });

  it("preserves explicit mainDeliveryStrategy for main jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "main-main-session",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      mainDeliveryStrategy: "main-session",
      payload: {
        kind: "systemEvent",
        text: "hello",
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.mainDeliveryStrategy).toBe("main-session");
  });
});
