#!/bin/bash
# MLB daily packet generator cron wrapper
# Generates pre-final-lineup packets and writes to state/packets/

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(date -u +%F)
exec node scripts/packets/generate-mlb-daily.mjs --date "$TODAY"
