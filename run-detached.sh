#!/usr/bin/env bash
# Launch the scraper detached from the terminal so it survives:
# - Terminal close / SSH disconnect
# - macOS sleep (via caffeinate in run.sh)
#
# Logs go to ./logs/scraper.log (rotated by run.sh)
# Dashboard stays available at http://localhost:3847
#
# Usage:
#   bash run-detached.sh [scraper options]
#   bash run-detached.sh --workers 8
#
# To stop:
#   kill $(cat ./scraper.pid)
#
# To watch logs:
#   tail -f ./logs/scraper.log

set -uo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/node-v22.14.0-darwin-arm64/bin:$PATH"

if [ -f ./scraper.pid ]; then
  existing_pid=$(cat ./scraper.pid)
  if kill -0 "$existing_pid" 2>/dev/null; then
    echo "Scraper is already running (PID $existing_pid)."
    echo "Stop it first:  kill $existing_pid"
    exit 1
  fi
fi

mkdir -p logs

echo "Starting scraper in background..."
nohup bash run.sh "$@" > /dev/null 2>&1 &
pid=$!
echo "$pid" > ./scraper.pid
disown "$pid"

echo "Scraper started (PID $pid)"
echo "Dashboard: http://localhost:3847"
echo ""
echo "Logs:      tail -f ./logs/scraper.log"
echo "Stop:      kill \$(cat ./scraper.pid)"
echo ""
echo "This terminal can now be closed safely."
