/**
 * CHARACTERIZATION TESTS — H-1: Memory Flush Model Override (Schema)
 *
 * These tests pin CURRENT (broken) behavior for safe refactoring.
 * They are NOT correctness tests. They WILL be deleted/updated
 * when the corresponding fix lands.
 *
 * Hardening area: H-1
 * Source: src/config/zod-schema.agent-defaults.ts
 * Broken behavior: memoryFlush rejects a `model` key due to strict schema
 * Paired remediation contract: zod-schema.memoryFlush.contract.test.ts
 * Lifecycle: DELETE after fix H-1 commits
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 1: Characterization)
 */

import { describe, it, expect } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema memoryFlush characterization", () => {
  it("rejects model key in memoryFlush (current behavior)", () => {
    // Observable: schema parse success value
    // Broken because: memoryFlush should accept a model override for flush routing
    const result = AgentDefaultsSchema.safeParse({
      compaction: {
        memoryFlush: {
          enabled: true,
          model: "google/gemini-3-flash-preview",
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
