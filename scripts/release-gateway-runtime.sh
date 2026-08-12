#!/usr/bin/env bash
# Release the A2A Control gateway into its dedicated runtime checkout.
#
# WHY THIS EXISTS
# ---------------
# The gateway used to run from `dist/` inside the WORKING clone. Editing,
# building and serving all happened in one directory, so a commit reached the
# fleet control plane in under a minute with no review, no gate and no rollback
# point. Worse, "what is production running?" had no answer independent of
# whatever someone had last built in their working tree.
#
# Production now runs from ~/.openclaw/runtime/a2a-gateway, advanced ONLY by
# this script. The working clone is free to be dirty, mid-refactor, or on any
# branch without touching the live service.
#
# WHY THIS IS NOT A TIMER
# -----------------------
# The assessment worker self-updates every 10 minutes because it is a stateless
# job that runs and exits. This is an always-on control plane: updating means
# RESTARTING, and restarting drops in-flight agent sessions. Deciding when to
# take that hit is a human judgement, so this is run deliberately, never on a
# schedule.
#
# DISCIPLINE
#   * fast-forward only; refuses a dirty or diverged runtime
#   * builds BOTH bundles (see the ui:build note below) and proves the bundle
#     loads BEFORE touching the running service
#   * checks for active connections and refuses to restart a busy gateway
#     unless --force is given
#   * logs every release so provenance is answerable from the log alone
#
# THE ui:build TRAP
#   `pnpm build` does NOT build the Control UI. A runtime built with `pnpm
#   build` alone starts healthy, serves its API, and returns 503 "Control UI
#   assets not found" on every page. The old working clone hid this because it
#   had accumulated UI assets from earlier `ui:build` runs. Both are required.
#
# Usage:  bash scripts/release-gateway-runtime.sh [--force] [--dry-run]

set -euo pipefail

RUNTIME="${GATEWAY_RUNTIME:-$HOME/.openclaw/runtime/a2a-gateway}"
BRANCH="${GATEWAY_BRANCH:-develop}"
LABEL="${GATEWAY_LAUNCHD_LABEL:-ai.openclaw.gateway}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PORT="${GATEWAY_PORT:-44892}"
LOG_DIR="${GATEWAY_LOG_DIR:-$HOME/.openclaw/runtime/logs}"
LOG="$LOG_DIR/gateway-release.log"

FORCE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

git -C "$RUNTIME" rev-parse --git-dir >/dev/null 2>&1 || {
  log "FAIL runtime checkout is not a git repo: $RUNTIME"; exit 1; }

if [ -n "$(git -C "$RUNTIME" status --porcelain)" ]; then
  log "ABORT runtime tree is dirty — refusing to release over local state"; exit 1
fi

before="$(git -C "$RUNTIME" rev-parse HEAD)"
git -C "$RUNTIME" fetch --quiet origin "$BRANCH"
target="$(git -C "$RUNTIME" rev-parse "origin/${BRANCH}")"

if ! git -C "$RUNTIME" merge-base --is-ancestor "$before" "$target"; then
  log "ABORT ${before:0:12} is not an ancestor of origin/${BRANCH} — diverged; human decision"; exit 1
fi
if [ "$before" = "$target" ]; then
  log "OK runtime already at ${before:0:12}; nothing to release"; exit 0
fi

log "RELEASE ${before:0:12} -> ${target:0:12} (branch ${BRANCH})"
[ "$DRY" = "1" ] && { log "DRY-RUN stop before mutating"; exit 0; }

git -C "$RUNTIME" checkout --quiet --detach "$target"

# Build BOTH. See "THE ui:build TRAP" above — omitting ui:build yields a
# gateway that looks healthy in its logs and 503s on every page.
( cd "$RUNTIME" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null && pnpm ui:build >/dev/null )

[ -f "$RUNTIME/dist/control-ui/index.html" ] || {
  log "ABORT Control UI assets missing after build — NOT restarting"; exit 1; }
node "$RUNTIME/dist/entry.js" --version >/dev/null || {
  log "ABORT built bundle does not load — NOT restarting"; exit 1; }
log "BUILD ok (bundle loads, Control UI assets present)"

# Never drop live agent sessions by surprise.
active="$(lsof -nP -iTCP:"$PORT" 2>/dev/null | grep -c ESTABLISHED || true)"
if [ "${active:-0}" -gt 0 ] && [ "$FORCE" != "1" ]; then
  log "HOLD $active active connection(s) on :$PORT — build is staged; re-run with --force to restart"
  exit 0
fi

launchctl unload "$PLIST" 2>/dev/null || true
sleep 2
launchctl load "$PLIST"

for _ in 1 2 3 4 5 6; do
  sleep 5
  code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
  [ "$code" = "200" ] && { log "LIVE ${target:0:12} healthy (HTTP 200)"; exit 0; }
done

log "UNHEALTHY gateway did not return 200 after restart (last=${code:-none})."
log "  rollback: git -C $RUNTIME checkout --detach ${before:0:12} && cd $RUNTIME && pnpm build && pnpm ui:build && launchctl unload '$PLIST' && launchctl load '$PLIST'"
exit 1
