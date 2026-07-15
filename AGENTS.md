# AGENTS

## CPC Agent Identity

Claude Code operating in this repo is the **CPC public-alpha agent**. Its job is to move Captains Prediction Companion from captain-only use to a state where any community member can clone, configure, run, and verify the app without private guidance.

## Public-Alpha Mission

Protect the clean baseline. Ship a tagged commit that passes the fresh-clone checklist. Do not add integrations until the baseline is committed and externally validated.

## Current Launch Phase

**Phase: public-alpha baseline — NOT YET COMMITTED**

All public-alpha changes (README, .env.example, package.json, setup/doctor/demo scripts, identity cleanup) are in the working tree but not committed. The single next step is committing and tagging the baseline before any new work.

## LEAN INITIATIVE

Standing directive across all repair and feature work until superseded. Applies to Codex and to Hermes `-z` sessions run in this repo (both auto-load this file):

- Finish active loose ends before the broad cut.
- Every interim repair must reduce or preserve complexity, never add permanent architecture debt.
- Prefer fixing the earliest shared contract over patching a downstream symptom.
- No new feature, wrapper, validator, fallback, renderer, or entrypoint unless strictly required by the task at hand.

Pre-lean order (do not skip ahead of the current stage without explicit instruction):

1. Mentions stable
2. Discord complete
3. Stable baseline recorded
4. Broad lean architecture pass
5. Live Ops afterward

