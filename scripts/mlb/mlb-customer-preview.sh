#!/bin/bash
# MLB customer-preview cron wrapper (10AM CT)
# Runs the price-free customer-facing MLB preview send for the Chicago calendar date.
# The all-day per-game dispatch uses slate-run-plan.json, which is built separately
# by the unchanged 6AM slate-check.mjs/morning-slate-summary.mjs job. This script
# does not touch that plan.
# Routine output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

set -e

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(TZ=America/Chicago date +%F)
LOG_FILE="logs/mlb-customer-preview.log"
mkdir -p logs

{
  node scripts/mlb/mlb-workspace.mjs morning-scan --date "$TODAY" --live-readonly
  node scripts/packets/generate-mlb-daily.mjs --date "$TODAY"
  node scripts/packets/send-packets-telegram.mjs --type mlb-daily --date "$TODAY"
} >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
