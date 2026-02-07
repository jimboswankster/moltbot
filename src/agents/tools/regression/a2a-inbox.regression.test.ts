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
import type { SubagentRunRecord } from "../../subagent-registry.js";
import { resolveSubagentLabel } from "../../../auto-reply/reply/subagents-utils.js";
import * as sessions from "../../../config/sessions.js";
import {
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
} from "../../../config/sessions.js";
import { deriveSessionTitle } from "../../../gateway/session-utils.js";
import { getA2ATelemetry, resetA2ATelemetry } from "../../../infra/a2a-telemetry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../../infra/system-events.js";
import {
  buildA2AInboxPromptBlock,
  injectA2AInboxPrependContext,
  recordA2AInboxEvent,
  A2A_INBOX_MAX_AGE_MS,
  TRANSITIONAL_A2A_INBOX_TAG,
  type A2AInboxEvent,
} from "../../a2a-inbox.js";

let configOverride: OpenClawConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};
let sessionStorePathForMock = "";

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

const defaultGatewayImpl = async (req: unknown) => {
  const typed = req as { method?: string; params?: Record<string, unknown> };
  if (typed.method === "sessions.patch") {
    const key = typeof typed.params?.key === "string" ? typed.params.key : "";
    const label = typeof typed.params?.label === "string" ? typed.params.label : "";
    if (sessionStorePathForMock && key) {
      await updateSessionStore(sessionStorePathForMock, (store) => {
        const existing = store[key];
        store[key] = sessions.mergeSessionEntry(existing, {
          sessionId: existing?.sessionId ?? "patched-session",
          updatedAt: Date.now(),
          label: label || undefined,
        });
      });
    }
    return {};
  }
  if (typed.method === "agent") {
    return { runId: "run-main", status: "ok" };
  }
  if (typed.method === "agent.wait") {
    return { status: "ok" };
  }
  if (typed.method === "sessions.delete") {
    return {};
  }
  return {};
};
const callGatewayMock = vi.fn(defaultGatewayImpl);

vi.mock("../../../gateway/call.js", () => ({
  callGateway: (req: unknown) => callGatewayMock(req),
}));

vi.mock("../../pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
}));

vi.mock("../../tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(async () => "Subagent output"),
}));

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
  resetA2ATelemetry();
  resetSystemEventsForTest();
  callGatewayMock.mockReset();
  callGatewayMock.mockImplementation(defaultGatewayImpl);
  configOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  };
  sessionStorePathForMock = "";
});

