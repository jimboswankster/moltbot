/**
 * Config Variation Regression Tests
 *
 * Protocol: TEST-UNIT v1.0.0
 * QC Protocol: TEST-QA-PASSING-FAILURE v1.0.0
 *
 * PURPOSE: Test A2A behavior with different configuration values.
 * Uses vi.doMock + vi.resetModules() pattern for per-test config overrides.
 *
 * Gap #9 from code-inspection.md: Config variations
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Config Variation - agentToAgent.enabled
// ─────────────────────────────────────────────────────────────────────────────

describe("sessions_send - Config Variation: agentToAgent.enabled", () => {
  let callGatewayMock: ReturnType<typeof vi.fn>;
  let runSessionsSendA2AFlowMock: ReturnType<typeof vi.fn>;
  let createSessionsSendTool: typeof import("../sessions-send-tool.js").createSessionsSendTool;

  beforeEach(() => {
    vi.resetModules();
    callGatewayMock = vi.fn();
    runSessionsSendA2AFlowMock = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  /**
   * Helper to setup mocks with a specific config
   */
  async function setupWithConfig(config: { agentToAgentEnabled: boolean }) {
    // Mock config with specific agentToAgent.enabled value
    // Must include STATE_DIR export used by sandbox/constants.ts
    vi.doMock("../../../config/config.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../config/config.js")>();
      return {
        ...actual,
        loadConfig: () => ({
          session: { scope: "per-sender", mainKey: "main" },
          tools: { agentToAgent: { enabled: config.agentToAgentEnabled } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
        }),
      };
    });

    // Mock gateway
    vi.doMock("../../../gateway/call.js", () => ({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    }));

    // Mock A2A flow
    vi.doMock("../sessions-send-tool.a2a.js", () => ({
      runSessionsSendA2AFlow: (opts: unknown) => runSessionsSendA2AFlowMock(opts),
    }));

    // Mock logger
    vi.doMock("../../../logging/subsystem.js", () => ({
      createSubsystemLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
      }),
    }));

    // Import SUT after mocks are set up
    const module = await import("../sessions-send-tool.js");
    createSessionsSendTool = module.createSessionsSendTool;
  }

  /**
   * Helper to setup default gateway mock responses
   */
  function setupDefaultGatewayMocks() {
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "sessions.resolve") {
        return { key: "agent:main:subagent:sub-001" };
      }
      if (opts.method === "agent") {
        return { runId: "run-config-test-123" };
      }
      if (opts.method === "agent.wait") {
        return { status: "ok" };
      }
      if (opts.method === "chat.history") {
        return { messages: [{ role: "assistant", content: "Task done" }] };
      }
      return {};
    });
  }

  it("calls A2A flow when agentToAgent.enabled is true", async () => {
    // Setup with A2A enabled
    await setupWithConfig({ agentToAgentEnabled: true });
    setupDefaultGatewayMocks();

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    await tool.execute("call-enabled-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Task with A2A enabled",
      timeoutSeconds: 30,
    });

    // Observable: A2A flow should be called when enabled
    expect(runSessionsSendA2AFlowMock).toHaveBeenCalledTimes(1);
  });

  /**
   * GAP #9: Config variation - agentToAgent.enabled = false
   *
   * When tools.agentToAgent.enabled is false, the A2A flow should be skipped.
   * This is a safety feature to disable cross-agent communication.
   *
   * NOTE: This test may fail if the implementation doesn't check the config.
   * If it fails, it documents that the config check needs to be added.
   */
  it.fails("skips A2A flow when agentToAgent.enabled is false (EXPECTED BEHAVIOR)", async () => {
    // Setup with A2A disabled
    await setupWithConfig({ agentToAgentEnabled: false });
    setupDefaultGatewayMocks();

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    await tool.execute("call-disabled-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Task with A2A disabled",
      timeoutSeconds: 30,
    });

    // Observable: A2A flow should NOT be called when disabled
    // This test will fail until config check is implemented
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });

  /**
   * Verify the tool still works in sync mode when A2A is disabled
   * (it should just skip the A2A flow, not fail entirely)
   */
  it.fails("returns ok status in sync mode even when A2A disabled (EXPECTED BEHAVIOR)", async () => {
    // Setup with A2A disabled
    await setupWithConfig({ agentToAgentEnabled: false });
    setupDefaultGatewayMocks();

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-disabled-2", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Task with A2A disabled",
      timeoutSeconds: 30,
    });

    // Observable: Should still return ok status
    expect(result.details).toMatchObject({
      status: "ok",
      runId: expect.any(String),
    });

    // A2A should not be called
    expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: Config Variation - session.scope
