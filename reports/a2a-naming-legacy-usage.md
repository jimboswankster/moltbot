# A2A Naming Legacy Usage Report

This is the reporting copy of the index for legacy naming contract usage.

Index: `docs/a2a-naming-legacy-usage.md`

## Summary

- The legacy naming contract is concentrated in A2A inbox display resolution, subagent label propagation, and tests that hard‑code fallback order.
- Remediation should focus on converging on one canonical naming field and deprecating `displayKey` input paths.

## Files (Target List)

- `src/agents/a2a-inbox.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-send-helpers.ts`
- `src/agents/tools/sessions-announce-target.ts`
- `src/agents/tools/sessions-spawn-tool.ts`
- `src/agents/subagent-announce.ts`
- `src/agents/subagent-registry.ts`
- `src/auto-reply/reply/subagents-utils.ts`
- `src/gateway/sessions-patch.ts`
- `src/auto-reply/reply/commands-subagents.ts`
- `src/auto-reply/reply/abort.ts`
- `src/agents/tools/regression/a2a-inbox.regression.test.ts`
- `src/agents/tools/regression/a2a-flow.regression.test.ts`
- `src/agents/tools/regression/a2a-integration.regression.test.ts`
- `src/agents/tools/regression/a2a-chaos.regression.test.ts`
- `src/gateway/server.sessions.gateway-server-sessions-a.e2e.test.ts`
- `src/agents/subagent-announce.format.test.ts`
- `src/agents/openclaw-tools.subagents.sessions-spawn-normalizes-allowlisted-agent-ids.test.ts`

## Remediation Checklist

- Define the canonical naming field for A2A inbox display.
- Remove or gate `displayKey` once the new contract is stable.
- Decide whether `origin.label` remains part of the contract.
- Align subagent label fallback logic with the new contract.
- Update regression and e2e tests to match the new contract.
- Revisit announce-target resolution if displayKey is removed.
- Keep sessions_spawn label enforcement aligned to the canonical field.
