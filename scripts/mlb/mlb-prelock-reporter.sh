#!/bin/bash
# MLB pre-lock reporter cron wrapper (quiet mode)
# Polls for due windows and renders composite reports.
# Delivery is handled separately by mlb-prelock-delivery.
# Routine "no due windows" output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(date -u +%F)
LOG_FILE="logs/mlb-prelock-reporter.log"
mkdir -p logs

exec node scripts/mlb/run-due-windows.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
