# AGENTS

This repo now supports a lightweight operator system alongside the app code.

## Purpose
Use this repo as both:
1. the application codebase
2. a file-based operator workspace

## Operator folders
- `agents/` = role definitions
- `skills/` = reusable workflows
- `channels/` = session logs
- `state/` = persistent working state
- `runbooks/` = operating instructions
- `prompts/` = reusable task packets

## Active agents

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

### politics-app (politicsApp pipeline)
Components: `politicsAppRouter`, `politicsIntelIngest`, `politicsNarrativeEngine`, `electionsAlphaEngine`, `geopoliticsAlphaEngine`, `politicsReviewAnalyst`

Role:
- route and price outcome-based political markets (elections, geopolitics, cabinet appointments)
- ingest geopolitical intelligence via worldmonitor (upstream-only)
- build narrative state from headlines, entity tags, event clusters
- model fair probabilities for elections (polling + base rates) and geopolitics (event clustering + urgency heat)
- track CLV and calibration by political market subtype

## Working rules
- one exploration round only
- no brainstorming after convergence
- use files as source of truth
- do not assume memory beyond `channels/` and `state/`
- do not claim completion without proof

## App/operator boundary
Operator files must stay separate from app runtime code.
Do not make frontend or src depend on operator folders unless intentionally building that feature later.
