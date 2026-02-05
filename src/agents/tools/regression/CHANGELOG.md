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
- Add A2A inbox audit logging coverage (commit: 3d37bb2bf)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Add A2A inbox bounds coverage (commit: c896930fd)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
- Enforce A2A inbox allowlist gating (commit: aa03a2245)
  Tests: `npx vitest run src/agents/tools/regression/ src/gateway/server-methods/send-a2a-announce.integration.test.ts`
