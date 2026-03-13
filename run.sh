#!/usr/bin/env bash
# Auto-restart wrapper for the phantom scraper.
# Uses caffeinate to prevent macOS from sleeping while the scraper runs.
# Automatically restarts on crash with a short cooldown.

set -euo pipefail
cd "$(dirname "$0")"

MAX_RESTARTS=50
COOLDOWN_SECS=5
restarts=0

cleanup() {
  echo ""
  echo "[run.sh] Caught signal — shutting down."
  kill "$child_pid" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

while true; do
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Starting scraper (restart #${restarts})…"
  echo "  $(date)"
  echo "═══════════════════════════════════════════════════"

  # caffeinate -s keeps the system awake while the child process runs
  # --max-old-space-size=4096 gives Node 4 GB of heap
  caffeinate -s npx tsx --max-old-space-size=4096 src/index.ts "$@" &
  child_pid=$!
  wait "$child_pid" || true
  exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    echo "[run.sh] Scraper exited cleanly (code 0). Done."
    break
  fi

  restarts=$((restarts + 1))
  echo ""
  echo "[run.sh] ⚠  Scraper crashed (exit code $exit_code). Restart #${restarts} in ${COOLDOWN_SECS}s…"

  if [ "$restarts" -ge "$MAX_RESTARTS" ]; then
    echo "[run.sh] ✗  Max restarts ($MAX_RESTARTS) reached. Giving up."
    exit 1
  fi

  sleep "$COOLDOWN_SECS"
done
