#!/bin/bash
# MLB articles daily cron wrapper
# Generates article-style packets and delivers via Telegram
# Note: publish-article-reports.mjs handles its own Telegram sending

cd /home/jordan/captains-prediction-companion || exit 1
TODAY=$(TZ=America/Chicago date +%F)
exec node scripts/mlb/publish-article-reports.mjs --date "$TODAY" --send-telegram
