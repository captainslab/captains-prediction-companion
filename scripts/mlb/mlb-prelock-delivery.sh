#!/bin/bash
# MLB pre-lock delivery cron wrapper
# Runs _send-due.mjs from the captains-prediction-companion repo with UTC date.
# Script-owned delivery only. No LLM. No send_message.

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(date -u +%F)
exec node scripts/mlb/_send-due.mjs --date "$TODAY"
