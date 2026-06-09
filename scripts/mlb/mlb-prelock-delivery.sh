#!/bin/bash
# MLB pre-lock delivery cron wrapper (quiet mode)
# Runs _send-due.mjs from the captains-prediction-companion repo with UTC date.
# Script-owned delivery only. No LLM. No send_message.
# Routine "no artifacts" output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(date -u +%F)
LOG_FILE="logs/mlb-prelock-delivery.log"
mkdir -p logs

exec node scripts/mlb/_send-due.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
