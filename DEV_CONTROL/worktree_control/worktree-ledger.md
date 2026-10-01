---
system: prismscape_os
client: prismscape_os
package: prismscape.os.execution-chain
category: scaffold-template
branch: skills.execution-chain.bootstrap
description: >-
  Template for the worktree-ledger.md human companion file scaffolded
  into consumer repos by /0-execution-bootstrap. Pairs with the
  machine-readable worktree-ledger.json. Template uses prismscape_openclaw
  and 2026-10-01T13:05:00Z substitution.
tags: [skills, execution-chain, bootstrap, scaffold-template, worktree-control]
namespace_tier: SYSTEM
kg_role: slice
last_verified: 2026-05-12
---

# Worktree Ledger

Human-facing companion to `worktree-ledger.json`.

Use this file for:
- quick operator summary
- short status notes
- retirement decisions
- normalization checkpoints

Machine-readable source of truth:
- `./worktree-ledger.json`

## Bootstrap state

Seeded by `/0-execution-bootstrap` on 2026-10-01T13:05:00Z.

This repo (`prismscape_openclaw`) has its canonical coordination lane and worktree-
control infrastructure scaffolded. Initiative lanes will be created by
`/2-execution-surface-operationalize` when hardened spines provision
worktrees.

## Active Lanes

- `main` (canonical_develop compatibility role) — operator coordination base.
  - master_memory_path: `not_applicable_canonical_lane` (this lane is
    not an initiative; the master-memory primitive doesn't apply).
- `s03-dormant-revision-state-20261001` (feature_lane) — pinned source-only
  Memory Companion host-loader boundary; runtime activation remains forbidden.

## How to extend

When `/2-execution-surface-operationalize` provisions a new initiative
lane, it appends an entry here AND in `worktree-ledger.json` with the
matching `master_memory_path` pointing at the lane's
`orchestrator-master-memory.v1.md`.

See:
- `./AGENT_RUNTIME_WORKTREE_PROTOCOL.md` — the agent-facing protocol
- `./scripts/worktree_control_cli.py` — CLI commands (summary, validate,
  ensure, preflight, acquire, release, reconcile, portfolio)
- `./README.md` — landing doc
