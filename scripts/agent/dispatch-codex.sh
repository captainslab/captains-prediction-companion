#!/usr/bin/env bash
#
# dispatch-codex.sh — dispatch a bounded Codex implementation pass.
#
# Claude is controller/QA; Codex is executor. This wrapper exists so the
# dispatch is repeatable and the flags don't drift between runs.
#
# Usage:
#   scripts/agent/dispatch-codex.sh "<goal text>"
#   scripts/agent/dispatch-codex.sh -f /tmp/codex_goal.txt
#   cat /tmp/codex_goal.txt | scripts/agent/dispatch-codex.sh
#
# The goal text should follow state/goals/TEMPLATE.goal.md (objective,
# branch/HEAD, no-touch, inspect-first, behavior, tests, proof, stop conditions).
#
# Safety: Codex runs in workspace-write sandbox. It must not push, send,
# deploy, or edit cron/Hermes/credentials. Claude reviews the diff and decides
# whether to commit. This script never commits or pushes on its own.

set -euo pipefail

usage() {
  echo "Usage: $0 \"<goal text>\"" >&2
  echo "       $0 -f <goal-file>" >&2
  echo "       <goal text> | $0" >&2
  exit 2
}

goal=""
if [[ "${1:-}" == "-f" ]]; then
  [[ -n "${2:-}" && -f "$2" ]] || { echo "error: goal file not found: ${2:-}" >&2; usage; }
  goal="$(cat "$2")"
elif [[ -n "${1:-}" ]]; then
  goal="$1"
elif [[ ! -t 0 ]]; then
  goal="$(cat)"
fi

[[ -n "${goal//[[:space:]]/}" ]] || { echo "error: empty goal" >&2; usage; }

command -v codex >/dev/null 2>&1 || { echo "error: codex CLI not on PATH" >&2; exit 127; }

exec codex exec \
  --sandbox workspace-write \
  --skip-git-repo-check \
  "$goal"
