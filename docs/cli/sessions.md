---
summary: "CLI reference for `openclaw sessions` (list stored sessions + usage)"
read_when:
  - You want to list stored sessions and see recent activity
title: "sessions"
---

# `openclaw sessions`

List stored conversation sessions.

```bash
openclaw sessions
openclaw sessions --active 120
openclaw sessions --json
```

## `sessions migrate-naming`

Backfill missing session `label` fields from `displayName` or `origin.label` to
prepare for A2A naming contract changes.

Defaults to **dry-run**. Use `--apply` to write changes.

```bash
openclaw sessions migrate-naming
openclaw sessions migrate-naming --apply
openclaw sessions migrate-naming --agent work
openclaw sessions migrate-naming --store ./tmp/sessions.json --apply
```
