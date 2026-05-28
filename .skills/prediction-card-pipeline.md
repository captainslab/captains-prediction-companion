# Skill: prediction-card-pipeline

**Default: active in every session.**

## Purpose

Context for any work touching `src/`, `scripts/`, or the MCP server. Prevents changes that break the card contract or Hermes integration.

## Pipeline Overview

```
User / ChatGPT
    │
    ▼ POST /mcp  (Kalshi URL)
src/server.js
    │
    ▼ analyze_kalshi_market_url tool
src/eventMarketTool.js
    │
    ├─▶ src/kalshiApi.js        — fetches event/market/orderbook from Kalshi REST API (no auth required for public markets)
    │
    ├─▶ src/eventMarketAlpha.js — calls Hermes CLI for fair-value alpha (provider: gemini)
    │                             returns: fair_yes, confidence, reasoning, watch_for
    │
    └─▶ src/hermesOracle.js     — calls Hermes CLI for oracle decision
                                  returns: board_recommendation, board_confidence, reasoning_chain, edge_type, catalyst

Output: compact prediction card JSON
    board_recommendation: buy_yes | buy_no | watch | pass
    board_confidence:     low | medium | high
    board_headline:       one sentence
    reasoning_chain:      array of evidence strings
    edge_type:            historical | behavioral | timing | market_structure | information | none
```

## Key Files

| File | Role | Touch rule |
|---|---|---|
| `src/server.js` | MCP server + HTTP routes | Changes require passing tests |
| `src/eventMarketTool.js` | Card builder entry point | Changes must preserve output contract |
| `src/eventMarketAlpha.js` | Hermes alpha stage | Changes must not break fair_yes/confidence/reasoning output |
| `src/hermesOracle.js` | Hermes oracle stage | Downgrade logic must remain; never remove watch fallback |
| `src/kalshiApi.js` | Kalshi data enrichment | Changes must preserve enriched input schema |
| `src/hermesRuntime.js` | Hermes CLI wrapper | HERMES_COMMAND env var controls binary path |
| `src/modelDefaults.js` | Model name resolution | Default: gemini-2.5-flash |

## Output Contract

The card JSON visible to users contains only:
- `board_recommendation`, `board_confidence`, `board_headline`
- `child_contracts` (for mention boards with multiple phrases)
- `board_no_edge_reason_code`, `board_no_edge_reason` (when not actionable)

Hidden from user-facing output: `reasoning_chain`, `edge_type`, `catalyst`, `invalidation_condition`, `official_source_*`, `transcript_excerpt`.

**Do not move hidden fields to visible output without explicit instruction.**

## Safe Fallback Behavior

If Hermes CLI is unavailable or returns invalid output:
- Alpha stage: skips enrichment, passes through unenriched input
- Oracle stage: downgrades to `watch` with `board_no_edge_reason_code: oracle_unavailable`
- Server still starts and serves all routes

**Never remove or bypass the downgrade path.** It is the safety net for missing Hermes.

## Hermes CLI

- Binary resolved via `HERMES_COMMAND` env var (default: `hermes`)
- Called synchronously via `spawnSync` with a 120s timeout
- Provider: `HERMES_PROVIDER` (default: `gemini`)
- Model: `EVENT_MARKET_ALPHA_MODEL` (default: `gemini-2.5-flash`)

If Hermes is not installed, all market analysis returns a `watch` posture. Server behavior is otherwise unaffected.

## Environment Variables That Control the Pipeline

See `.env.example` for full list. Key ones:

| Variable | Effect |
|---|---|
| `GEMINI_API_KEY` | Required for Hermes to call Gemini |
| `HERMES_COMMAND` | Path to Hermes binary |
| `EVENT_MARKET_ALPHA_PROVIDER` | Provider for alpha stage |
| `EVENT_MARKET_ALPHA_MODEL` | Model for alpha stage |
| `PIPELINE_SEED_URLS` | URLs pre-loaded into pipeline on startup |
