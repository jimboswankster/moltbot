/**
 * Gateway Send + A2A Announce Integration Tests
 *
 * Protocol: TEST-INTEGRATION v1.0.0
 * QC Protocol: TEST-QA-PASSING-FAILURE v1.0.0
 *
 * PURPOSE: Ensure announce delivery does not double-store via mirror.
 * This test validates the interaction between A2A announce and gateway send
 * to prevent duplicate session history entries.
 *
 * Gap #1 from code-inspection.md: Gateway "send" mirror behavior
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks for integration boundary
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
  sendText: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" }),
  sendMedia: vi.fn().mockResolvedValue({ messageId: "m2", chatId: "c1" }),
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => ({
    sessionKey: "agent:main:slack:channel:resolved",
  })),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({
      session: { scope: "per-sender", mainKey: "main" },
    }),
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => ({ outbound: { sendText: true, sendMedia: true } }),
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: async () => ({
    sendText: (opts: unknown) => mocks.sendText(opts),
    sendMedia: (opts: unknown) => mocks.sendMedia(opts),
  }),
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: () => ({ ok: true, to: "resolved-target" }),
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  ensureOutboundSessionEntry: (opts: unknown) => mocks.ensureOutboundSessionEntry(opts),
  resolveOutboundSessionRoute: (opts: unknown) => mocks.resolveOutboundSessionRoute(opts),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: (opts: unknown) =>
      mocks.appendAssistantMessageToSessionTranscript(opts),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Imports (after mocks)
// ─────────────────────────────────────────────────────────────────────────────

import type { GatewayRequestContext } from "./types.js";
import { sendHandlers } from "./send.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────────────────

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
  }) as unknown as GatewayRequestContext;

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Announce + Mirror Interaction
// ─────────────────────────────────────────────────────────────────────────────

describe("Gateway Send - A2A Announce Mirror Behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendText.mockResolvedValue({ messageId: "m1", chatId: "c1" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * SCENARIO: A2A announce delivery calls gateway send with sessionKey
   *
   * When the A2A flow completes and calls sendHandlers.send to announce,
   * the mirror feature records the sent message in session history.
   *
   * RISK: If A2A also stores the message elsewhere, we get double storage.
   *
   * This test verifies the mirror path is called exactly once per send.
   */
  it("persists mirror when sessionKey provided", async () => {
    // Observable: mirror persisted via appendAssistantMessageToSessionTranscript

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "user:123",
        message: "A2A announce: Task completed successfully!",
        channel: "telegram",
        idempotencyKey: "announce-idem-001",
        sessionKey: "agent:main:main", // Provided by A2A announce
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        text: "A2A announce: Task completed successfully!",
      }),
    );
  });

  it("persists mirror once per send when sessionKey provided", async () => {
    // Observable: appendAssistantMessageToSessionTranscript called once via delivery layer

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "user:456",
        message: "Summary of agent work",
        channel: "telegram",
        idempotencyKey: "announce-idem-002",
        sessionKey: "agent:main:subagent:task-001",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "2", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Mirror is persisted once via delivery layer
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:subagent:task-001",
      }),
    );
  });

  it("lowercases session key in mirror to prevent case-based duplicates", async () => {
    // Observable: mirror.sessionKey is lowercased

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "channel:C123",
        message: "Announce message",
        channel: "slack",
        idempotencyKey: "announce-idem-003",
        sessionKey: "agent:main:Slack:channel:C123", // Mixed case
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "3", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Verify session key is lowercased to prevent case-based duplicates
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:channel:c123", // Lowercased
      }),
    );
  });

  /**
   * EDGE CASE: What happens when delivery fails?
   *
   * If deliverOutboundPayloads throws or returns empty, the mirror should
   * NOT be persisted (no partial state).
   */
  it("does not persist mirror when delivery fails", async () => {
    // Observable: respond called with error, no mirror persisted
    mocks.sendText.mockRejectedValueOnce(new Error("Delivery failed"));

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "user:789",
        message: "Announce that may fail",
        channel: "telegram",
        idempotencyKey: "announce-idem-004",
        sessionKey: "agent:main:main",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "4", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Response should indicate failure
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE", // Error code is a string, not a number
        message: expect.stringContaining("Delivery failed"),
      }),
      expect.objectContaining({
        channel: "telegram",
      }),
    );

    // Delivery failed, so mirror persistence should not occur
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: A2A Announce Without Mirror (no sessionKey)
// ─────────────────────────────────────────────────────────────────────────────

describe("Gateway Send - A2A Announce Without SessionKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendText.mockResolvedValue({ messageId: "m1", chatId: "c1" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("derives session key when not provided (fallback path)", async () => {
    // Observable: ensureOutboundSessionEntry called for derived session

    const respond = vi.fn();
    await sendHandlers.send({
      params: {
        to: "user:000",
        message: "Announce without explicit session",
        channel: "telegram",
        idempotencyKey: "announce-idem-005",
        // No sessionKey provided - will derive
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "5", method: "send" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Should call ensureOutboundSessionEntry for derived route
    expect(mocks.ensureOutboundSessionEntry).toHaveBeenCalled();

    // Mirror should use derived session key
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:channel:resolved",
      }),
    );
  });
});

/**
 * QC PROTOCOL CHECKLIST (Protocol: TEST-QA-PASSING-FAILURE v1.0.0)
 * ─────────────────────────────────────────────────────────────────
 * [x] PHASE_1: Test inventory declared in describe() blocks
 * [x] PHASE_2: SUT (sendHandlers.send) actually invoked
 * [x] PHASE_3: Assertions verify behavior (mock call counts, params)
 * [x] PHASE_4: No test.skip without rationale
 * [x] PHASE_5: Error paths tested (delivery failure)
 * [x] PHASE_6: Each test uses fresh mocks (beforeEach/afterEach cleanup)
 * [x] PHASE_7: Integration test mocks external I/O only (delivery, sessions)
 * [x] PHASE_8: Mutation check - tests would fail if mirror logic changed
 * [x] PHASE_9: All violations addressed
 *
 * Observable sources documented per test.
 * Mocks target external I/O boundaries (delivery, session storage).
 * SUT function (sendHandlers.send) remains real.
 */
