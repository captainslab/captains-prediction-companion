#!/bin/bash
# Mentions daily cron wrapper (quiet mode, script-only — no LLM agent)
# 1. Generates the daily mentions packets (deterministic generator).
# 2. Delivers them to Telegram via the idempotent sender.
# Routine output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(TZ=UTC date +%F)
LOG_FILE="logs/mentions-daily.log"
mkdir -p logs

{
  echo "[$(date -u +%FT%TZ)] mentions-daily run start date=$TODAY"
  node scripts/packets/generate-mentions-daily.mjs --date "$TODAY" || exit 1
  node scripts/packets/send-packets-telegram.mjs --type mentions-daily --date "$TODAY" || exit 1
  echo "[$(date -u +%FT%TZ)] mentions-daily run done"
} >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
