/**
 * CHARACTERIZATION TESTS — H-4: Cooldown Skip Error Shape
 *
 * These tests pin CURRENT (broken) behavior for safe refactoring.
 * They are NOT correctness tests. They WILL be deleted/updated
 * when the corresponding fix lands.
 *
 * Hardening area: H-4
 * Source: src/agents/model-fallback.ts
 * Broken behavior: cooldown-only skip throws generic "All models failed"
 * Paired remediation contract: model-fallback.cooldown-skip.contract.test.ts
 * Lifecycle: DELETE after fix H-4 commits
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 1: Characterization)
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { runWithModelFallback } from "./model-fallback.js";

function makeCfg(primary: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary,
          fallbacks: [],
        },
      },
    },
  } as OpenClawConfig;
}

describe("runWithModelFallback cooldown-skip characterization", () => {
  it("throws generic 'All models failed' when only candidate is cooldown-skipped", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-only-${crypto.randomUUID()}`;
    const profileId = `${provider}:default`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider,
          key: "test-key",
        },
      },
      usageStats: {
        [profileId]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg(`${provider}/m1`);
    const run = vi.fn();

    try {
      await expect(
        runWithModelFallback({
          cfg,
          provider,
          model: "m1",
          agentDir: tempDir,
          run,
        }),
      ).rejects.toThrow("All models failed");

      expect(run).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
