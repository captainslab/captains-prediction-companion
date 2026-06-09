#!/bin/bash
# MLB slate check cron wrapper
# Creates state/mlb/<DATE>/slate-run-plan.json

cd /home/jordan/captains-prediction-companion || exit 1
exec node scripts/mlb/slate-check.mjs
