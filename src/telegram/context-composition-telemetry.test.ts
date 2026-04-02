import { describe, expect, it } from "vitest";
import { buildTelegramContextCompositionEvent } from "./context-composition-telemetry.js";

describe("buildTelegramContextCompositionEvent", () => {
  it("measures pending history share from the combined body", () => {
    const event = buildTelegramContextCompositionEvent({
      sessionKey: "agent:main:telegram:group:-1003778262727:topic:237",
      chatId: -1003778262727,
      topicId: 237,
      isGroup: true,
      historyLimit: 5,
      pendingHistoryEntryCount: 3,
      rawBody: "ship it",
      envelopeBody: "Current message body",
      combinedBody: "history history history\n\nCurrent message body",
    });

    expect(event.schema_version).toBe("telegram.context-composition.v1");
    expect(event.topicId).toBe("237");
    expect(event.pendingHistoryEntryCount).toBe(3);
    expect(event.pendingHistoryChars).toBe(
      "history history history\n\nCurrent message body".length - "Current message body".length,
    );
    expect(event.pendingHistoryShare).toBeGreaterThan(0);
    expect(event.envelopeBodyChars).toBe("Current message body".length);
    expect(event.combinedBodyChars).toBe("history history history\n\nCurrent message body".length);
  });
});
