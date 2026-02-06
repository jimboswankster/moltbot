# A2A Naming Legacy Usage Index

This index lists code locations that still reference or depend on the prior naming contract (displayName/label/origin.label/sourceDisplayKey/displayKey/task fallbacks). Use it as a remediation target list for the naming‑system upgrade.

Report mirror: `reports/a2a-naming-legacy-usage.md`

## Scope

- A2A inbox event naming and display resolution.
- Subagent label propagation and patching.
- A2A tool input that accepts explicit display keys.
- Legacy tests that assert old naming fallbacks.

## Primary Legacy Contract Touchpoints (Code)

- `src/agents/a2a-inbox.ts` — displayName → label → origin.label → provided → sessionKey fallback chain.
- `src/agents/tools/sessions-send-tool.a2a.ts` — accepts `displayKey` input for A2A sends.
- `src/agents/tools/sessions-send-helpers.ts` — parses announce targets from display keys.
- `src/agents/tools/sessions-announce-target.ts` — resolves announce targets using sessionKey/displayKey.
- `src/agents/tools/sessions-spawn-tool.ts` — enforces `label` required on spawn, persists label into subagent metadata.
- `src/agents/subagent-announce.ts` — uses `label` → `task` fallback for announce copy; patches `label` into session entry post‑announce.
- `src/agents/subagent-registry.ts` — optional `label` in subagent run records.
- `src/auto-reply/reply/subagents-utils.ts` — label fallback to `task` or default.
- `src/gateway/sessions-patch.ts` — label normalization/uniqueness when subagent announce patches `label`.

## Secondary Touchpoints (Behavioral + Tests)

- `src/auto-reply/reply/commands-subagents.ts` — formats subagent status line using label.
- `src/auto-reply/reply/abort.ts` — labels subagent stop summaries (user‑visible copy).
- `src/agents/tools/regression/a2a-inbox.regression.test.ts` — asserts fallback order and disambiguation.
- `src/agents/tools/regression/a2a-flow.regression.test.ts` — displayKey + sourceDisplayKey A2A paths.
- `src/agents/tools/regression/a2a-integration.regression.test.ts` — displayKey A2A integration coverage.
- `src/agents/tools/regression/a2a-chaos.regression.test.ts` — uses legacy display keys in chaos scenarios.
- `src/gateway/server.sessions.gateway-server-sessions-a.e2e.test.ts` — expects `displayName` == `label` for subagent.
- `src/agents/subagent-announce.format.test.ts` — verifies task/label copy in announce formatting.
- `src/agents/openclaw-tools.subagents.sessions-spawn-normalizes-allowlisted-agent-ids.test.ts` — enforces label required.

## Remediation Targets

- Decide whether `displayKey` should remain a supported input for A2A sends or be deprecated.
- Normalize any label assignment that still relies on `task` as a fallback.
- Confirm whether `origin.label` is still valid under the new naming system or should be removed.
- Update tests that pin legacy fallback order once the new naming contract is finalized.
- Revisit announce target resolution if displayKey is removed or renamed.
- Align sessions_spawn label enforcement with the new canonical field.

## Notes

- This list is intentionally narrow and focused on A2A naming paths. It does not include unrelated `label` usage in channels, CLI, or UI components.
- If new naming uses a different canonical field, add an explicit migration step for session store entries that still populate `displayName` only.
