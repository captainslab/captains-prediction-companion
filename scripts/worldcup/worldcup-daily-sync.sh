#!/bin/bash
# World Cup daily sync cron wrapper (quiet mode)
# Fetches fixtures + team baselines into state/worldcup/<date>/discovery/.
# Script-owned data sync only. No LLM. No send_message. No trades.
# Routine output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

cd /home/jordan/captains-prediction-companion || exit 1
# America/Chicago operating timezone — keep the synced slate date aligned with
# the dispatcher's Chicago-local match selection.
TODAY=$(TZ=America/Chicago date +%F)
LOG_FILE="logs/worldcup-daily-sync.log"
mkdir -p logs

exec node scripts/worldcup/cron/daily-sync.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
