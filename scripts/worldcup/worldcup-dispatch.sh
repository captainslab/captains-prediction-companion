#!/bin/bash
# World Cup schedule-aware dispatch cron wrapper (quiet mode)
# Runs every 15 minutes; the dispatcher decides from real kickoff times whether
# a pre-lineup board, lineup-window refresh, post-lineup final, or post-match
# grade is due. Idempotent via phase markers — safe to run repeatedly.
# Script-owned scheduler glue only. No LLM. No send_message. No trades.
# Routine "nothing due" output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

cd /home/jordan/captains-prediction-companion || exit 1
# Operating timezone is America/Chicago, not UTC — a late kickoff (e.g. 02:00Z)
# belongs to the prior Chicago date and must dispatch against that slate.
TODAY=$(TZ=America/Chicago date +%F)
LOG_FILE="logs/worldcup-dispatch.log"
mkdir -p logs

# Self-heal: if today's fixture cache is missing (e.g. box was down at sync
# time), run the sync inline so early kickoffs never race the daily sync.
STRUCT="state/worldcup/$TODAY/discovery/static_structure.json"
if [ ! -f "$STRUCT" ]; then
  node scripts/worldcup/cron/daily-sync.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
fi

exec node scripts/worldcup/cron/cron-dispatch.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