Mirrored in the checked-in `CLAUDE.md` (Claude Code's project instructions) so all three controllers apply the same discipline.

## Default Behavior

1. Read repo state before acting. Never assume local state matches last session.
2. Separate working tree changes from committed state — never treat them as equivalent.
3. Default to the smallest safe change. Do not refactor, add features, or clean up unrelated code unless asked.
4. Require proof before marking any task complete. Proof = files changed + commands run + output.
5. If a task would touch a no-touch zone, stop and report instead of proceeding.

## Default Active Skills

These skills are always active in this repo:

1. **repo-safety** — `.skills/repo-safety.md`
   Guards the working baseline, prevents secrets from leaking, enforces commit hygiene.

2. **public-alpha-readiness** — `.skills/public-alpha-readiness.md`
   Tracks launch criteria, fresh-clone checklist, and missing docs. Blocks completion claims until criteria are met.

3. **prediction-card-pipeline** — `.skills/prediction-card-pipeline.md`
   Describes the MCP server + Hermes + Kalshi prediction card flow. Required context for any src/ or scripts/ work.

## Conditional Skills

These skills are **inactive by default**. Activate only when explicitly working on that feature:

| Skill | Activate when |
|---|---|
| `telegram-notifier` | Explicitly building Telegram output from CPC cards |
| `community-intake` | Explicitly building Discord/GitHub/community market input |
| `contributor-docs` | Explicitly writing CONTRIBUTING.md, CHANGELOG, or contributor guides |

Conditional skills do not change default behavior. They add context and safety rules for their specific domain.

## No-Touch Zones

Do not modify these without explicit instruction and a stated reason:

- `.env` — real secrets, never read or log
- `src/server.js` — core MCP server; changes require tests to pass
- `deploy/` — production deployment templates; do not change paths or service names
- `data/` — runtime state; never commit contents
- `state/` — per-run research artifacts; never commit new date-scoped runs
- `.runtime/` — production environment overrides; gitignored for a reason
- Billing, API keys, payment flows — refuse all changes to these

## Baseline Protection Rule

**Before adding any integration (Telegram, Discord, webhooks, new APIs):**

1. The public-alpha working tree changes must be committed.
2. The commit must be tagged `v1.0.0-alpha` or equivalent.
3. `npm run demo` must pass on the committed state.
4. `CONNECT_CHATGPT.md` must not contain live tunnel URLs.

If these conditions are not met, stop and report. Do not build on an uncommitted baseline.

## Proof Requirements

Every completed task must provide:

1. **Files changed** — list with line-level summary
2. **Commands run** — exact commands in order
3. **Output** — actual terminal output, not paraphrased
4. **App behavior unchanged** — confirm no runtime behavior was altered (or document what changed and why)

Claims of completion without proof are rejected.

## Stop Conditions

Stop and report (do not proceed) if:

- A task requires touching a no-touch zone
- A secret or credential would be logged, committed, or exposed
- The working tree has uncommitted changes that would be overwritten
- A new integration is requested but the baseline is not committed
- Repo access fails or required files are missing

---

## Operator System

This repo uses a file-based operator system alongside the app code.

### Operator folders

- `agents/` — role definitions
- `skills/` — reusable operator workflows (distinct from `.skills/` which holds Claude Code instructions)
- `channels/` — session logs
- `state/` — persistent working state
- `runbooks/` — operating instructions
- `prompts/` — reusable task packets

### App/operator boundary

Operator files must stay separate from app runtime code.
Do not make `frontend/` or `src/` depend on operator folders unless intentionally building that feature.

---

## Active Pipeline Agents

### companion-router
Location: `agents/companion-router/`

Role:
- normalize all incoming markets and route to correct pipeline (sportsApp / mentionsApp / politicsApp)
- classify market type (outcome-based vs text-based vs political)
- build context block for the receiving pipeline
- flag ambiguous routing rather than guessing

### alphaagent
Location: `agents/alphaagent/`

Role:
- acquire data from all external sources (Kalshi, Polymarket, stats APIs, weather, worldmonitor)
- manage API auth, rate limits, and request queuing
- normalize prices and event metadata to canonical formats
- report data freshness, source health, and fetch failures proactively

### decision-logic
Location: `agents/decision-logic/`

Role:
- run shared EV, Kelly, CLV, and fair value calculations for all pipelines
- enforce per-bet, per-league, per-phase, and global exposure caps
- emit one of six canonical trade postures: TRADE_YES, TRADE_NO, PLACE_PASSIVE_ORDER, WAIT, ESCALATE, NO_TRADE
- apply quarter-Kelly production sizing without exception

### controller
Location: `agents/controller/`

Role:
- define the real task
- lock scope
- prevent drift
- require proof
- choose the next smallest useful action

### oracle
Location: `agents/oracle/`

Role:
- analyze prediction markets
- check resolution criteria and edge cases
- estimate fair value probabilistically
- compare market pricing to evidence
- support automation, alerts, and arb detection
- note real money risk and avoid fabricated prices

### researcher
Location: `agents/researcher/`

Role:
- gather repo facts
- summarize architecture and gaps
- support controller decisions with evidence

### mentions-researcher
Location: `agents/mentions-researcher/`

Role:
- research mention markets as exact-string future-language proof markets
- use Firecrawl for official-source discovery and transcript/source extraction
- produce rules-first evidence packets without making picks
- separate historical word-match evidence, current context, prompt-force paths, and unresolved gaps

### mentions-mcp-forecaster
Location: `agents/mentions-mcp-forecaster/`

Role:
- treat market price as prior
- update with transcript/context evidence
- apply MixMCP damping
- calculate TV, edge, LSP, max entry, and trade gate

### captain-x-writer
Location: `agents/captain-x-writer/`

Role:
- convert completed internal research and trade-gate packets into Captain X guide drafts
- preserve required public guide sections and code-box tables
- avoid source dumps, fabricated picks, and publishing side effects

### captainmentions-article-formatter
Location: `agents/captainmentions-article-formatter/`

Role:
- convert completed mention-market research packets into CaptainMentions-style X Article drafts
- preserve the observed Section A-G structure, proof-market voice, board tables, live playbook, groups, sneaky NOs, coffee CTA, and signoff
- refuse to invent picks, prices, or TV/edge math when inputs are incomplete

### sports-pre-game
Location: `agents/sports-pre-game/`

Role:
- call `sports_calendar_router` to identify active sports for the day
- route each active sport to its dedicated modeling skill (gameApp / propApp / fightAndRacingApp)
- construct fair probability estimates and compare to market-implied probabilities
- evaluate EV and apply Kelly fractional sizing with configured caps
- log all opportunities (bet and no-bet) with structured rationale

### sports-live
Location: `agents/sports-live/`

Role:
- initialize from pre-game watchlist and poll live game/race/fight state (default: 20s interval)
- update fair probabilities from live data (scores, clock, events, drive context)
- enforce higher EV threshold than pre-game (default: 5% vs 2%)
- check exposure caps and drawdown limits before execution; pause at 15% drawdown
- log all decisions with live snapshots

### sports-review
Location: `agents/sports-review/`

Role:
- capture entry odds and closing prices for every logged bet
- calculate CLV by bet and by segment (open/midday/pre-lock/live)
- measure probability calibration over rolling time windows grouped by league/phase/market subtype
- output actionable threshold and configuration adjustment recommendations

### politics-app
Components: `politicsAppRouter`, `politicsIntelIngest`, `politicsNarrativeEngine`, `electionsAlphaEngine`, `geopoliticsAlphaEngine`, `politicsReviewAnalyst`

Role:
- route and price outcome-based political markets (elections, geopolitics, cabinet appointments)
- ingest geopolitical intelligence via worldmonitor (upstream-only)
- build narrative state from headlines, entity tags, event clusters
- model fair probabilities for elections (polling + base rates) and geopolitics (event clustering + urgency heat)
- track CLV and calibration by political market subtype

## Working Rules

- one exploration round only
- no brainstorming after convergence
- use files as source of truth
- do not assume memory beyond `channels/` and `state/`
- do not claim completion without proof

---

## MLB Composite Model — Next Agent Handoff (2026-05-26)

### What exists and works

- **13-layer composite evidence model** (`scripts/mlb/lib/evidence-ledger.mjs`) — market-neutral, fundamentals only, weights sum to 1.00
- **Multi-lane ceiling board** (`scripts/mlb/lib/multi-lane-ceiling.mjs`) — ML, run line, totals, YFRI, NRFI lanes + CLV metadata struct
- **Research adapter** (`scripts/mlb/source-adapters/research-agent-adapter.mjs`) — bridges raw input → composite ledger
- **Manual composite refresh** (`scripts/mlb/late-slate-composite-refresh.mjs`) — runs composite on hardcoded 4-game fixture set, writes compact artifact, sends via Telegram
- **Telegram delivery** (`scripts/mlb/_send-due.mjs`) — sends `.txt` file as a single document (not chunked messages); skips windows with 0 picks
- **Daily cron** — 3 jobs: 7am slate discovery, every-10-min packet render, every-5-min send-due
- **Tests** — 373/373 passing

### What is broken / missing

**Critical gap: stats source adapter**

The composite model requires per-game pitcher and team stats (ERA, WHIP, K/9, team wOBA/OPS, park factors). These are currently hardcoded as fixtures for 4 games. All other games return "composite model pending — no pick."

The `baseball_savant_adapter` in `state/mlb/DATE/discovery/` is blocked (HTTP 403). The `context_adapter` returns probable pitcher names but ERA/record fields are `null`.

**Task for next agent: build `scripts/mlb/source-adapters/stats-readonly.mjs`**

Fetch pitcher season stats and team batting stats for all games in today's slate. Sources to try in order:
1. **MLB Stats API** — `https://statsapi.mlb.com/api/v1/people/{playerId}/stats?stats=season&group=pitching&season=2026` (free, no auth)
2. **ESPN API** — `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event={espn_event_id}` (context_adapter already fetches espn_event_id per game)
3. **FanGraphs CSV** — `https://www.fangraphs.com/api/leaders/...` (check if accessible)

The adapter should write `state/mlb/DATE/discovery/stats_adapter.json` with schema:
```json
{
  "source_id": "mlb_stats",
  "records": [
    {
      "game_pk": 824434,
      "away_pitcher": { "name": "Cade Cavalli", "mlb_id": 676917, "era": 4.12, "whip": 1.31, "k_per_9": 8.4, "hand": "R" },
      "home_pitcher": { "name": "Joey Cantillo", "mlb_id": 676282, "era": 3.87, "whip": 1.18, "k_per_9": 9.1, "hand": "L" },
      "away_team_ops": 0.724,
      "home_team_ops": 0.751,
      "away_team_woba": 0.318,
      "home_team_woba": 0.327
    }
  ]
}
```

**Task: wire stats into `late-slate-composite-refresh.mjs`**

After `stats_adapter.json` exists, replace hardcoded `TONIGHT_GAMES` fixtures with a dynamic build:
1. Load `state/mlb/DATE/discovery/mlb_official_adapter.json` for all games + game_pks
2. Load `state/mlb/DATE/discovery/stats_adapter.json` for pitcher/team stats
3. Load `state/mlb/DATE/discovery/weather_adapter.json` for park/weather
4. Load `state/mlb/DATE/discovery/context_adapter.json` for injuries + lineup status
5. Build `researchInput` for each game and call `composeEvidenceLedgerForGame`
6. Skip games where lineup_status is still `lineup_pending` (gate: confirmed only)

**Kalshi references in sports pipeline**

Remove all Kalshi ticker references from MLB sports reports. Kalshi data is not used in the composite model. References to `KXMLBGAME`, `KXMLBSPREAD`, etc. remain in `pre-lock-report.mjs` footer and `market-engine.mjs` — these files can be deleted or gutted once the composite pipeline covers all games.

Do NOT touch politics or mentions pipelines — Kalshi is still relevant there.

### File map for this work

| File | Purpose |
|---|---|
| `scripts/mlb/lib/evidence-ledger.mjs` | 13-layer composite — do not change layer weights without tests |
| `scripts/mlb/lib/multi-lane-ceiling.mjs` | Market lane board + CLV metadata |
| `scripts/mlb/source-adapters/research-agent-adapter.mjs` | Input bridge — add stats fields here |
| `scripts/mlb/late-slate-composite-refresh.mjs` | Main composite run + Telegram send |
| `scripts/mlb/_send-due.mjs` | Sends rendered windows; skips 0-pick windows |
| `scripts/mlb/pre-lock-report.mjs` | Window report generator — currently no-op for picks |
| `scripts/mlb/lib/report-render.mjs` | Game section renderer — market-free, composite-only |
| `state/mlb/DATE/discovery/` | All source adapter outputs for a given date |
| `state/mlb/DATE/slate-run-plan.json` | Window schedule + delivery tracking |

### Hard rules (do not break)

- Market prices NEVER feed into composite score
- No trades placed by any script
- `.env.local` is gitignored — never commit `TELEGRAM_BOT_TOKEN`
- Politics + mentions pipelines are separate — do not touch them
- 373 tests must stay green
