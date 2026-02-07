/**
 * REMEDIATION CONTRACT TESTS — Streaming Delta Enforcement
 *
 * Ensures cumulative text updates are converted into delta-only streams
 * and duplicated prefixes are dropped.
 */

import { describe, it, expect } from "vitest";
import { resolveStreamingDelta } from "./openresponses-http.js";

describe("resolveStreamingDelta", () => {
  it("derives delta when cumulative text is provided", () => {
    const first = resolveStreamingDelta({ accumulatedText: "", delta: undefined, text: "I" });
    expect(first.deltaText).toBe("I");
    expect(first.nextText).toBe("I");

    const second = resolveStreamingDelta({
      accumulatedText: first.nextText,
      delta: undefined,
      text: "I will",
    });
    expect(second.deltaText).toBe(" will");
    expect(second.nextText).toBe("I will");
  });

  it("drops duplicate prefixes", () => {
    const resolved = resolveStreamingDelta({
      accumulatedText: "I will",
      delta: undefined,
      text: "I",
    });
    expect(resolved.action).toBe("drop");
    expect(resolved.nextText).toBe("I will");
  });

  it("resets when stream desyncs", () => {
    const resolved = resolveStreamingDelta({
      accumulatedText: "Hello",
      delta: undefined,
      text: "World",
    });
    expect(resolved.action).toBe("reset");
    expect(resolved.deltaText).toBe("World");
    expect(resolved.nextText).toBe("World");
  });
});
