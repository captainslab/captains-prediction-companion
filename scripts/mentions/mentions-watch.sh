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

# One event per run: a full generate+synthesize+send cycle (~3-7 min) must
# finish inside the cron runner's 600s script timeout; the queue drains at
# one event per 5-min tick. Override stays possible via the environment.
export MENTIONS_WATCH_MAX_NEW_PER_RUN="${MENTIONS_WATCH_MAX_NEW_PER_RUN:-1}"

exec node scripts/mentions/mentions-watch.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
