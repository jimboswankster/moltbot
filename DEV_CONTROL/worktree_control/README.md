---
system: prismscape_os
client: prismscape_os
package: prismscape.os.execution-chain
category: scaffold-template
branch: skills.execution-chain.bootstrap
description: >-
  Template for the README.md scaffolded into consumer repos at
  DEV_CONTROL/worktree_control/ by /0-execution-bootstrap. Landing doc
  for the worktree-control surface in a consumer repo. Template uses
  prismscape_openclaw and 2026-10-01T13:05:00Z substitution.
tags: [skills, execution-chain, bootstrap, scaffold-template, worktree-control]
namespace_tier: SYSTEM
kg_role: slice
last_verified: 2026-05-12
---

# DEV_CONTROL/worktree_control

Repo-local worktree control surface. Seeded by `/0-execution-bootstrap`
on 2026-10-01T13:05:00Z.

## What this directory is

The per-repo lane-lifecycle ledger + CLI for governed worktrees. Used
by `/1-execution-spine-hardening`, `/2-execution-surface-operationalize`,
`/3-execution-autonomous-orchestration`, and
`/4-execution-worktree-reconciliation` to manage feature lanes without
disturbing `main`.

## Quick reference

```bash
# Show active lanes:
python3 scripts/worktree_control_cli.py summary

# Validate ledger structure:
python3 scripts/worktree_control_cli.py validate

# Cross-lane portfolio view (joins lanes to master-memory files):
python3 scripts/worktree_control_cli.py portfolio

# Lifecycle:
python3 scripts/worktree_control_cli.py ensure --worktree-id <id>
python3 scripts/worktree_control_cli.py preflight --worktree-id <id>
python3 scripts/worktree_control_cli.py acquire --worktree-id <id> --owner <run-id>
python3 scripts/worktree_control_cli.py release --worktree-id <id> --owner <run-id> --result <completed|blocked>
python3 scripts/worktree_control_cli.py reconcile --worktree-id <id>
```

## Files in this directory

| File | Purpose |
|---|---|
| `worktree-ledger.json` | Machine-readable lane registry (schema v3) |
| `worktree-ledger.md` | Human companion to the JSON |
| `AGENT_RUNTIME_WORKTREE_PROTOCOL.md` | Protocol agents read at session start |
| `scripts/worktree_control_cli.py` | The CLI |
| `README.md` | This file |
| `BOOTSTRAP_REPORT.md` | What `/0` scaffolded (if present) |

## Authority

- This repo (`prismscape_openclaw`) is a CONSUMER of execution-chain state.
- `prismscape_os` is the AUTHORITY repo for execution-chain control
  surfaces.
- See `../../cross_repo_boundaries.yaml` for cross-repo discovery rules.

## Adding a new initiative lane

Lanes are NOT created directly here. They're created by
`/2-execution-surface-operationalize` when a hardened spine provisions
worktrees. The flow:

```
operator/agent has a plan
  → /1-execution-spine-hardening (declares Major/Minor topology at contract level)
  → /2-execution-surface-operationalize (materializes worktree lanes + master memory)
  → /3-execution-autonomous-orchestration (runs the lanes)
  → /4-execution-worktree-reconciliation (reconciles back to develop)
```

`/0` only scaffolds the BASE surface (this directory). Initiative-specific
lanes come later.

## Cross-references

- Agent runtime protocol: `./AGENT_RUNTIME_WORKTREE_PROTOCOL.md`
- Bootstrap report (if `/0` was run): `./BOOTSTRAP_REPORT.md`
- Cross-repo boundaries: `../../cross_repo_boundaries.yaml`
- OS-canonical chain contracts (resolved via cross_repo_boundaries.yaml):
  - `apps/skills-factory/source/skill-packs/execution-chain/skills/_shared/execution-chain/chain-contract.md`
  - `apps/skills-factory/source/skill-packs/execution-chain/skills/_shared/execution-chain/worktree-systemization-contract.md`
  - `apps/skills-factory/source/skill-packs/execution-chain/skills/_shared/execution-chain/orchestration-state-model.md`
