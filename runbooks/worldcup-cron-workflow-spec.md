# World Cup 2026 — Cron Workflow Spec

Status: active (tournament runs 2026-06-11 → 2026-07-19)
Doctrine parity: MLB (quiet-mode cron wrappers), UFC (no-send/no-trade glue, opponent-relative scoring), NASCAR (decision-board packet shape).

Hard rules:

- Market price NEVER enters the composite score. Market context is attached
  after scoring as reference only (`MARKET (NOT IN SCORE)` rows; pinned by
  `test/worldcup-composite-neutrality.test.mjs`).
- Opponent data lives IN the score (UFC-style: every matchup layer is
  team-vs-this-opponent).
- No fabricated data: every adapter fails soft to MISSING; missing lineups
  produce a BLOCKED row and a pre-lineup PICK downgrade, never a fake pick.
- Script-owned scheduler glue only. No LLM. No send_message. No trades.

## Jobs

Two crontab entries cover all six workflow phases because the dispatcher is
schedule-aware: it reads cached fixture kickoff times and decides what is due.

```cron
# World Cup daily sync — fixtures + team baselines (UTC date)
30 5 * * * /home/jordan/captains-prediction-companion/scripts/worldcup/worldcup-daily-sync.sh

# World Cup schedule-aware dispatcher — every 15 min during the tournament
*/15 * * * * /home/jordan/captains-prediction-companion/scripts/worldcup/worldcup-dispatch.sh
```

Phase map (computed by `scripts/worldcup/cron/cron-dispatch.mjs` from real
kickoff times, relative to kickoff K; idempotent via markers in
`state/worldcup/<date>/cron/`):

| Phase | Window | Action | Repeats? |
|---|---|---|---|
| daily sync | 05:30 UTC | cache `static_structure.json` + `team_baseline.json` | daily |
| pre-lineup packet | K-6h .. K-90m | morning board packet | once per date (marker) |
| lineup-window refresh | K-90m .. K-40m | refetch matchday data, regenerate packet | every run in window |
| post-lineup final | K-40m .. K | lineup-locked packet | once per match (marker) |
| post-match grade | K+150m .. | grade composite call vs final score → `state/worldcup/<date>/grades/` | once per match, retries until score exists |
| knockout switch | automatic | driven by `match.stage` in fixture data (ET/pens layer + advance lane activate); dispatcher logs it for the audit trail | n/a |

Quiet mode (MLB convention): routine output appends to
`logs/worldcup-daily-sync.log` / `logs/worldcup-dispatch.log`; stderr both
logs and surfaces to cron for alerting.

Dry-run proof (no side effects, decisions only):

```
node scripts/worldcup/cron/cron-dispatch.mjs --date 2026-06-11 --now 2026-06-11T14:00:00Z --dry-run
node scripts/worldcup/cron/daily-sync.mjs --date 2026-06-11 --dry-run
```

Pinned by `test/worldcup-cron.test.mjs` (phase windows, marker idempotency,
no-send/no-trade wrapper grep, dry-run writes nothing).

## Source table (probed live 2026-06-09, all keyless/no-signup)

| Source | Reliability | Access | Fields | Fragility | Role |
|---|---|---|---|---|---|
| FIFA API v3 (`api.fifa.com`) | works; WC2026 = idCompetition 17, idSeason **285023** (255711 is Qatar 2022) | plain GET | match IDs, UTC kickoff, groups, stages, stadiums, scores, status | undocumented; paginated; generic stadium names | **primary** fixtures/results |
| ESPN (`site.api.espn.com` `fifa.world`) | works | plain GET | events, teams, real venue names, live scores, broadcasts | `dates=` windowed by US-local day (re-filter on kickoff_utc) | **fallback** fixtures/scores |
| eloratings.net (`World.tsv`) | works | plain GET | rank, Elo per team (244 teams) | headerless TSV; own team-name conventions | **primary** ratings |
| FIFA ranking (`inside.fifa.com/api/ranking-overview`) | partial — newest accessible ranking is 2025-09-18 | GET w/ browser UA | rank, points, 211 teams | newer dateIds return empty | seed-only (staleness caveat) |
| openfootball GitHub (`2026--usa/`) | works (text format) | raw GET | full 104-match schedule, groups A–L | hand-maintained `.txt`, no 2026 JSON | seed/cross-check |
| Wikipedia | works | REST summary | tournament dates, format | prose | cross-check only |
| anything requiring key/signup | — | — | — | — | rejected |

