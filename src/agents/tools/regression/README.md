# A2A Regression Test Suite

**Location:** `src/agents/tools/regression/`
**Protocol Compliance:** TEST-UNIT v1.0.0 + TEST-QA-PASSING-FAILURE v1.0.0

This folder contains regression tests for the Agent-to-Agent (A2A) communication flow.

## Background

These tests were created based on the analysis in:
- `workspace/docs/development/debug/a2a-bug/code-inspection.md`

## Test Files

| File | Protocol | Tests | Purpose |
|------|----------|-------|---------|
| `a2a-flow.regression.test.ts` | unit | 33 | Core A2A flow: ping-pong, announce, skip tokens, rate limiting, role/source |
| `sessions-send-async.regression.test.ts` | unit | 12 | sessions_send tool: async vs sync modes, cross-agent detection |
| `config-variation.regression.test.ts` | unit | 5 | Config variations: agentToAgent.enabled, session.scope |
| `a2a-integration.regression.test.ts` | integration | 7 | Tool restriction, concurrency safeguards |
| `../../../gateway/server-methods/send-a2a-announce.integration.test.ts` | integration | 5 | Gateway mirror + A2A announce interaction |

## QC Protocol Compliance

All tests in this folder adhere to the TEST-QA-PASSING-FAILURE v1.0.0 protocol:

### Phase Checklist

| Phase | Status | Notes |
|-------|--------|-------|
| PHASE_1_TEST_INVENTORY | ✅ | Tests declared in describe() blocks |
| PHASE_2_EXECUTION_REALITY | ✅ | Real SUT invoked (mocks on boundaries only) |
| PHASE_3_ASSERTION_QUALITY | ✅ | Behavioral assertions (no `expect(true)`) |
| PHASE_4_SKIP_AND_CONDITIONALS | ✅ | `test.fails` has documented rationale |
| PHASE_5_ERROR_PATH_INTEGRITY | ✅ | Network errors, timeouts, agent failures tested |
| PHASE_6_ENVIRONMENT_INDEPENDENCE | ✅ | Fresh mocks per test (beforeEach/afterEach) |
| PHASE_7_PROTOCOL_COMPLIANCE | ✅ | Unit tests mock external boundaries only |
| PHASE_8_MUTATION_THOUGHT_EXPERIMENT | ✅ | Tests fail if SUT returns wrong values |
| PHASE_9_REMEDIATION_OR_BLOCK | ✅ | All violations addressed |

### Observable Sources

Each test documents its observable source:
- Return values from pure functions
- Mock call counts and arguments
- Tool execution result status fields

### Mocking Strategy

- **Mocked (external boundaries):** `callGateway`, `createSubsystemLogger`, `loadConfig`
- **Real (SUT):** `runSessionsSendA2AFlow`, `isReplySkip`, `isAnnounceSkip`, `createSessionsSendTool`

## Test Matrix

### A2A Flow Tests (`a2a-flow.regression.test.ts`)

| Test Case | Observable | Validates |
|-----------|------------|-----------|
| `isReplySkip returns true for exact token` | Return value | Skip token detection |
| `executes ping-pong loop when all conditions met` | Call count, args | Ping-pong mechanism |
| `exits ping-pong early on REPLY_SKIP` | Call count | Early exit behavior |
| `delivers announcement via callGateway send` | Call args | Announce delivery |
| `does not call send on ANNOUNCE_SKIP` | Call absence | Skip token handling |
| `does not throw when delivery fails` | No exception | Error resilience |
| `completes all ping-pong turns then announces` | Call count (6) | Gap #4: Max turns exhaustion |
| `alternates between requester and target sessions` | Session keys | Gap #4: Loop alternation |
| `respects ANNOUNCE_SKIP with leading whitespace` | Send not called | Gap #5: Token normalization |
| `respects ANNOUNCE_SKIP with trailing whitespace` | Send not called | Gap #5: Token normalization |
| `calls readLatestAssistantReply when roundOneReply absent` | Mock call | Gap #6: History retrieval |
| `uses retrieved history reply as latestReply` | Announce context | Gap #6: History retrieval |

### Sessions Send Tests (`sessions-send-async.regression.test.ts`)

