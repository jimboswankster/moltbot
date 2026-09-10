import { describe, expect, it } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type SessionEventHandler = (evt: unknown) => void;

function stubSession() {
  const listeners: SessionEventHandler[] = [];
  const session = {
    subscribe: (listener: SessionEventHandler) => {
      listeners.push(listener);
      return () => {};
    },
  } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];
  const emit = (evt: unknown) => {
    for (const listener of listeners) {
      listener(evt);
    }
  };
  return { session, emit };
}

const settleWithin = (wait: Promise<void>, ms: number) =>
  Promise.race([
    wait.then(
      () => "resolved",
      (err: unknown) => (err as Error).name,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), ms)),
  ]);

describe("subscribeEmbeddedPiSession compaction-retry wait", () => {
  it("rejects with an AbortError when the run is aborted while a retry is pending", async () => {
    const { session, emit } = stubSession();
    const run = new AbortController();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-abort",
      abortSignal: run.signal,
    });
    emit({ type: "auto_compaction_start" });
    emit({ type: "auto_compaction_end", willRetry: true });

    const wait = subscription.waitForCompactionRetry();
    // The run's timeout fires; the aborted retry never reports agent_end.
    run.abort();

    expect(await settleWithin(wait, 1_000)).toBe("AbortError");
  });

  it("still resolves on agent_end when the run is not aborted", async () => {
    const { session, emit } = stubSession();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-no-abort",
      abortSignal: new AbortController().signal,
    });
    emit({ type: "auto_compaction_start" });
    emit({ type: "auto_compaction_end", willRetry: true });

    const wait = subscription.waitForCompactionRetry();
    emit({ type: "agent_end" });

    expect(await settleWithin(wait, 1_000)).toBe("resolved");
  });

  it("does not turn an idle wait into an error after the run is aborted", async () => {
    const { session } = stubSession();
    const run = new AbortController();
    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-idle",
      abortSignal: run.signal,
    });
    run.abort();

    expect(await settleWithin(subscription.waitForCompactionRetry(), 1_000)).toBe("resolved");
  });
});