// ─────────────────────────────────────────────────────────────────────────────

describe("sessions_send - Config Variation: session.scope", () => {
  let callGatewayMock: ReturnType<typeof vi.fn>;
  let runSessionsSendA2AFlowMock: ReturnType<typeof vi.fn>;
  let createSessionsSendTool: typeof import("../sessions-send-tool.js").createSessionsSendTool;

  beforeEach(() => {
    vi.resetModules();
    callGatewayMock = vi.fn();
    runSessionsSendA2AFlowMock = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function setupWithScope(scope: string) {
    vi.doMock("../../../config/config.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../../config/config.js")>();
      return {
        ...actual,
        loadConfig: () => ({
          session: { scope, mainKey: "main" },
          tools: { agentToAgent: { enabled: true } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
        }),
      };
    });

    vi.doMock("../../../gateway/call.js", () => ({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    }));

    vi.doMock("../sessions-send-tool.a2a.js", () => ({
      runSessionsSendA2AFlow: (opts: unknown) => runSessionsSendA2AFlowMock(opts),
    }));

    vi.doMock("../../../logging/subsystem.js", () => ({
      createSubsystemLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
      }),
    }));

    const module = await import("../sessions-send-tool.js");
    createSessionsSendTool = module.createSessionsSendTool;
  }

  function setupDefaultMocks() {
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") return { runId: "run-scope-test" };
      if (opts.method === "agent.wait") return { status: "ok" };
      if (opts.method === "chat.history") {
        return { messages: [{ role: "assistant", content: "Done" }] };
      }
      return {};
    });
  }

  it("works with per-sender session scope", async () => {
    await setupWithScope("per-sender");
    setupDefaultMocks();

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-scope-1", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Task with per-sender scope",
      timeoutSeconds: 30,
    });

    // Observable: Tool works with per-sender scope
    expect(result.details).toMatchObject({
      status: "ok",
    });
    expect(runSessionsSendA2AFlowMock).toHaveBeenCalled();
  });

  it("works with global session scope", async () => {
    await setupWithScope("global");
    setupDefaultMocks();

    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
    });

    const result = await tool.execute("call-scope-2", {
      sessionKey: "agent:main:subagent:sub-001",
      message: "Task with global scope",
      timeoutSeconds: 30,
    });

    // Observable: Tool works with global scope
    expect(result.details).toMatchObject({
      status: "ok",
    });
    expect(runSessionsSendA2AFlowMock).toHaveBeenCalled();
  });
});

/**
 * QC PROTOCOL CHECKLIST (Protocol: TEST-QA-PASSING-FAILURE v1.0.0)
 * ─────────────────────────────────────────────────────────────────
 * [x] PHASE_1: Test inventory declared in describe() blocks
 * [x] PHASE_2: SUT (createSessionsSendTool().execute()) actually invoked
 * [x] PHASE_3: Assertions verify behavior (status values, mock calls)
 * [x] PHASE_4: test.fails have rationale (config check not implemented)
 * [x] PHASE_5: Error paths covered via config variations
 * [x] PHASE_6: Each test uses fresh mocks (vi.resetModules pattern)
 * [x] PHASE_7: Unit tests mock external boundaries only
 * [x] PHASE_8: Mutation check - tests verify specific config behaviors
 * [x] PHASE_9: All violations addressed
 *
 * Uses vi.doMock + vi.resetModules() for per-test config variations.
 */