| Test Case | Observable | Validates |
|-----------|------------|-----------|
| `returns accepted status in async mode` | Status field | Async return value |
| `calls A2A flow in async mode (BUG)` | Call count | Documents current bug |
| `returns ok status with reply in sync mode` | Status, reply | Sync return value |
| `returns timeout status on timeout` | Status field | Timeout handling |
| `returns error status on error` | Status, error | Error handling |
| `passes sub-agent reply to A2A flow` | Call args | Gap #2: Role tracking |
| `documents expected message attribution interface` | Interface doc | Gap #2: Future fix interface |
| `documents mirror feature risk in announce path` | Risk doc | Gap #1: Gateway mirror |

## Boundary Gap Coverage

The following gaps were identified as refactor risks and addressed with additional tests:

| Gap | Status | Test Location | Notes |
|-----|--------|---------------|-------|
| #1 Gateway mirror behavior | ✅ Covered | `send-a2a-announce.integration` | 5 integration tests for mirror path |
| #2 Role/source distinction | 🧪 test.fails | `a2a-flow` | Interface contract documented, awaiting fix |
| #3 Async skip enforcement | 🧪 test.fails | `sessions-send-async` | Awaiting fix implementation |
| #4 Max-turns exhaustion | ✅ Covered | `a2a-flow` | Full loop completion tested |
| #5 Announce skip normalization | ✅ Covered | `a2a-flow` | Whitespace handling tested |
| #6 History reply retrieval | ✅ Covered | `a2a-flow` | readLatestAssistantReply verified |
| #7 Tool restriction enforcement | ✅ Covered | `a2a-integration` | Prompt + context checks (advisory) |
| #8 Concurrency / race safeguard | ✅ Covered | `a2a-integration` | 2 tests (latestReply isolation, slow gateway) |
| #9 Config variations | ✅ Covered | `config-variation` | 5 tests with vi.doMock pattern |

## Documented Bugs

### 1. Async Mode A2A Triggering

**Location:** `sessions-send-tool.ts` line ~316

**Issue:** When `timeoutSeconds === 0`, `startA2AFlow()` is still called.

**Test:** `calls A2A flow in async mode (CURRENT BUG)`
- Current assertion: `expect(runSessionsSendA2AFlowMock).toHaveBeenCalledTimes(1)`
- Post-fix assertion: `expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled()`

**Expected fix test:** `test.fails` with rationale documenting expected behavior.

### 2. Message Role Injection

**Location:** `agent-step.ts` lines 29-41

**Issue:** `runAgentStep` injects sub's reply as `role=user` message.

**Test:** `passes sub reply as message parameter to runAgentStep in ping-pong`
- Documents the injection mechanism
- Verifies message parameter matches sub's reply

## Code Files Under Test

```
src/agents/tools/
├── sessions-send-tool.ts        # Main tool entry point (SUT)
├── sessions-send-tool.a2a.ts    # A2A flow orchestration (SUT)
├── sessions-send-helpers.ts     # Context builders, skip tokens (SUT)
└── agent-step.ts                # runAgentStep (mocked boundary)

src/gateway/
└── call.ts                      # callGateway (mocked boundary)
```

## Running Tests

```bash
# Run all regression tests
npx vitest run src/agents/tools/regression/

# Run specific test file
npx vitest run src/agents/tools/regression/a2a-flow.regression.test.ts

# Run with verbose output
npx vitest run src/agents/tools/regression/ --reporter=verbose
```

## Updating Tests After Fixes

### When Async A2A Bug is Fixed

1. In `sessions-send-async.regression.test.ts`:
   - Change `expect(runSessionsSendA2AFlowMock).toHaveBeenCalledTimes(1)` to `expect(runSessionsSendA2AFlowMock).not.toHaveBeenCalled()`
   - Remove the `test.fails` variant or convert to passing test

### When Message Role Injection is Fixed

1. In `a2a-flow.regression.test.ts`:
   - Update `passes sub reply as message parameter` test
   - Add assertions for new metadata/source fields

## Related Documentation

- `workspace/docs/development/debug/a2a-bug/code-inspection.md` - Full analysis
- `workspace/os/agent_toolkit_source/tools/test_protocols/unit/protocol.md` - Unit test protocol
- `workspace/os/agent_toolkit_source/tools/test_protocols/qc/README.md` - QC protocol
