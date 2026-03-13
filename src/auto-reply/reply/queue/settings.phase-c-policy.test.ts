import { describe, expect, it } from "vitest";
import { resolveQueueSettings } from "./settings.js";

function makeCfg(overrides?: Record<string, unknown>) {
  return {
    messages: {
      queue: {},
    },
    ...(overrides ?? {}),
  };
}

describe("queue settings phase-c policy", () => {
  it("defaults telegram conversational traffic to steer-backlog", () => {
    const settings = resolveQueueSettings({
      cfg: makeCfg(),
      channel: "telegram",
      intent: "conversation",
    });
    expect(settings.mode).toBe("steer-backlog");
  });

  it("defaults telegram command/control traffic to interrupt", () => {
    const settings = resolveQueueSettings({
      cfg: makeCfg(),
      channel: "telegram",
      intent: "command-control",
    });
    expect(settings.mode).toBe("interrupt");
  });

  it("keeps non-telegram default mode as collect", () => {
    const settings = resolveQueueSettings({
      cfg: makeCfg(),
      channel: "whatsapp",
      intent: "conversation",
    });
    expect(settings.mode).toBe("collect");
  });

  it("preserves explicit configured mode over intent defaults", () => {
    const settings = resolveQueueSettings({
      cfg: makeCfg({
        messages: {
          queue: {
            byChannel: {
              telegram: "followup",
            },
          },
        },
      }),
      channel: "telegram",
      intent: "command-control",
    });
    expect(settings.mode).toBe("followup");
  });

  it("preserves session override mode over intent defaults", () => {
    const settings = resolveQueueSettings({
      cfg: makeCfg(),
      channel: "telegram",
      intent: "conversation",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        queueMode: "interrupt",
      },
    });
    expect(settings.mode).toBe("interrupt");
  });
});
