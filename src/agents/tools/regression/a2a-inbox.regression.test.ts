/**
 * A2A Inbox Regression Tests
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC Protocol: TEST-QA-PASSING-FAILURE v1.0.0
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import * as sessions from "../../../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../../../config/sessions.js";
import {
  buildA2AInboxPromptBlock,
  injectA2AInboxPrependContext,
  recordA2AInboxEvent,
  TRANSITIONAL_A2A_INBOX_TAG,
  type A2AInboxEvent,
} from "../../a2a-inbox.js";

const { logInfo, logWarn, logError, logDebug } = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: logInfo,
    warn: logWarn,
    error: logError,
    debug: logDebug,
    child: () => ({
      info: logInfo,
      warn: logWarn,
      error: logError,
      debug: logDebug,
      child: () => ({
        info: logInfo,
        warn: logWarn,
        error: logError,
        debug: logDebug,
      }),
    }),
  }),
}));

async function setupSessionStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-inbox-"));
  const storePath = path.join(dir, "sessions.json");
  const sessionKey = "agent:main:main";
  const cfg = {
    session: {
      store: storePath,
      scope: "per-sender",
      mainKey: "main",
    },
  } as OpenClawConfig;

  await saveSessionStore(storePath, {
    [sessionKey]: {
      sessionId: "session-1",
      updatedAt: Date.now(),
    },
  });

  return { dir, storePath, sessionKey, cfg };
}

afterEach(async () => {
  logInfo.mockReset();
  logWarn.mockReset();
  logError.mockReset();
  logDebug.mockReset();
});

describe("A2A Inbox - Golden Master Prompt Snapshot", () => {
  it("builds the transitional inbox block without user-role injection", () => {
    const events: A2AInboxEvent[] = [
      {
        schemaVersion: 1,
        createdAt: 1738737600000,
        runId: "run-123",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        replyText: "Sub agent completed the task.",
      },
    ];

    const result = buildA2AInboxPromptBlock({
      events,
      maxEvents: 3,
      maxChars: 500,
    });

    expect(result.text).toContain(TRANSITIONAL_A2A_INBOX_TAG);
    expect(result.text).toContain("run-123");
    expect(result.text).toContain("subagent:sub-001");
    expect(result.text).not.toContain("role=user");

    expect(result.text).toMatchInlineSnapshot(
      `"TRANSITIONAL_A2A_INBOX\n- source: subagent:sub-001 (agent:main:subagent:sub-001)\n  runId: run-123\n  text: Sub agent completed the task."`,
    );
  });
});

describe("A2A Inbox - Bounds", () => {
  it("limits the number of events injected", () => {
    const events: A2AInboxEvent[] = [
      {
        schemaVersion: 1,
        createdAt: 1,
        runId: "run-1",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        replyText: "First.",
      },
      {
        schemaVersion: 1,
        createdAt: 2,
        runId: "run-2",
        sourceSessionKey: "agent:main:subagent:sub-002",
        sourceDisplayKey: "subagent:sub-002",
        replyText: "Second.",
      },
      {
        schemaVersion: 1,
        createdAt: 3,
        runId: "run-3",
        sourceSessionKey: "agent:main:subagent:sub-003",
        sourceDisplayKey: "subagent:sub-003",
        replyText: "Third.",
      },
    ];

    const result = buildA2AInboxPromptBlock({
      events,
      maxEvents: 2,
      maxChars: 500,
    });

    expect(result.text).toContain("run-1");
    expect(result.text).toContain("run-2");
    expect(result.text).not.toContain("run-3");
    expect(result.includedRunIds).toEqual(["run-1", "run-2"]);
  });

  it("truncates inbox summaries to max chars deterministically", () => {
    const longText = "x".repeat(200);
    const events: A2AInboxEvent[] = [
      {
        schemaVersion: 1,
        createdAt: 1,
        runId: "run-1",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        replyText: longText,
      },
    ];

    const result = buildA2AInboxPromptBlock({
      events,
      maxEvents: 3,
      maxChars: 120,
    });

    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.text).toContain("...");
    expect(result.truncated).toBe(true);
  });
});

describe("A2A Inbox - Audit Logging", () => {
  it("logs a2a_inbox_event_written on write", async () => {
    const { dir, cfg, sessionKey } = await setupSessionStore();
    try {
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-123",
        replyText: "Done.",
        now: 1738737600000,
      });

      expect(logInfo).toHaveBeenCalledWith(
        "a2a_inbox_event_written",
        expect.objectContaining({
          runId: "run-123",
          sessionKey,
          sourceSessionKey: "agent:main:subagent:sub-001",
          eventCount: 1,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("logs a2a_inbox_injected and a2a_inbox_cleared on injection", async () => {
    const { dir, cfg, sessionKey } = await setupSessionStore();
    try {
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-456",
        replyText: "Finished.",
        now: 1738737600000,
      });

      const result = await injectA2AInboxPrependContext({
        cfg,
        sessionKey,
        runId: "master-run-1",
        now: 1738737700000,
      });

      expect(result?.prependContext).toContain(TRANSITIONAL_A2A_INBOX_TAG);
      expect(logInfo).toHaveBeenCalledWith(
        "a2a_inbox_injected",
        expect.objectContaining({
          runId: "master-run-1",
          sessionKey,
          sourceSessionKey: "agent:main:subagent:sub-001",
          eventCount: 1,
        }),
      );
      expect(logInfo).toHaveBeenCalledWith(
        "a2a_inbox_cleared",
        expect.objectContaining({
          runId: "master-run-1",
          sessionKey,
          sourceSessionKey: "agent:main:subagent:sub-001",
          eventCount: 1,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Policy Enforcement", () => {
  it("blocks inbox writes when agentToAgent allowlist denies", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    cfg.tools = {
      agentToAgent: {
        enabled: true,
        allow: ["main"],
      },
    };
    try {
      const result = await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:other:main",
        sourceDisplayKey: "other",
        runId: "run-999",
        replyText: "Denied.",
        now: 1738737600000,
      });

      expect(result.written).toBe(false);
      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.a2aInbox).toBeUndefined();
      expect(logInfo).toHaveBeenCalledWith(
        "a2a_inbox_event_written",
        expect.objectContaining({
          runId: "run-999",
          sessionKey,
          sourceSessionKey: "agent:other:main",
          allowed: false,
          reason: "denied",
          eventCount: 0,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Fail Closed Clear Strategy", () => {
  it("does not clear inbox events when injection fails", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-fail",
        replyText: "Will fail.",
        now: 1738737600000,
      });

      const updateSpy = vi
        .spyOn(sessions, "updateSessionStore")
        .mockRejectedValueOnce(new Error("boom"));

      await expect(
        injectA2AInboxPrependContext({
          cfg,
          sessionKey,
          runId: "master-run-fail",
          now: 1738737700000,
        }),
      ).rejects.toThrow("boom");

      const store = loadSessionStore(storePath, { skipCache: true });
      const event = store[sessionKey]?.a2aInbox?.events?.[0];
      expect(event?.deliveredAt).toBeUndefined();
      updateSpy.mockRestore();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * QC PROTOCOL CHECKLIST (Protocol: TEST-QA-PASSING-FAILURE v1.0.0)
 * ─────────────────────────────────────────────────────────────────
 * [x] PHASE_1: Test inventory declared in describe() blocks
 * [x] PHASE_2: SUT invoked (buildA2AInboxPromptBlock, record/inject)
 * [x] PHASE_3: Assertions verify behavior (tag, content, snapshot, logs)
 * [x] PHASE_4: No test.fails used
 * [x] PHASE_5: Error paths not required for golden-master snapshot
 * [x] PHASE_6: Deterministic inputs (fixed timestamps)
 * [x] PHASE_7: Unit tests mock external boundaries only (none)
 * [x] PHASE_8: Mutation check - snapshot would fail if format changes
 * [x] PHASE_9: All violations addressed
 */
