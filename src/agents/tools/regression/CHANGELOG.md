# Regression Harness Changelog

This changelog tracks incremental, audited updates to the A2A regression harness
and related integration tests. Each entry includes the commit hash and tests run.

## 2026-02-05
- Initialize changelog (commit: 9a2c9bf7e)
  Tests: none
- Skip A2A flow in async sessions_send (commit: 36bcb53d4)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Add A2A inbox golden-master prompt snapshot (commit: 423112de4)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate A inbox snapshot (commit: cf5d9d658)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Add A2A inbox audit logging coverage (commit: 3d37bb2bf)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate B inbox audit (commit: 46113a259)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Add A2A inbox bounds coverage (commit: c896930fd)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate C inbox bounds (commit: 7b226f5be)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Enforce A2A inbox allowlist gating (commit: aa03a2245)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate D allowlist (commit: 1d8798e37)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Add fail-closed inbox clear coverage (commit: 23d760e24)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate E fail-closed (commit: 7f3e51478)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Skip stale/unsupported inbox events (commit: c0ff94b92)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate F versioning (commit: 5d4530c47)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Validate A2A inbox schema before injection (commit: 0145f8873)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate G validation (commit: c40600622)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Add inbox scope/idempotence coverage (commit: 9ab2c5157)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate H scope/idempotence (commit: 399ca390d)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log A2A inbox errors (commit: af51bcbcf)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log Gate I errors (commit: 7825b858a)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Route A2A completions into inbox + hook injection (commit: 901836281)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Log inbox hook integration (commit: 6450ec7a8)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`

## 2026-02-06
- Fix webchat streaming across provider retries by deferring chat finalization until dispatch completes (commit: f71ec0de2)
  Tests: none
  Notes: Agent lifecycle `end` could fire before fallback retries finished, clearing chat run linkage and dropping streaming in Control UI. Now gateway keeps chat run active until the chat dispatch completes, emits final once, and cleans up run context at the end. Verbose logging added to correlate run/session mapping during investigation.
- Record A2A input-source metadata on agent steps (commit: ffc576f4f)
  Tests: `npx vitest run src/agents/tools/regression/agent-step.regression.test.ts`
- Log inputSource metadata when recorded in embedded run (commit: 956c74ef4)
  Tests: none
- Add A2A delivery-mode inbox flow coverage (commit: b67a963f8)
  Tests: `npx vitest run src/agents/tools/regression/a2a-integration.regression.test.ts`
- Add A2A inbox delivery-mode snapshot (commit: b072cc314)
  Tests: `npx vitest run src/agents/tools/regression/a2a-integration.regression.test.ts`
- Add A2A chaos coverage (write storm, restart recovery, session isolation) (commit: 344c30a96)
  Tests: `npx vitest run src/agents/tools/regression/a2a-chaos.regression.test.ts`
- Enforce A2A naming contract (displayName + label fallbacks, disambiguation, snapshot) (commit: 41e59b466)
  Tests: `npx vitest run src/agents/tools/regression/a2a-inbox.regression.test.ts`
- Add sessions_spawn → inbox naming propagation coverage (commit: pending)
  Tests: `npx vitest run src/agents/tools/regression/a2a-inbox.regression.test.ts`
