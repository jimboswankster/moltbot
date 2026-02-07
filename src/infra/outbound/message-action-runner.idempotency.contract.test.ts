import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendPoll: vi.fn(),
}));

vi.mock("./message.js", async () => {
  const actual = await vi.importActual<typeof import("./message.js")>("./message.js");
  return {
    ...actual,
    sendMessage: mocks.sendMessage,
    sendPoll: mocks.sendPoll,
  };
});

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

describe("runMessageAction idempotency (contract)", () => {
  beforeEach(async () => {
    const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
    const { setSlackRuntime } = await import("../../../extensions/slack/src/runtime.js");
    const runtime = createPluginRuntime();
    setSlackRuntime(runtime);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.sendMessage.mockReset();
    mocks.sendPoll.mockReset();
  });

  it("forwards idempotencyKey to sendMessage", async () => {
    mocks.sendMessage.mockResolvedValue({
      channel: "slack",
      to: "#C12345678",
      via: "gateway",
      mediaUrl: null,
      dryRun: true,
    });

    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "#C12345678",
        message: "hi",
        idempotencyKey: "idem-send",
      },
      dryRun: true,
    });

    const call = mocks.sendMessage.mock.calls[0]?.[0];
    expect(call?.idempotencyKey).toBe("idem-send");
  });

  it("forwards idempotencyKey to sendPoll", async () => {
    mocks.sendPoll.mockResolvedValue({
      channel: "slack",
      to: "#C12345678",
      question: "Q?",
      options: ["A", "B"],
      maxSelections: 1,
      durationHours: null,
      via: "gateway",
      dryRun: true,
    });

    await runMessageAction({
      cfg: slackConfig,
      action: "poll",
      params: {
        channel: "slack",
        target: "#C12345678",
        pollQuestion: "Q?",
        pollOption: ["A", "B"],
        idempotencyKey: "idem-poll",
      },
      dryRun: true,
    });

    const call = mocks.sendPoll.mock.calls[0]?.[0];
    expect(call?.idempotencyKey).toBe("idem-poll");
  });
});
