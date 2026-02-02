# Contributing from a Fork: PR and Resync Workflow

Use this workflow when you maintain a local fork and contribute fixes upstream to Moltbot/OpenClaw. Keeps you on npm as the single source of truth while contributing back.

---

## 1. Fix in Fork → PR

1. Make your fix in the fork (`/path/to/Moltbot`)
2. Build and test locally: `pnpm install && pnpm build`
3. Push your branch and open a Pull Request against the upstream repo

---

## 2. How to Know the PR Was Accepted

- On GitHub, the PR page will show **Merged** (green) when the maintainer merges it
- You may get a notification or email if you have GitHub notifications enabled

**Note:** Merge = fix is in upstream source. It does **not** mean the fix is published to npm yet.

---

## 3. How to Know You’re Safe to Resync

The maintainer must **release** a new version and **publish** it to npm. Until then, your fix is only in the upstream repo.

**Check if a new version is published:**

```bash
# Your installed version
npm list -g openclaw

# Latest on npm
npm view openclaw version

# All published versions
npm view openclaw versions
```

**Resync when:** The version on npm is **newer than yours** and includes your fix (check changelog/releases).

```bash
npm update -g openclaw
```

**To confirm your fix is in a release:** Check GitHub Releases or the CHANGELOG for the version that includes your commit.

---

## 4. Summary

| Step       | How you know                                          |
|-----------|--------------------------------------------------------|
| PR merged | GitHub shows "Merged" on the PR                        |
| Fix in npm| A new version (e.g. 2026.2.2) has been published       |
| Safe to sync | `npm view openclaw version` is ≥ the version with your fix |

Until that version is published, either keep using your fork (if you need the fix) or use npm and accept the old behavior.

---

## 5. Single Source of Truth

**Recommendation:** Use npm openclaw as the canonical install. Both your shell and Ollama should run the same binary. Point `~/.local/bin/clawdbot` and `/opt/homebrew/bin/clawdbot` at the npm-installed openclaw—not at the fork—for day-to-day use. Use the fork only for developing and testing changes before submitting PRs.
