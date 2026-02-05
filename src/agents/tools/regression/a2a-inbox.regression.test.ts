/**
 * A2A Inbox Regression Tests
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC Protocol: TEST-QA-PASSING-FAILURE v1.0.0
 */

import { describe, expect, it } from "vitest";
import {
  buildA2AInboxPromptBlock,
  TRANSITIONAL_A2A_INBOX_TAG,
  type A2AInboxEvent,
} from "../../a2a-inbox.js";

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

/**
 * QC PROTOCOL CHECKLIST (Protocol: TEST-QA-PASSING-FAILURE v1.0.0)
 * ─────────────────────────────────────────────────────────────────
 * [x] PHASE_1: Test inventory declared in describe() blocks
 * [x] PHASE_2: SUT invoked (buildA2AInboxPromptBlock)
 * [x] PHASE_3: Assertions verify behavior (tag, content, snapshot)
 * [x] PHASE_4: No test.fails used
 * [x] PHASE_5: Error paths not required for golden-master snapshot
 * [x] PHASE_6: Deterministic inputs (fixed timestamps)
 * [x] PHASE_7: Unit tests mock external boundaries only (none)
 * [x] PHASE_8: Mutation check - snapshot would fail if format changes
 * [x] PHASE_9: All violations addressed
 */
