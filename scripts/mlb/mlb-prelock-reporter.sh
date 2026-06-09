#!/bin/bash
# MLB pre-lock reporter cron wrapper
# Polls for due windows and renders composite reports
# Delivery is handled separately by mlb-prelock-delivery

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(date -u +%F)
exec node scripts/mlb/run-due-windows.mjs --date "$TODAY"
