#!/usr/bin/env bash
# hermes-bridge.sh — cmdAdapter bridge for politics swarm execute mode.
#
# Contract (from scripts/politics/lib/branch-runner.mjs cmdAdapter):
#   stdin  : the prompt envelope text (verbatim)
#   stdout : exactly ONE JSON object matching the branch contract
#   stderr : logs only (never JSON)
#   exit 0 : success; nonzero => cmdAdapter records status: 'failed'
#
# Env (set by cmdAdapter):
#   POLITICS_BRANCH       — one of: official | xSignal | plausibility | skeptic | judgment
#   POLITICS_MODEL        — 'inherit' or 'grok' (after fallback resolution upstream)
#   POLITICS_INPUTS_ONLY  — '1' for the judgment branch, '0' otherwise
#
# Env (set by operator):
#   POLITICS_BRIDGE_MODE  — 'dry-run' (default; deterministic stub JSON, no network)
#                         | 'inherit' (route to local Hermes delegate_task)
#                         | 'grok'    (route to xAI/Grok)
#                         | 'auto'    (pick by POLITICS_MODEL)
#
# Phase 6 ships dry-run as the proof path. inherit/grok routes are stubs that
# fail loudly with a non-zero exit if the required tool/credential is missing,
# so cmdAdapter records 'failed' instead of silently producing garbage.

set -u
umask 077

log() { printf '[hermes-bridge] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

BRANCH="${POLITICS_BRANCH:-}"
MODEL="${POLITICS_MODEL:-inherit}"
MODE="${POLITICS_BRIDGE_MODE:-dry-run}"
[ -n "$BRANCH" ] || die "POLITICS_BRANCH not set"

# Drain stdin so the parent doesn't block on EPIPE. We don't need the prompt
# content in dry-run mode — the branch+model selects the stub shape.
PROMPT="$(cat || true)"
log "branch=$BRANCH model=$MODEL mode=$MODE prompt_bytes=${#PROMPT}"

resolve_mode() {
  case "$MODE" in
    dry-run|inherit|grok) echo "$MODE" ;;
    auto)
      case "$MODEL" in
        grok) echo grok ;;
        *)    echo inherit ;;
      esac
      ;;
    *) die "unknown POLITICS_BRIDGE_MODE: $MODE" ;;
  esac
}

EFFECTIVE_MODE="$(resolve_mode)"

# --- routes ----------------------------------------------------------------

route_inherit() {
  # Real wiring would shell out to a Hermes CLI subcommand that invokes
  # delegate_task with a leaf subagent and prints the branch JSON. That CLI
  # surface does not exist on this host yet, so we fail loudly rather than
  # invent fake data.
  if command -v hermes >/dev/null 2>&1 && hermes --help 2>&1 | grep -q delegate; then
    die "inherit route present but not implemented in Phase 6 — set POLITICS_BRIDGE_MODE=dry-run for now"
  fi
  die "inherit route requires a Hermes 'delegate' CLI subcommand; not found in PATH"
}

route_grok() {
  if [ -z "${XAI_API_KEY:-}${GROK_API_KEY:-}${HERMES_XAI_KEY:-}" ]; then
    die "grok route requires XAI_API_KEY (or GROK_API_KEY / HERMES_XAI_KEY); none set"
  fi
  # Credential is present but Phase 6 intentionally does not call the paid API
  # during proof. Fail loudly so cmdAdapter records 'failed'.
  die "grok route detected credential but Phase 6 does not invoke it during proof — use dry-run"
}

route_dry_run() {
  # Deterministic, branch-contract-valid JSON. Citations only reference real
  # branches so cross-branch integrity stays green. Sources use .gov to avoid
  # the official.facts X_SOCIAL/UNKNOWN warning.
  case "$BRANCH" in
    official)
      cat <<'JSON'
{
  "facts": [
    {
      "claim": "Bridge dry-run stub: AG nomination process documented at DOJ public site.",
      "source": "https://www.justice.gov/ag",
      "date": "2026-05-22",
      "verified": true
    }
  ]
}
JSON
      ;;
    xSignal)
      cat <<'JSON'
{
  "narratives": [
    {
      "claim": "Bridge dry-run stub: chatter present, no verified content.",
      "tier": "rumor",
      "repeated": false,
      "source": "https://x.com/example/status/0"
    }
  ]
}
JSON
      ;;
    plausibility)
      cat <<'JSON'
{
  "candidates": [
    {
      "name": "Stub Candidate",
      "strengths": ["dry-run placeholder"],
      "weaknesses": ["no real analysis"],
      "obstacles": ["bridge stub only"]
    }
  ]
}
JSON
      ;;
    skeptic)
      cat <<'JSON'
{
  "favoriteWrong": ["Dry-run stub: leader may be wrong because no real reasoning was done."],
  "secondUnderpriced": ["Dry-run stub: second candidate may be underpriced for the same reason."],
  "settlementTraps": ["Dry-run stub: acting/interim exclusion is a known trap."],
  "narrativeTraps": ["Dry-run stub: X echo chambers are a known trap."]
}
JSON
      ;;
    judgment)
      cat <<'JSON'
{
  "strongestSignal": "Dry-run stub: cites official.facts[0] (dry-run).",
  "strongestCounter": "Dry-run stub: cites skeptic.settlementTraps[0] (dry-run).",
  "biggestSettlementAmbiguity": "Dry-run stub: acting AG resolution path.",
  "biggestUncertainty": "Dry-run stub: confirmation before market expiry.",
  "confidence": "low",
  "watchlistTriggers": ["Dry-run stub watchlist trigger"],
  "wouldChangeView": ["Dry-run stub change-of-view trigger"],
  "citations": [
    { "branch": "official", "ref": "facts[0] dry-run stub" },
    { "branch": "skeptic",  "ref": "settlementTraps[0] dry-run stub" }
  ]
}
JSON
      ;;
    *) die "unknown branch: $BRANCH" ;;
  esac
}

case "$EFFECTIVE_MODE" in
  dry-run) route_dry_run ;;
  inherit) route_inherit ;;
  grok)    route_grok ;;
  *)       die "unreachable mode: $EFFECTIVE_MODE" ;;
esac
