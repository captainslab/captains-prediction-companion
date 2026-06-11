#!/bin/bash
# Mentions rolling watcher cron wrapper (quiet mode, script-only — no LLM agent)
# Scans for newly listed today-dated mention events; generates + sends packets
# only for events not yet in the seen ledger. Silent when nothing is new.
# Routine output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(TZ=UTC date +%F)
LOG_FILE="logs/mentions-watch.log"
mkdir -p logs

exec node scripts/mentions/mentions-watch.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
