---
system: prismscape_os
client: prismscape_os
package: prismscape.os.execution-chain
category: scaffold-template
branch: skills.execution-chain.bootstrap
description: >-
  Template for the AGENT_RUNTIME_WORKTREE_PROTOCOL.md pointer file
  scaffolded into consumer repos by /0-execution-bootstrap. The
  scaffolded file points at the canonical worktree-systemization-contract
  in prismscape_os (resolved via cross_repo_boundaries.yaml). Template
  uses 2026-10-01T13:05:00Z substitution.
tags: [skills, execution-chain, bootstrap, scaffold-template, worktree-control]
namespace_tier: SYSTEM
kg_role: slice
last_verified: 2026-05-12
---

# Agent Runtime Worktree Protocol

This file is a CONSUMER-REPO POINTER to the canonical protocol in
`prismscape_os`. Seeded by `/0-execution-bootstrap` on 2026-10-01T13:05:00Z.

The canonical protocol — including the major-minor branching contract,
required topology shape, anti-loss reconciliation rules, and worktree
CLI command classes — lives at:

```
<resolved-os-parent>/apps/skills-factory/source/skill-packs/execution-chain/skills/_shared/execution-chain/worktree-systemization-contract.md
```

Resolve `<resolved-os-parent>` via `../../cross_repo_boundaries.yaml`'s
resolution_strategy chain.

## TL;DR for agents in this repo

- one initiative = one branch = one worktree = one tranche = one merge
  lane back to `develop`
- `prismscape_os` is the authority repo for execution-chain state
- canonical `develop` is read-only during active implementation lanes
- worker branches branch from the conductor Major branch head, never
  directly from `develop` once the conductor has unique commits
- worker→conductor merges use `--no-ff`
- conductor→`develop` merges require operator approval + `--no-ff`

## CLI command classes for this repo

```bash
python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py <verb>
```

Verbs:
- `summary` — show lane state
- `validate` — check ledger invariants
- `portfolio` — cross-lane view joined to master-memory files
- `ensure --worktree-id <id>` — provision/heal a lane
- `preflight --worktree-id <id>` — pre-execution check
- `acquire --worktree-id <id> --owner <run-id>` — claim ownership
- `release --worktree-id <id> --owner <run-id> --result <completed|blocked>`
- `reconcile --worktree-id <id>` — classify lane-vs-develop merge state

## When you need OS context

For OS-level architectural decisions, telemetry, or multi-tenant ops,
load:
- `<os-parent>/protocols/BOOT_SEQUENCE.md`
- `<os-parent>/coordination/crm-domain-analysis/CROSS-AGENT-STATE.yaml`
  (if working on CRM substrate)

Both resolved via `cross_repo_boundaries.yaml`.

Don't load these for focused tasks that don't need OS context — they're
heavy.
