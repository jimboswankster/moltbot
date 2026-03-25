import { describe, expect, test } from "vitest";
import { abortChatRunsForConnection } from "./chat-abort.js";

describe("chat abort", () => {
  test("aborts only runs that belong to the disconnected connection", () => {
    const abortedPayloads: Array<{ runId: string; sessionKey: string; state: string }> = [];
    const ops = {
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: new AbortController(),
            sessionId: "run-1",
            sessionKey: "agent:main:main",
            connId: "conn-a",
            startedAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
          },
        ],
        [
          "run-2",
          {
            controller: new AbortController(),
            sessionId: "run-2",
            sessionKey: "agent:main:main",
            connId: "conn-b",
            startedAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunBuffers: new Map<string, string>(),
      chatDeltaSentAt: new Map<string, number>(),
      chatAbortedRuns: new Map<string, number>(),
      removeChatRun: () => undefined,
      agentRunSeq: new Map<string, number>(),
      broadcast: (_event: string, payload: unknown) => {
        const p = payload as { runId: string; sessionKey: string; state: string };
        abortedPayloads.push(p);
      },
      nodeSendToSession: () => {},
    };

    const result = abortChatRunsForConnection(ops, {
      connId: "conn-a",
      stopReason: "disconnect",
    });

    expect(result.aborted).toBe(true);
    expect(result.runIds).toEqual(["run-1"]);
    expect(result.sessionKeys).toEqual(["agent:main:main"]);
    expect(ops.chatAbortControllers.has("run-1")).toBe(false);
    expect(ops.chatAbortControllers.has("run-2")).toBe(true);
    expect(ops.chatAbortedRuns.has("run-1")).toBe(true);
    expect(abortedPayloads).toEqual([
      expect.objectContaining({
        runId: "run-1",
        sessionKey: "agent:main:main",
        state: "aborted",
      }),
    ]);
  });
});
