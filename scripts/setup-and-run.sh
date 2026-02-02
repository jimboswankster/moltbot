#!/usr/bin/env bash
# One-time setup: install deps, build, then run onboard.
# Run from repo root: ./scripts/setup-and-run.sh
set -e
cd "$(dirname "$0")/.."

echo "==> Ensuring pnpm..."
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm
fi

echo "==> Installing dependencies..."
pnpm install

echo "==> Building UI..."
pnpm ui:build

echo "==> Building TypeScript..."
pnpm build

echo "==> Running onboard (install daemon)..."
pnpm moltbot onboard --install-daemon

echo ""
echo "Done. Gateway should be running. Open http://127.0.0.1:18789 for Control UI / WebChat."
echo "To start gateway manually later: pnpm moltbot gateway --port 18789 --verbose"
