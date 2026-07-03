#!/bin/bash
# World Cup schedule-aware dispatch cron wrapper (quiet mode)
# Runs every 15 minutes; the dispatcher decides from real kickoff times whether
# a pre-lineup board, lineup-window refresh, post-lineup final, or post-match
# grade is due. Idempotent via phase markers — safe to run repeatedly.
# Script-owned scheduler glue only. No LLM. No trades. Delivers eligible,
# gate-cleared packets via the shared Telegram sender (blocked packets never go
# out; delivery is ledger-idempotent).
# Routine "nothing due" output is written to a local log file only.
# Stderr (hard errors) is both logged and surfaced to cron for alerting.

cd /home/jordan/cpc-live || exit 1
# Operating timezone is America/Chicago, not UTC — a late kickoff (e.g. 02:00Z)
# belongs to the prior Chicago date and must dispatch against that slate.
TODAY=$(TZ=America/Chicago date +%F)
LOG_FILE="logs/worldcup-dispatch.log"
mkdir -p logs

# Telegram delivery credentials live in the Hermes captain profile, not in this
# checkout. Load ONLY the three Telegram keys (never other provider secrets)
# into the environment so the dispatcher's send step can authenticate. Secret
# values are never printed; the eval sets variables silently.
CAPTAIN_ENV="/home/jordan/.hermes/profiles/captain/.env"
if [ -f "$CAPTAIN_ENV" ]; then
  set -a
  eval "$(grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_HOME_CHANNEL|TELEGRAM_CHAT_ID)=' "$CAPTAIN_ENV")"
  set +a
fi

# Self-heal: if today's fixture cache is missing (e.g. box was down at sync
# time), run the sync inline so early kickoffs never race the daily sync.
STRUCT="state/worldcup/$TODAY/discovery/static_structure.json"
if [ ! -f "$STRUCT" ]; then
  node scripts/worldcup/cron/daily-sync.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
fi

exec node scripts/worldcup/cron/cron-dispatch.mjs --date "$TODAY" >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
