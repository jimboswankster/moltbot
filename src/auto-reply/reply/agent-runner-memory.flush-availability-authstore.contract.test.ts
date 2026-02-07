/**
 * REMEDIATION CONTRACT TESTS — H-AVAIL: Auth Store Availability Gate
 *
 * Ensures flush is skipped when all auth profiles for the flush provider are in cooldown.
 *
 * Protocol: TEST-CHARACTERIZATION v1.0.0 (Phase 2: Remediation Contract)
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles.js";
import { AUTH_STORE_VERSION } from "../../agents/auth-profiles/constants.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";

const runWithModelFallbackMock = vi.fn();

vi.mock("../../agents/model-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-fallback.js")>();
  return {
    ...actual,
    runWithModelFallback: async (params: any) => runWithModelFallbackMock(params),
  };
});

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

function createParams(provider: string, agentDir: string) {
  const cfg = {
    agents: {
      defaults: {
        model: {
          primary: `${provider}/m1`,
          fallbacks: [],
        },
        compaction: {
          memoryFlush: {
            enabled: true,
            softThresholdTokens: 4_000,
            prompt: "Write notes.",
            systemPrompt: "Flush memory now.",
            model: `${provider}/m1`,
          },
          reserveTokensFloor: 20_000,
        },
      },
    },
  };

  const followupRun = {
    prompt: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir,
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: cfg,
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude-opus-4-5",
      thinkLevel: "low",
      verboseLevel: "off",
      reasoningLevel: "off",
      execOverrides: {},
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      extraSystemPrompt: "",
      ownerNumbers: [],
      authProfileId: "profile-1",
      authProfileIdSource: "agent-defaults",
    },
  } as unknown as FollowupRun;

  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+15550001111",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;

  return { cfg, followupRun, sessionCtx };
}

describe("memory flush availability gate via auth store remediation contract", () => {
  it("skips flush when all auth profiles are cooling down", async () => {
    runWithModelFallbackMock.mockReset();

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

    const { cfg, followupRun, sessionCtx } = createParams(provider, tempDir);

    try {
      await runMemoryFlushIfNeeded({
        cfg,
        followupRun,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        agentCfgContextTokens: 144_000,
        resolvedVerboseLevel: "off",
        sessionEntry: { totalTokens: 130_000, compactionCount: 1 },
        isHeartbeat: false,
      });

      expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
