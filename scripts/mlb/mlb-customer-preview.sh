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

scan_output=''
if ! scan_output=$(node scripts/mlb/mlb-workspace.mjs morning-scan --date "$TODAY" --live-readonly 2> >(tee -a "$LOG_FILE" >&2)); then
  printf '%s\n' "$scan_output" >> "$LOG_FILE"
  echo "[mlb-customer-preview] morning-scan failed; aborting customer preview" | tee -a "$LOG_FILE" >&2
  exit 1
fi

printf '%s\n' "$scan_output" >> "$LOG_FILE"

if ! gate_message=$(node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
const jsonStart = lines.findIndex((line) => line.trimStart().startsWith("{"));
if (jsonStart < 0) {
  console.log("morning-scan output did not contain a JSON result");
  process.exit(1);
}
let result;
try {
  result = JSON.parse(lines.slice(jsonStart).join("\n"));
} catch (error) {
  console.log(`could not parse morning-scan JSON: ${error.message}`);
  process.exit(1);
}
const status = result?.discover?.mlb_status;
if (status !== "ok") {
  console.log(`official discovery mlb_status=${status ?? "missing"}`);
  process.exit(1);
}
const kalshiStatus = result?.discover?.kalshi_status;
if (kalshiStatus === "blocked") {
  console.log("Kalshi discovery kalshi_status=blocked");
  process.exit(1);
}
console.log("ok");
' <<< "$scan_output"); then
  echo "[mlb-customer-preview] discovery gate failed for date=$TODAY: $gate_message; aborting steps 2-3" | tee -a "$LOG_FILE" >&2
  exit 1
fi

{
  node scripts/packets/generate-mlb-daily.mjs --date "$TODAY"
  node scripts/packets/send-packets-telegram.mjs --type mlb-daily --date "$TODAY"
} >> "$LOG_FILE" 2> >(tee -a "$LOG_FILE" >&2)
