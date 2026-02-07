/**
 * REMEDIATION CONTRACT TESTS — H-1: Memory Flush Model Override (Schema)
 *
 * These tests define CORRECT behavior. They are RED until fix H-1 lands.
 * After the fix, they become permanent regression tests.
 *
 * Hardening area: H-1
 * Source: src/config/zod-schema.agent-defaults.ts
 * Correct behavior: memoryFlush accepts an optional `model` override
 * Paired characterization: deleted after fix H-1
 * Status: RED -> GREEN when fix H-1 lands
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 2: Remediation Contract)
 */

import { describe, it, expect } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema memoryFlush remediation contract", () => {
  it("accepts model key in memoryFlush (expected RED until fix)", () => {
    // Observable: schema parse success value
    // Correct because: memory flush must support a dedicated model override
    const result = AgentDefaultsSchema.safeParse({
      compaction: {
        memoryFlush: {
          enabled: true,
          model: "google/gemini-3-flash-preview",
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