describe("A2A Inbox - Golden Master Prompt Snapshot", () => {
  it("builds the transitional inbox block without user-role injection", () => {
    const events: A2AInboxEvent[] = [
      {
        schemaVersion: 1,
        createdAt: 1738737600000,
        runId: "run-123",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "Payments QA",
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
      `"TRANSITIONAL_A2A_INBOX\n- source: Payments QA (agent:main:subagent:sub-001)\n  runId: run-123\n  text: Sub agent completed the task."`,
    );
  });

  it("records a composite naming snapshot across inbox, session list, and announce formatting", () => {
    const events: A2AInboxEvent[] = [
      {
        schemaVersion: 1,
        createdAt: 1738737600000,
        runId: "run-123",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "Docs Writer",
        replyText: "Draft complete.",
      },
    ];

    const result = buildA2AInboxPromptBlock({
      events,
      maxEvents: 3,
      maxChars: 500,
    });
    const sessionTitle = deriveSessionTitle(
      { displayName: "Docs Writer", label: "docs", sessionId: "sess-1" },
      null,
    );
    const announceLabel = resolveSubagentLabel({
      label: "Docs Writer",
      task: "Fallback task",
    } as SubagentRunRecord);

    const composite = [
      result.text,
      `Session Title: ${sessionTitle ?? "(none)"}`,
      `Announce Label: ${announceLabel}`,
    ].join("\n\n");

    expect(composite).toMatchInlineSnapshot(
      `"TRANSITIONAL_A2A_INBOX\n- source: Docs Writer (agent:main:subagent:sub-001)\n  runId: run-123\n  text: Draft complete.\n\nSession Title: Docs Writer\n\nAnnounce Label: Docs Writer"`,
    );
  });

  it("disambiguates identical labels with session keys", () => {
    const events: A2AInboxEvent[] = [
      {
        schemaVersion: 1,
        createdAt: 1,
        runId: "run-a",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "Codegen",
        replyText: "Done A.",
      },
      {
        schemaVersion: 1,
        createdAt: 2,
        runId: "run-b",
        sourceSessionKey: "agent:main:subagent:sub-002",
        sourceDisplayKey: "Codegen",
        replyText: "Done B.",
      },
    ];

    const result = buildA2AInboxPromptBlock({
      events,
      maxEvents: 3,
      maxChars: 500,
    });

    expect(result.text).toContain("Codegen (agent:main:subagent:sub-001)");
    expect(result.text).toContain("Codegen (agent:main:subagent:sub-002)");
  });

  it("orders concurrent events deterministically by runId when timestamps tie", () => {
    const events: A2AInboxEvent[] = [
      {
        schemaVersion: 1,
        createdAt: 10,
        runId: "run-b",
        sourceSessionKey: "agent:main:subagent:sub-002",
        sourceDisplayKey: "Codegen",
        replyText: "Second.",
      },
      {
        schemaVersion: 1,
        createdAt: 10,
        runId: "run-a",
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "Codegen",
        replyText: "First.",
      },
    ];

    const result = buildA2AInboxPromptBlock({
      events,
      maxEvents: 3,
      maxChars: 500,
    });

    const firstIndex = result.text.indexOf("runId: run-a");
    const secondIndex = result.text.indexOf("runId: run-b");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeLessThan(secondIndex);
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

  it("prefers session displayName over provided sourceDisplayKey", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        "agent:main:subagent:sub-001": {
          sessionId: "sub-1",
          updatedAt: Date.now(),
          displayName: "Docs Writer",
        },
      });

      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-777",
        replyText: "Draft complete.",
        now: 1738737600000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events[0]?.sourceDisplayKey).toBe("Docs Writer");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers provided displayKey when namingMode=legacy", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const previousConfig = configOverride;
    configOverride = {
      ...cfg,
      tools: {
        ...cfg.tools,
        agentToAgent: {
          ...cfg.tools?.agentToAgent,
          enabled: true,
          namingMode: "legacy",
        },
      },
    };
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        "agent:main:subagent:sub-001": {
          sessionId: "sub-1",
          updatedAt: Date.now(),
          displayName: "Docs Writer",
        },
      });

      await recordA2AInboxEvent({
        cfg: configOverride,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "Provided Label",
        runId: "run-legacy",
        replyText: "Draft complete.",
        now: 1738737600000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events[0]?.sourceDisplayKey).toBe("Provided Label");
    } finally {
      configOverride = previousConfig;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers session label over origin.label and provided display key", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        "agent:main:subagent:sub-020": {
          sessionId: "sub-20",
          updatedAt: Date.now(),
          label: "Labelled Worker",
          origin: { label: "Origin Label" },
        },
      });

      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-020",
        sourceDisplayKey: "Provided Label",
        runId: "run-880",
        replyText: "Done.",
        now: 1738737600000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events[0]?.sourceDisplayKey).toBe("Labelled Worker");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to origin.label when label is missing", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        "agent:main:subagent:sub-021": {
          sessionId: "sub-21",
          updatedAt: Date.now(),
          origin: { label: "Origin Only" },
        },
      });

      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-021",
        sourceDisplayKey: "Provided Label",
        runId: "run-881",
        replyText: "Done.",
        now: 1738737600000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events[0]?.sourceDisplayKey).toBe("Origin Only");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to source session key for non-subagent sessions", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:main",
        sourceDisplayKey: " ",
        runId: "run-900",
        replyText: "No label.",
        now: 1738737600000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events[0]?.sourceDisplayKey).toBe("agent:main:main");
      const telemetry = getA2ATelemetry();
      expect(telemetry.inboxDisplayFallbackCount).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks unlabeled subagent when sessions.patch does not apply label", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const childSessionKey = "agent:main:subagent:sub-101";
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        [childSessionKey]: {
          sessionId: "sub-1",
          updatedAt: Date.now(),
        },
      });

      configOverride = {
        session: { store: storePath, scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true } },
      } as OpenClawConfig;
      sessionStorePathForMock = storePath;
      callGatewayMock.mockImplementation(async (req: unknown) => {
        const typed = req as { method?: string };
        if (typed.method === "sessions.patch") {
          return {};
        }
        if (typed.method === "agent") {
          return { runId: "run-main", status: "ok" };
        }
        if (typed.method === "agent.wait") {
          return { status: "ok" };
        }
        if (typed.method === "sessions.delete") {
          return {};
        }
        return {};
      });

      const { runSubagentAnnounceFlow } = await import("../../subagent-announce.js");
      await runSubagentAnnounceFlow({
        childSessionKey,
        childRunId: "run-child",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "main",
        task: "do it",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        label: "Docs Writer",
      });

      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: childSessionKey,
        runId: "run-inbox-2",
        replyText: "Draft complete.",
        now: 1738737600000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events.length).toBe(0);
      expect(logWarn).toHaveBeenCalledWith(
        "a2a_inbox_display_fallback",
        expect.objectContaining({
          runId: "run-inbox-2",
          sessionKey,
          sourceSessionKey: childSessionKey,
          reason: "missing_label",
        }),
      );
      expect(logWarn).toHaveBeenCalledWith(
        "a2a_inbox_missing_label_blocked",
        expect.objectContaining({
          runId: "run-inbox-2",
          sessionKey,
          sourceSessionKey: childSessionKey,
        }),
      );
      const systemEvents = peekSystemEvents(sessionKey);
      expect(systemEvents.some((event) => event.includes("A2A inbox blocked"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks inbox writes for unlabeled subagent when no display key provided", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const childSessionKey = "agent:main:subagent:sub-404";
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        [childSessionKey]: {
          sessionId: "sub-1",
          updatedAt: Date.now(),
        },
      });

      const result = await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: childSessionKey,
        runId: "run-blocked",
        replyText: "No label.",
        now: 1738737600000,
      });

      expect(result.written).toBe(false);
      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.a2aInbox).toBeUndefined();
      expect(logWarn).toHaveBeenCalledWith(
        "a2a_inbox_missing_label_blocked",
        expect.objectContaining({
          runId: "run-blocked",
          sessionKey,
          sourceSessionKey: childSessionKey,
        }),
      );
      const systemEvents = peekSystemEvents(sessionKey);
      expect(systemEvents.some((event) => event.includes("A2A inbox blocked"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("propagates sessions_spawn label into inbox via sessions.patch", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const childSessionKey = "agent:main:subagent:sub-001";
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        [childSessionKey]: {
          sessionId: "sub-1",
          updatedAt: Date.now(),
        },
      });

      configOverride = {
        session: { store: storePath, scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true } },
      } as OpenClawConfig;
      sessionStorePathForMock = storePath;

      const { runSubagentAnnounceFlow } = await import("../../subagent-announce.js");
      await runSubagentAnnounceFlow({
        childSessionKey,
        childRunId: "run-child",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "main",
        task: "do it",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        label: "Docs Writer",
      });

      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: childSessionKey,
        runId: "run-inbox-1",
        replyText: "Draft complete.",
        now: 1738737600000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events[0]?.sourceDisplayKey).toBe("Docs Writer");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("disambiguates duplicate spawn labels by session key", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const childA = "agent:main:subagent:sub-001";
    const childB = "agent:main:subagent:sub-002";
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
        [childA]: {
          sessionId: "sub-1",
          updatedAt: Date.now(),
        },
        [childB]: {
          sessionId: "sub-2",
          updatedAt: Date.now(),
        },
      });

      configOverride = {
        session: { store: storePath, scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true } },
      } as OpenClawConfig;
      sessionStorePathForMock = storePath;

      const { runSubagentAnnounceFlow } = await import("../../subagent-announce.js");
      await runSubagentAnnounceFlow({
        childSessionKey: childA,
        childRunId: "run-a",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "main",
        task: "do A",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        label: "Codegen",
      });
      await runSubagentAnnounceFlow({
        childSessionKey: childB,
        childRunId: "run-b",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "main",
        task: "do B",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        label: "Codegen",
      });

      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: childA,
        runId: "run-inbox-a",
        replyText: "Done A.",
        now: 1738737600000,
      });
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: childB,
        runId: "run-inbox-b",
        replyText: "Done B.",
        now: 1738737601000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      const block = buildA2AInboxPromptBlock({
        events,
        maxEvents: 5,
        maxChars: 500,
      });

      expect(block.text).toContain("Codegen (agent:main:subagent:sub-001)");
      expect(block.text).toContain("Codegen (agent:main:subagent:sub-002)");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Ack + Clear (feature flag)", () => {
  it("clears delivered events when inboxAckMode=clear", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      tools: {
        agentToAgent: {
          inboxAckMode: "clear",
        },
      },
    } as OpenClawConfig;

    const { storePath, sessionKey, cfg } = await setupSessionStore();
    const cfgWithAck = {
      ...cfg,
      tools: {
        agentToAgent: {
          inboxAckMode: "clear",
        },
      },
    } as OpenClawConfig;

    await recordA2AInboxEvent({
      cfg: cfgWithAck,
      sessionKey,
      sourceSessionKey: "agent:main:subagent:sub-001",
      sourceDisplayKey: "Docs Writer",
      runId: "run-ack-1",
      replyText: "Deliverable complete.",
      now: 1738737600000,
    });

    const injected = await injectA2AInboxPrependContext({
      cfg: cfgWithAck,
      sessionKey,
      runId: "run-main-ack",
      now: 1738737601000,
    });

    expect(injected?.prependContext).toContain(TRANSITIONAL_A2A_INBOX_TAG);

    const store = loadSessionStore(storePath, { skipCache: true });
    const events = store[sessionKey]?.a2aInbox?.events ?? [];
    expect(events).toHaveLength(0);
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