Team-name normalization caveat: FIFA says "Korea Republic"/"Czechia"; ESPN
says "South Korea"; openfootball says "Czech Republic". Normalize against
FIFA abbreviation codes (KOR/CZE) when joining sources.

## Composite layer table (first-principles analyst priors — not fitted, not equal-weight)

| # | Layer | Weight | Why |
|---|---|---|---|
| 1 | team_quality_baseline | 0.20 | Elo/ranking gap is the single strongest predictor in international football; widest talent spreads of any major competition |
| 2 | recent_form | 0.05 | deliberately low — friendlies + rotated qualifier squads are noisy |
| 3 | attacking_strength | 0.07 | goals / xG / shot quality |
| 4 | defensive_strength | 0.08 | tournament football is low-scoring; solidity travels better than flair |
| 5 | opponent_adjusted_attack | 0.09 | UFC-style: attack vs THIS opponent's defense |
| 6 | opponent_adjusted_defense | 0.09 | defense vs THIS opponent's attack |
| 7 | opponent_style_fit | 0.05 | press/possession asymmetry; real but measurement-limited |
| 8 | set_piece_matchup | 0.06 | ~30% of WC goals; most stable team skill over a short tournament |
| 9 | goalkeeper_edge | 0.04 | matters most in tight/knockout games |
| 10 | squad_availability | 0.08 | tournaments are attrition contests; a missing talisman beats form |
| 11 | lineup_strength_delta | 0.06 | confirmed XI vs expected; round-3 group rotation is a result-mover |
| 12 | rest_travel_venue_climate | 0.06 | 2026-specific: 3 host countries, Mexico City altitude (2,240 m), June heat |
| 13 | tournament_incentive_state | 0.05 | dead rubbers, playing-for-a-draw, seeding angles |
| 14 | knockout_extra_time_penalty | 0.02 | shootouts ≈ coin-flips; tiny persistent edge; knockout-only |

Weights sum to 1.00; missing layers renormalize out. Data-coverage caps:
0 → NO CLEAR PICK, 1–3 → WATCH, 4–6 → LEAN, 7–9 → EVIDENCE_LEAN, 10+ → PICK
eligible. Unconfirmed lineups additionally cap match_winner below PICK.
Revisit weights against `state/worldcup/*/grades/` after group stage.

## Market normalization (post-score only)

Kalshi markets are pre-fetched by the shared discovery step into
`state/worldcup/<date>/market/<match_id>.json` (single contract or
`{markets:[...]}`); `market-context.mjs` + `lib/market-parser.mjs` normalize
each contract from its TEXT into `{market_family, period, side, line,
settlement, normalized_target, implied_probability}` — raw bid/ask/volume/OI
are stripped before the context ever reaches a board.

Supported market families (lanes): 1X2 incl. Draw, goal spread/handicap,
total goals, BTTS — each with a 1st-half variant. 1st-half lanes are
`BLOCKED_MODEL_LAYER_MISSING` (no goals/shots-by-half source exists; market
shown as reference only, never modeled from invented half data). Settlement
defaults to regulation 90'+stoppage; ET/penalties only when the contract
says so explicitly (`to advance` → includes penalties). Ambiguous contracts
parse to `unknown`/low-confidence and route to audit, never guessed.

1X2 probabilities (`lib/match-probabilities.mjs`) are computed from the
composite ledgers BEFORE market attachment: logistic split on composite diff
with a calibrated draw prior (base 22%, boosted by narrow gap / low goal
environment / defensive matchup / draw incentive, clamped 10–42%). Draw is
ACTIONABLE only with narrow gap AND low goal environment AND a secondary
support (defensive matchup, draw incentive, or genuine scoring-suppression
conditions); close strength alone → WATCH_ONLY. Missing attack/defense
layers → BLOCKED_MODEL_LAYER_MISSING (no goal proxy, totals/BTTS/spread
lanes block instead of defaulting).

Edge (model prob − implied, percentage points) exists only where a model
fair probability exists: the 1X2 lane (home/away/draw per parsed side).
Spread/total/BTTS emit proxy reads (WATCH/LEAN bands), never a pp edge.

## Artifacts

- Packets: `state/packets/<date>/worldcup-matchday/worldcup-<date>-<stage>.txt` (+ `.meta.json`)
- Audit: `worldcup-<date>-audit.json` next to the packet (full ledgers, matchup JSON, raw market context)
- Grades: `state/worldcup/<date>/grades/<match_id>.json`
- Phase markers: `state/worldcup/<date>/cron/*.done`
