#!/usr/bin/env bash
# Auto-restart wrapper for the phantom scraper.
# Designed for 10+ day unattended runs.
#
# - caffeinate -dimsu: prevents idle sleep, disk sleep, system sleep on any power source
# - Unlimited restarts with escalating cooldown (caps at 60s)
# - Log rotation: keeps last 5 log files (~50 MB each)
# - Timestamped output for post-mortem debugging

set -uo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/node-v22.14.0-darwin-arm64/bin:$PATH"

LOG_DIR="./logs"
MAX_LOG_SIZE=$((50 * 1024 * 1024))  # 50 MB
MAX_LOG_FILES=5
COOLDOWN_SECS=5
MAX_COOLDOWN_SECS=60
CONSECUTIVE_FAST_CRASHES=0
FAST_CRASH_THRESHOLD=10  # seconds — crashes faster than this are "fast"
restarts=0

mkdir -p "$LOG_DIR"

current_log() {
  echo "$LOG_DIR/scraper.log"
}

rotate_logs() {
  local log
  log=$(current_log)
  if [ -f "$log" ] && [ "$(stat -f%z "$log" 2>/dev/null || stat -c%s "$log" 2>/dev/null)" -gt "$MAX_LOG_SIZE" ]; then
    for i in $(seq $((MAX_LOG_FILES - 1)) -1 1); do
      [ -f "$log.$i" ] && mv "$log.$i" "$log.$((i + 1))"
    done
    mv "$log" "$log.1"
    # Remove oldest if over limit
    [ -f "$log.$MAX_LOG_FILES" ] && rm -f "$log.$MAX_LOG_FILES"
    echo "[run.sh] Log rotated at $(date)" >> "$log"
  fi
}

cleanup() {
  echo ""
  echo "[run.sh] Caught signal — shutting down."
  kill "$child_pid" 2>/dev/null || true
  wait "$child_pid" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM SIGHUP

while true; do
  rotate_logs

  {
    echo ""
    echo "═══════════════════════════════════════════════════"
    echo "  Starting scraper (restart #${restarts})"
    echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "  Cooldown: ${COOLDOWN_SECS}s | Consecutive fast crashes: ${CONSECUTIVE_FAST_CRASHES}"
    echo "═══════════════════════════════════════════════════"
  } 2>&1 | tee -a "$(current_log)"

  start_ts=$(date +%s)

  # caffeinate -dimsu: prevent ALL types of sleep on any power source
  caffeinate -dimsu npx tsx --max-old-space-size=4096 src/index.ts "$@" 2>&1 | tee -a "$(current_log)" &
  child_pid=$!
  wait "$child_pid" || true
  exit_code=$?

  end_ts=$(date +%s)
  run_duration=$((end_ts - start_ts))

  if [ "$exit_code" -eq 0 ]; then
    echo "[run.sh] Scraper exited cleanly (code 0). Done." | tee -a "$(current_log)"
    break
  fi

  restarts=$((restarts + 1))

  # Track fast crashes for escalating cooldown
  if [ "$run_duration" -lt "$FAST_CRASH_THRESHOLD" ]; then
    CONSECUTIVE_FAST_CRASHES=$((CONSECUTIVE_FAST_CRASHES + 1))
    # Escalate cooldown: double it each consecutive fast crash, cap at MAX_COOLDOWN_SECS
    if [ "$CONSECUTIVE_FAST_CRASHES" -gt 3 ]; then
      COOLDOWN_SECS=$((COOLDOWN_SECS * 2))
      [ "$COOLDOWN_SECS" -gt "$MAX_COOLDOWN_SECS" ] && COOLDOWN_SECS=$MAX_COOLDOWN_SECS
    fi
  else
    CONSECUTIVE_FAST_CRASHES=0
    COOLDOWN_SECS=5
  fi

  {
    echo ""
    echo "[run.sh] Scraper crashed (exit code $exit_code, ran ${run_duration}s). Restart #${restarts} in ${COOLDOWN_SECS}s..."
    echo "[run.sh] $(date '+%Y-%m-%d %H:%M:%S %Z')"
  } 2>&1 | tee -a "$(current_log)"

  sleep "$COOLDOWN_SECS"
done