describe("A2A Inbox - Versioning + Staleness", () => {
  it("skips stale events without clearing", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          a2aInbox: {
            events: [
              {
                schemaVersion: 1,
                createdAt: 1738737600000,
                runId: "run-stale",
                sourceSessionKey: "agent:main:subagent:sub-001",
                sourceDisplayKey: "subagent:sub-001",
                replyText: "Old.",
              },
            ],
          },
        },
      });

      const now = 1738737600000 + A2A_INBOX_MAX_AGE_MS + 1000;
      const result = await injectA2AInboxPrependContext({
        cfg,
        sessionKey,
        runId: "master-run-stale",
        now,
      });

      expect(result).toBeUndefined();
      const store = loadSessionStore(storePath, { skipCache: true });
      const event = store[sessionKey]?.a2aInbox?.events?.[0];
      expect(event?.deliveredAt).toBeUndefined();
      expect(logWarn).toHaveBeenCalledWith(
        "a2a_inbox_error",
        expect.objectContaining({
          runId: "master-run-stale",
          sessionKey,
          sourceSessionKey: "agent:main:subagent:sub-001",
          eventCount: 1,
          stale: true,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips unsupported schema versions without clearing", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          a2aInbox: {
            events: [
              {
                schemaVersion: 999,
                createdAt: 1738737600000,
                runId: "run-unsupported",
                sourceSessionKey: "agent:main:subagent:sub-002",
                sourceDisplayKey: "subagent:sub-002",
                replyText: "Unsupported.",
              },
            ],
          },
        },
      });

      const result = await injectA2AInboxPrependContext({
        cfg,
        sessionKey,
        runId: "master-run-unsupported",
        now: 1738737700000,
      });

      expect(result).toBeUndefined();
      const store = loadSessionStore(storePath, { skipCache: true });
      const event = store[sessionKey]?.a2aInbox?.events?.[0];
      expect(event?.deliveredAt).toBeUndefined();
      expect(logWarn).toHaveBeenCalledWith(
        "a2a_inbox_error",
        expect.objectContaining({
          runId: "master-run-unsupported",
          sessionKey,
          sourceSessionKey: "agent:main:subagent:sub-002",
          eventCount: 1,
          unsupportedVersion: true,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Retention", () => {
  it("prunes delivered events older than retention days in mark mode", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const now = 1738737600000;
    const dayMs = 24 * 60 * 60 * 1000;
    const cfgWithRetention = {
      ...cfg,
      tools: {
        agentToAgent: {
          inboxAckMode: "mark",
          inboxRetentionDays: 7,
        },
      },
    } as OpenClawConfig;
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          a2aInbox: {
            events: [
              {
                schemaVersion: 1,
                createdAt: now - 10 * dayMs,
                runId: "run-old",
                sourceSessionKey: "agent:main:subagent:sub-old",
                sourceDisplayKey: "Old Worker",
                replyText: "Old delivered.",
                deliveredAt: now - 8 * dayMs,
                deliveredRunId: "run-master-old",
              },
              {
                schemaVersion: 1,
                createdAt: now - 2 * dayMs,
                runId: "run-recent",
                sourceSessionKey: "agent:main:subagent:sub-recent",
                sourceDisplayKey: "Recent Worker",
                replyText: "Recent delivered.",
                deliveredAt: now - 1 * dayMs,
                deliveredRunId: "run-master-recent",
              },
              {
                schemaVersion: 1,
                createdAt: now,
                runId: "run-pending",
                sourceSessionKey: "agent:main:subagent:sub-pending",
                sourceDisplayKey: "Pending Worker",
                replyText: "Pending reply.",
              },
            ],
          },
        },
      });

      const injected = await injectA2AInboxPrependContext({
        cfg: cfgWithRetention,
        sessionKey,
        runId: "run-master-retention",
        now,
      });

      expect(injected?.prependContext).toContain(TRANSITIONAL_A2A_INBOX_TAG);

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      const ids = events.map((event) => event.runId);
      expect(ids).toContain("run-recent");
      expect(ids).toContain("run-pending");
      expect(ids).not.toContain("run-old");
      const pending = events.find((event) => event.runId === "run-pending");
      expect(pending?.deliveredAt).toBe(now);
      expect(logInfo).toHaveBeenCalledWith(
        "a2a_inbox_retention_pruned",
        expect.objectContaining({
          runId: "run-master-retention",
          sessionKey,
          eventCount: 1,
          retentionDays: 7,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Schema Validation", () => {
  it("blocks injection when inbox schema is invalid", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          a2aInbox: {
            events: [
              {
                schemaVersion: 1,
                createdAt: "not-a-number",
                runId: "run-bad",
                sourceSessionKey: "agent:main:subagent:sub-001",
                replyText: "Bad.",
              },
            ],
          },
        },
      });

      const result = await injectA2AInboxPrependContext({
        cfg,
        sessionKey,
        runId: "master-run-bad",
        now: 1738737700000,
      });

      expect(result).toBeUndefined();
      const store = loadSessionStore(storePath, { skipCache: true });
      const event = store[sessionKey]?.a2aInbox?.events?.[0] as
        | { deliveredAt?: number }
        | undefined;
      expect(event?.deliveredAt).toBeUndefined();
      expect(logWarn).toHaveBeenCalledWith(
        "a2a_inbox_error",
        expect.objectContaining({
          runId: "master-run-bad",
          sessionKey,
          validationFailed: true,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Scope + Idempotence", () => {
  it("dedupes inbox events by runId", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-dup",
        replyText: "First.",
        now: 1738737600000,
      });
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-dup",
        replyText: "Second.",
        now: 1738737600001,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events.length).toBe(1);
      expect(events[0]?.replyText).toBe("First.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("only injects events scoped to the active session", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const otherKey = "agent:main:other";
    try {
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          a2aInbox: {
            events: [
              {
                schemaVersion: 1,
                createdAt: 1738737600000,
                runId: "run-main",
                sourceSessionKey: "agent:main:subagent:sub-001",
                sourceDisplayKey: "subagent:sub-001",
                replyText: "Main event.",
              },
            ],
          },
        },
        [otherKey]: {
          sessionId: "session-2",
          updatedAt: Date.now(),
          a2aInbox: {
            events: [
              {
                schemaVersion: 1,
                createdAt: 1738737600000,
                runId: "run-other",
                sourceSessionKey: "agent:main:subagent:sub-002",
                sourceDisplayKey: "subagent:sub-002",
                replyText: "Other event.",
              },
            ],
          },
        },
      });

      await injectA2AInboxPrependContext({
        cfg,
        sessionKey,
        runId: "master-run-scope",
        now: 1738737700000,
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      const otherEvent = store[otherKey]?.a2aInbox?.events?.[0];
      expect(otherEvent?.deliveredAt).toBeUndefined();
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

      const result = await injectA2AInboxPrependContext({
        cfg,
        sessionKey,
        runId: "master-run-fail",
        now: 1738737700000,
      });

      expect(result).toBeUndefined();

      const store = loadSessionStore(storePath, { skipCache: true });
      const event = store[sessionKey]?.a2aInbox?.events?.[0];
      expect(event?.deliveredAt).toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        "a2a_inbox_error",
        expect.objectContaining({
          runId: "master-run-fail",
          sessionKey,
        }),
      );
      updateSpy.mockRestore();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Atomic Ack/Clear", () => {
  it("does not mutate inbox when ack update fails", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    const updateSpy = vi.spyOn(sessions, "updateSessionStore");
    try {
      await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "Docs Writer",
        runId: "run-atomic-1",
        replyText: "Atomic delivery",
        now: 1738737600000,
      });

      updateSpy.mockImplementationOnce(async () => {
        throw new Error("simulated update failure");
      });

      const injected = await injectA2AInboxPrependContext({
        cfg,
        sessionKey,
        runId: "run-main-atomic",
        now: 1738737601000,
      });

      expect(injected).toBeUndefined();

      const store = loadSessionStore(storePath, { skipCache: true });
      const events = store[sessionKey]?.a2aInbox?.events ?? [];
      expect(events).toHaveLength(1);
      expect(events[0]?.deliveredAt).toBeUndefined();
    } finally {
      updateSpy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A2A Inbox - Failure Visibility", () => {
  it("logs a2a_inbox_error on write failures", async () => {
    const { dir, cfg, sessionKey, storePath } = await setupSessionStore();
    try {
      const updateSpy = vi
        .spyOn(sessions, "updateSessionStore")
        .mockRejectedValueOnce(new Error("boom"));

      const result = await recordA2AInboxEvent({
        cfg,
        sessionKey,
        sourceSessionKey: "agent:main:subagent:sub-001",
        sourceDisplayKey: "subagent:sub-001",
        runId: "run-error",
        replyText: "Error.",
        now: 1738737600000,
      });

      expect(result.written).toBe(false);
      expect(logError).toHaveBeenCalledWith(
        "a2a_inbox_error",
        expect.objectContaining({
          runId: "run-error",
          sessionKey,
          sourceSessionKey: "agent:main:subagent:sub-001",
        }),
      );

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.a2aInbox).toBeUndefined();
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
