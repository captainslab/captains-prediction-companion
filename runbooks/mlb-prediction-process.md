# MLB Kalshi Prediction Process Runbook

Use this runbook for daily MLB prediction work when Kalshi baseball markets are the tradable target.

This is an operator workflow, not runtime app code. Keep all generated files under the operator workspace and do not make `src/` or frontend code depend on this process unless a later task explicitly builds that feature.

## Objective

Build a repeatable daily workflow that:

- inventories the Kalshi baseball board before doing trade selection;
- researches MLB games and player props from reliable baseball sources;
- separates baseball research quality from Kalshi trade availability;
- handles props that are not currently offered on Kalshi without incorrectly marking them as bad baseball picks;
- blocks trades when liquidity, spread, stale price, rules, or source gaps make a listed market unusable;
- outputs a human guide, a machine-readable pick sheet, and a run log with source health.

Do not make live picks, place trades, or publish a public guide from this runbook alone. The runbook produces decision packets and operator files for review.

## Source-Zero Intake: Kalshi Baseball Calendar

Source zero is:

`https://kalshi.com/calendar/sports/baseball`

Kalshi is the tradable-market source. It tells the workflow what can actually be traded, current market prices, rules, bid/ask, liquidity, and whether a game or prop is listed.

Kalshi is not the full baseball truth source. Do not use Kalshi alone to infer starting pitchers, lineups, player skill, weather, park effects, or baseball fair value.

Daily intake sequence:

1. Open the Kalshi baseball calendar and inventory every listed baseball event.
2. For each event, capture event title, event ticker if available, market tickers, rules, close time, settlement source, market status, bid/ask, last price, volume, open interest if present, and order book depth.
3. If the calendar page is inaccessible or challenge-gated, fall back to the Kalshi Trade API for market discovery and order books, then record the calendar access issue in `run_log.md`.
4. Treat only exact Kalshi-listed contracts as tradable. Sportsbook props, capper lists, or external odds pages never prove Kalshi availability.
5. Preserve the morning inventory. Later pre-game scans should update statuses without erasing earlier availability gaps.

## Limited Daily Source Stack

Keep the daily stack small. The core workflow uses four required source families and one optional sanity check:

1. Kalshi calendar and Trade API
   - Use for market intake, rules, available contracts, current prices, bid/ask, liquidity, order books, and historical Kalshi review.
2. Official MLB data
   - Use MLB Stats API and MLB Gameday data for schedule, probable pitchers, confirmed lineups, game status, box scores, starters, and final results.
3. Baseball Savant Statcast
   - Use for batter and pitcher skill signals such as K%, barrel rate, hard-hit rate, HR profiles, batted-ball shape, pitch mix, and pitch-level matchup checks.
4. National Weather Service API
   - Use for outdoor weather: wind, temperature, rain/postponement risk, and hourly game-window conditions at the stadium point.
5. Optional price sanity check
   - Use only if a reliable, public, no-login source is already available that day. Do not make it required. Do not block the workflow if unavailable.

Do not add more than five core daily sources without a written reason in `run_log.md`. Do not use random prediction blogs or social media as core sources. Beat reporters can confirm late lineup, injury, or weather notes only after the official source stack is checked.

## Source Discovery Verification

Last checked from this workspace on 2026-05-15:

- Firecrawl CLI was not installed, so direct public endpoint checks and official web documentation were used instead.
- Kalshi calendar URL returned an HTTP 429 challenge from the shell environment. The browser calendar remains source zero, and the public Kalshi Trade API was reachable for event/market discovery.
- Kalshi Trade API docs identify `https://external-api.kalshi.com/trade-api/v2` as the recommended production base URL and document events, markets, order books, trades, and candlesticks.
- MLB Stats API schedule endpoint returned the 2026-05-15 MLB slate, including game status and probable pitchers.
- Baseball Savant Statcast Search returned HTTP 200, and the CSV export endpoint returned a downloadable CSV.
- NWS API `points/{lat},{lon}` returned grid metadata and an hourly forecast URL.

If future web/source checks are unavailable, do not invent replacements. Mark source discovery incomplete in `run_log.md`, mark affected markets `BLOCKED`, and list the exact missing source.

## Source Registry

Write a source registry for each run to `state/mlb/YYYY-MM-DD/source_registry.json`. Use this table as the baseline.

| Data need | Recommended source | Backup source | Access method | Reliability grade | Daily repeatability | Limitations |
|---|---|---|---|---|---|---|
| Tradable markets, listed props, rules, prices, bid/ask, liquidity, order books, Kalshi history | Kalshi baseball calendar and Kalshi Trade API | Manual Kalshi UI snapshot if API discovery fails | Calendar URL; `GET /events`, `GET /markets`, `GET /markets/{ticker}`, `GET /markets/{ticker}/orderbook`, `GET /markets/trades`, candlesticks where useful | A for tradability | Daily, but UI may be challenge-gated in shell tools | Kalshi only proves exchange availability and prices; it is not a baseball research source |
| MLB schedule, game IDs, probable pitchers, confirmed lineups, game status, box scores, official results | MLB Stats API and MLB Gameday | MLB.com official game pages or probable pitcher pages | `statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher,team`; `api/v1.1/game/{gamePk}/feed/live`; `api/v1/game/{gamePk}/boxscore` | A for official game state | Daily during season | Probable pitchers can change; confirmed lineups appear close to first pitch |
| Batter/pitcher splits, K%, barrel rate, hard-hit rate, HR profile, pitch mix, pitch-level matchup | Baseball Savant Statcast Search and CSV export | FanGraphs leaderboard CSV when Savant is unavailable | Baseball Savant UI and CSV query URLs saved in run log | A- for Statcast skill data | Daily, but large queries can be slow | Not every query shape is API-stable; keep query URLs small and reproducible |
| Wind, temperature, precipitation, rain/postponement risk, weather-sensitive run environment | National Weather Service API | Weather.gov forecast page for the same point | `api.weather.gov/points/{lat},{lon}` then `forecast/hourly`; use stadium coordinates from a maintained operator venue map | A for US outdoor weather | Daily | Roof decisions, indoor parks, and in-stadium wind effects require manual notes |
| Optional external price sanity | None configured as required | Same-day verified public no-login odds page, recorded in run log | Manual URL captured only when available | Variable | Optional only | Never use this to claim Kalshi availability; never block if unavailable |

## Morning Scan Workflow

Run once in the morning before any pick writing.

1. Create the run folder: `state/mlb/YYYY-MM-DD/`.
2. Start `run_log.md` with operator, UTC timestamp, source versions, and known tool limitations.
3. Load Kalshi source zero and write `slate_manifest.json` with every listed baseball game and market.
4. For each listed Kalshi event, save rules and raw market fields needed to reconstruct bid, ask, spread, liquidity, and close time.
5. Load official MLB schedule for the same date and map Kalshi events to MLB `gamePk` values by teams, date, and start time.
6. Pull probable pitchers and game status. Mark missing starters as `BLOCKED` for starter-dependent markets until refreshed.
7. Pull Baseball Savant summary data needed for all six lanes. Save query URLs and timestamps.
8. Pull NWS hourly forecasts for outdoor stadiums. For domes/retractable roofs, record roof/weather sensitivity and use weather only if the roof state is relevant.
9. Create one prediction packet per market lane per game or prop candidate.
10. Do not finalize props in the morning just because they are missing from Kalshi. Use the prop availability rules below.

Morning outputs may include `WATCH_FOR_LISTING`, `NOT_TRADEABLE`, `LEAN`, `PASS`, and `BLOCKED`. A `CLEAR_PICK` is allowed only when the Kalshi contract is listed and passes the tradeability gate.

## Pre-Game Refresh Workflow

Run at least once per game window, preferably:

- T-minus 120 minutes;
- T-minus 60 minutes;
- T-minus 20 minutes;
- after confirmed lineups post;
- after meaningful weather or roof updates.

Refresh steps:

1. Re-read Kalshi markets and order books for every game and watchlisted prop.
2. Reconcile MLB game status, starters, lineups, scratches, and postponement risk.
3. Re-run player prop evidence for confirmed lineup position and handedness matchup.
4. Recompute fair probability, market-implied probability, edge, confidence, and quarter-Kelly size.
5. Reapply the liquidity/tradeability gate from scratch.
6. Update `picks.json` and `daily-baseball-guide.md`; append changes to `run_log.md`.
7. If a previously absent prop appears on Kalshi, change `NOT_OFFERED_NOW` to `KALSHI_AVAILABLE`, then run the tradeability gate before any `CLEAR_PICK`.

## Kalshi Prop Availability Gaps

Kalshi prop availability is a separate question from baseball research quality.

- If the baseball framework finds a player edge but Kalshi does not list the exact prop, assign `RESEARCH_EDGE` plus `NOT_OFFERED_NOW`, with final status `WATCH_FOR_LISTING`.
- If Kalshi lists the exact prop but the book is too wide, thin, stale, or unclear, assign `KALSHI_AVAILABLE` plus final status `NOT_TRADEABLE`.
- If a sportsbook lists a prop, that proves only sportsbook availability. It does not prove Kalshi availability.
- If Kalshi omits a prop during the morning scan, do not claim it is unavailable for the day. Recheck closer to first pitch.

## Prop Recheck Workflow

Kalshi props can appear later than the morning scan. Missing props are not permanent.

For home run hitters and pitcher strikeouts:

1. Build the baseball research list first.
2. For each candidate, assign `RESEARCH_EDGE`, `LEAN`, `PASS`, or `BLOCKED` based on baseball evidence only.
3. Search Kalshi for an exact prop match:
   - same player;
   - same game date and teams;
   - same market type;
   - same threshold or resolution wording;
   - same settlement source/rules.
4. If no exact Kalshi prop exists and baseball status is `RESEARCH_EDGE`, assign `NOT_OFFERED_NOW` plus final `WATCH_FOR_LISTING`.
5. Recheck watchlisted props at T-minus 120, 60, 30, and 10 minutes, plus immediately after lineups are confirmed.
6. If a prop appears, mark `KALSHI_AVAILABLE`, pull its order book, and apply the liquidity/tradeability gate.
7. If the listed prop has poor spread, depth, stale price, or ambiguous rules, final status is `NOT_TRADEABLE`, not `CLEAR_PICK`.

Example: if a home run hitter has a research edge but Kalshi lists only two of four researched hitters, the two missing hitters become `WATCH_FOR_LISTING`. They are not `PASS` unless the baseball evidence itself fails.

## Kalshi Availability-Status Rules

Use two layers of status:

- Research status: baseball-only view.
- Kalshi availability/tradeability status: exchange-only view.
- Final status: combined operator decision.

Status definitions:

| Status | Layer | Meaning |
|---|---|---|
| `RESEARCH_EDGE` | Research | Baseball framework finds possible value before exchange availability is considered |
| `KALSHI_AVAILABLE` | Availability | Exact market or prop is currently listed on Kalshi with matching rules |
| `NOT_OFFERED_NOW` | Availability | Kalshi does not currently list the exact market or prop |
| `WATCH_FOR_LISTING` | Final | Research edge exists, but Kalshi does not list the exact market or prop yet; recheck closer to start |
| `NOT_TRADEABLE` | Final | Market is listed, but spread, liquidity, stale price, weak order book, rule ambiguity, or execution limits make it unusable |
| `CLEAR_PICK` | Final | Research edge exists and the exact Kalshi market is available and tradeable |
| `LEAN` | Research or final | Interesting evidence, but edge or confidence is not strong enough |
| `PASS` | Final | No edge, insufficient evidence, or price is already efficient |
| `BLOCKED` | Final | Required data is missing or contradictory |

Combination rules:

| Research status | Kalshi availability | Tradeability gate | Final status |
|---|---|---|---|
| `RESEARCH_EDGE` | `KALSHI_AVAILABLE` | Passes | `CLEAR_PICK` |
| `RESEARCH_EDGE` | `KALSHI_AVAILABLE` | Fails | `NOT_TRADEABLE` |
| `RESEARCH_EDGE` | `NOT_OFFERED_NOW` | Not applicable | `WATCH_FOR_LISTING` |
| `LEAN` | Any | Any | `LEAN` unless blocked by missing data |
| `PASS` | Any | Any | `PASS` |
| `BLOCKED` | Any | Any | `BLOCKED` |

Do not treat sportsbook availability as Kalshi availability. Do not claim a prop is unavailable forever because it is absent during the morning scan.

## Liquidity/Tradeability Gate

Apply this gate to every listed Kalshi market before any `CLEAR_PICK`.

Required checks:

1. Exact contract match
   - Market name, player/team, threshold, game date, settlement source, and rules match the researched target.
2. Market status
   - Market is open/active and not halted, closed, determined, or too close to settlement for reliable execution.
3. Bid/ask construction
   - Capture best YES bid and best YES ask. If the API returns YES and NO bids, compute `yes_ask = 1 - best_no_bid`.
4. Spread
   - Default maximum spread for a clear pick is 8 percentage points.
   - Mark `NOT_TRADEABLE` if spread is wider than 10 percentage points unless a passive order is explicitly recommended and logged as non-clear.
5. Top-of-book depth
   - Visible depth at or inside max entry must cover the intended stake without moving price through the edge.
   - Cap order size at the smallest of quarter-Kelly size, configured bankroll cap, and 10% of visible executable depth.
6. Liquidity and activity
   - Require recent trades or a credible two-sided book. If last trade/update is stale, mark `NOT_TRADEABLE` even when fair value shows edge.
   - Default stale-price threshold: older than 30 minutes in the morning, older than 10 minutes inside the final hour before first pitch.
7. Order book shape
   - Reject thin one-level books, spoof-like depth far from top, or books where the fair edge disappears after one tick.
8. Rule clarity
   - If settlement wording does not clearly match the intended bet, mark `BLOCKED` or `NOT_TRADEABLE`.
9. Correlation and exposure
   - Apply per-bet, per-game, per-league, per-market-type, and daily exposure caps before sizing.

If a market fails any required check, final status cannot be `CLEAR_PICK`.

## Market-By-Market Process

### 1. Moneyline / Game Winner

Research process:

1. Match Kalshi game winner market to MLB `gamePk`.
2. Confirm starters or mark `BLOCKED`.
3. Evaluate starter quality, lineup strength, bullpen availability, travel/rest, injuries/scratches if officially confirmed, home field, and weather/park run environment.
4. Estimate fair win probability.
5. Compare fair probability to Kalshi implied probability after spread.
6. Apply liquidity gate.

Research edge requires a fair-value edge of at least 2 percentage points and no unresolved starter or lineup issue.

### 2. Run Line / Spread

Research process:

1. Confirm exact Kalshi spread wording and settlement.
2. Model expected run differential and variance.
3. Check lineup quality, starter mismatch, bullpen fatigue, home/away ninth-inning effects, and weather/park conditions.
4. Compare cover probability to Kalshi price.
5. Apply liquidity gate.

Run line picks need stronger confidence than moneyline because late-game bullpen and home-team batting rules can distort cover probability.

### 3. Game Total

Research process:

1. Confirm exact total threshold and over/under settlement.
2. Build run environment from starters, bullpens, lineup quality, handedness splits, park/weather, and game status.
3. Treat weather as a major signal only for outdoor parks or open-roof conditions.
4. Compare fair over/under probability to Kalshi price.
5. Apply liquidity gate.

Totals are `BLOCKED` when weather is material and the forecast or roof state is unavailable.

### 4. YRFI / NRFI

Research process:

1. Confirm exact first-inning market wording.
2. Require probable or confirmed starters and expected top-of-order bats.
3. Evaluate first-inning pitcher tendencies, opponent top-third quality, handedness splits, walk rate, HR/barrel risk, and weather.
4. Prefer confirmed lineups for final status. Without confirmed lineups, morning output should usually be `LEAN` or `WATCH`, not `CLEAR_PICK`.
5. Apply liquidity gate.

YRFI/NRFI is sensitive to lineup order. If leadoff/top-third uncertainty changes the fair value materially, mark `BLOCKED` until confirmed.

### 5. Home Run Hitters

Research process:

1. Build a baseball research list using hitter barrel rate, hard-hit rate, fly-ball/pull profile, recent contact quality, pitcher HR susceptibility, pitch-type matchup, handedness, park, weather, and lineup inclusion.
2. Assign `RESEARCH_EDGE`, `LEAN`, `PASS`, or `BLOCKED` before checking Kalshi availability.
3. Search Kalshi for exact player HR props only after the research list is built.
4. If a player is not listed on Kalshi, mark `NOT_OFFERED_NOW` and final `WATCH_FOR_LISTING` when research edge exists.
5. If listed, verify player, game, stat definition, and settlement wording.
6. Apply the liquidity gate. HR props often require stricter size caps because prices and books can be thin.

Never mark a research-edge HR hitter as `PASS` solely because Kalshi has not listed that player yet.

### 6. Pitcher Strikeouts

Research process:

1. Confirm probable/announced starter and Kalshi strikeout threshold.
2. Evaluate pitcher K%, swinging-strike/whiff profile, pitch mix, opponent K%, projected lineup handedness, pitch count/workload, recent injury/rest, bullpen context, and game environment.
3. Require lineup confirmation when opponent K profile changes materially by lineup.
4. Compare fair over/under probability to Kalshi price.
5. If the pitcher prop is missing, assign `WATCH_FOR_LISTING` only when the research status is `RESEARCH_EDGE`.
6. Apply liquidity gate.

Pitcher K picks are `BLOCKED` if starter confirmation is missing or if workload/pitch-count risk cannot be resolved.

## Required Evidence By Market Type

| Market type | Required evidence before final status |
|---|---|
| Moneyline / game winner | Kalshi rules and price; MLB game match; starters; expected lineup quality; bullpen availability; fair win probability; liquidity gate |
| Run line / spread | Kalshi spread threshold; starters; lineup quality; run differential estimate; bullpen/rest context; home/away batting context; liquidity gate |
| Game total | Kalshi total threshold; starters; lineups or projected lineups; bullpen state; park/weather/roof state; fair total distribution; liquidity gate |
| YRFI / NRFI | Kalshi first-inning rules; starters; top-of-order projection or confirmed lineup; pitcher first-inning risk; top-third batter quality; liquidity gate |
| Home run hitters | Player is expected/confirmed in lineup; hitter power profile; pitcher HR/pitch profile; handedness and park/weather; exact Kalshi prop availability; liquidity gate |
| Pitcher strikeouts | Probable/confirmed starter; K% and whiff profile; opponent lineup K%; workload/pitch count; exact Kalshi threshold; liquidity gate |

## Signal Hierarchy By Market Type

Use higher-ranked signals first. Lower-ranked signals cannot override a failed hard gate.

| Market type | Signal hierarchy |
|---|---|
| Moneyline / game winner | Kalshi rules and price > official starters/status > lineup strength > starter/bullpen model > weather/park > market history |
| Run line / spread | Kalshi threshold > official starters/status > run differential distribution > bullpen leverage/rest > home/away ninth-inning context > weather/park |
| Game total | Kalshi threshold > official starters/status > weather/roof/park if material > lineup quality > bullpen workload > Statcast contact profile |
| YRFI / NRFI | Kalshi rules > starters > confirmed top three hitters > pitcher first-inning profile > handedness matchup > weather/park |
| Home run hitters | Confirmed lineup/player status > exact Kalshi prop > hitter barrel/hard-hit/fly-ball profile > pitcher pitch/HR profile > handedness > park/weather |
| Pitcher strikeouts | Confirmed starter > exact Kalshi threshold > pitcher K/whiff/pitch mix > opponent lineup K% > workload/rest > umpire only if from a verified source |

## Confidence Scoring And Automatic Caps

Score confidence from 0 to 100 after all evidence is gathered.

Suggested components:

| Component | Points |
|---|---:|
| Source completeness and agreement | 20 |
| Baseball model/evidence strength | 25 |
| Exact Kalshi contract match | 15 |
| Price, spread, depth, and freshness | 15 |
| Timing stability before first pitch | 15 |
| Correlation and exposure safety | 10 |

Final confidence bands:

| Score | Output behavior |
|---:|---|
| 80-100 | `CLEAR_PICK` allowed only if availability and liquidity gates pass |
| 70-79 | `CLEAR_PICK` allowed only with clean source agreement and strong edge; otherwise `LEAN` |
| 60-69 | `LEAN` or `WATCH_FOR_LISTING`; no clear trade |
| 40-59 | `PASS` unless blocked by missing source |
| 0-39 | `PASS` or `BLOCKED` |

Sizing rules:

- Apply quarter-Kelly production sizing without exception.
- Cap every order at the smallest of quarter-Kelly size, bankroll cap, market-type cap, per-game cap, and 10% of visible executable depth.
- Default maximum stake caps:
  - Moneyline/game winner: 1.00% bankroll.
  - Run line/spread: 0.75% bankroll.
  - Game total: 0.75% bankroll.
  - YRFI/NRFI: 0.50% bankroll.
  - Pitcher strikeouts: 0.50% bankroll.
  - Home run hitters: 0.25% bankroll.
- Correlated picks in the same game share a combined game cap. For example, a game total over, YRFI, and HR hitter in the same weather-driven setup cannot each use full independent caps.
- If liquidity cap is lower than the minimum useful order size, mark `NOT_TRADEABLE`.

## No-Pick Conditions

Return `PASS`, `BLOCKED`, `WATCH_FOR_LISTING`, or `NOT_TRADEABLE` instead of forcing a pick when:

- the exact Kalshi market is not listed and there is no separate watch instruction;
- a prop has research edge but is not offered on Kalshi yet (`WATCH_FOR_LISTING`, not `PASS`);
- rules or settlement wording are ambiguous;
- official starter, lineup, game status, or weather data is missing when material;
- a listed market has wide spread, weak depth, stale price, or one-sided liquidity;
- the fair edge disappears after crossing the spread;
- the signal depends on unverified social media, random prediction blogs, or sportsbook availability;
- source conflict cannot be resolved before first pitch;
- exposure caps would be breached;
- the market is too close to first pitch or close time for reliable execution.

## Output Files

Write all daily outputs under:

`state/mlb/YYYY-MM-DD/`

Required files:

| File | Purpose |
|---|---|
| `slate_manifest.json` | Kalshi and MLB slate inventory, game mappings, listed market types, source timestamps |
| `source_registry.json` | Daily source health, access paths, backup use, reliability, limitations |
| `picks.json` | Machine-readable pick sheet with statuses, probabilities, prices, edges, caps, and reasons |
| `daily-baseball-guide.md` | Human-readable daily guide for review, not publication by default |
| `run_log.md` | Chronological log of source checks, decisions, rechecks, blocked items, and changes |

## Daily Baseball Guide Format

Use this structure for `daily-baseball-guide.md`:

```markdown
# Daily Baseball Guide - YYYY-MM-DD

## Source Health
- Kalshi:
- MLB official:
- Baseball Savant:
- Weather:
- Optional price sanity:

## Slate Overview
| Game | Start | Kalshi markets listed | MLB status | Weather note | Source status |

## Clear Picks
| Market | Side | Fair | Kalshi price | Edge | Confidence | Max entry | Cap | Why |

## Watch For Listing
| Player/market | Game | Research edge | Missing Kalshi prop | Recheck time | Trigger |

## Not Tradeable
| Market | Reason | Spread | Depth | Last update | Recheck |

## Leans
| Market | Why interesting | Missing evidence | Needed trigger |

## Passes
| Market | Primary reason |

## Blocked
| Market | Missing source | Next action |

## Run Notes
- No live picks placed.
- No trades placed.
- Source limitations:
```

## Machine-Readable Pick Sheet Schema

Use this structure for `picks.json`. Add fields only when they are populated from sources.

```json
{
  "run_date": "YYYY-MM-DD",
  "generated_at_utc": "YYYY-MM-DDTHH:MM:SSZ",
  "source_health": {
    "kalshi": "ok|degraded|blocked",
    "mlb_official": "ok|degraded|blocked",
    "baseball_savant": "ok|degraded|blocked",
    "weather": "ok|degraded|blocked",
    "optional_price_sanity": "ok|skipped|degraded|blocked"
  },
  "picks": [
    {
      "id": "YYYYMMDD_GAMEPK_MARKET_PLAYER_OR_SIDE",
      "game_pk": 0,
      "game": "Away Team at Home Team",
      "start_time_utc": "YYYY-MM-DDTHH:MM:SSZ",
      "market_lane": "moneyline|run_line|game_total|yrfi_nrfi|home_run_hitter|pitcher_strikeouts",
      "kalshi_event_ticker": null,
      "kalshi_market_ticker": null,
      "kalshi_contract_name": null,
      "research_status": "RESEARCH_EDGE|LEAN|PASS|BLOCKED",
      "availability_status": "KALSHI_AVAILABLE|NOT_OFFERED_NOW|null",
      "tradeability_status": "PASS|FAIL|NOT_APPLICABLE",
      "final_status": "CLEAR_PICK|LEAN|PASS|WATCH_FOR_LISTING|NOT_TRADEABLE|BLOCKED",
      "side": "YES|NO|OVER|UNDER|TEAM|PLAYER|null",
      "threshold": null,
      "fair_probability": null,
      "market_probability": null,
      "edge_probability_points": null,
      "yes_bid": null,
      "yes_ask": null,
      "spread": null,
      "last_trade_ts": null,
      "visible_depth_at_entry": null,
      "confidence": null,
      "quarter_kelly_fraction": null,
      "max_entry_price": null,
      "max_size_bankroll_pct": null,
      "primary_evidence": [],
      "risk_notes": [],
      "next_recheck_utc": null,
      "source_urls": []
    }
  ]
}
```

## Short Notification Summary Format

Use this for Slack, console, or a brief operator handoff:

```text
MLB Kalshi YYYY-MM-DD HH:MM UTC
Source health: Kalshi [ok/degraded], MLB [ok/degraded], Savant [ok/degraded], Weather [ok/degraded]
Board: CLEAR_PICK n | WATCH_FOR_LISTING n | NOT_TRADEABLE n | LEAN n | PASS n | BLOCKED n
Top clear pick: [market or none] | fair [x%] | Kalshi [x%] | edge [x pp] | cap [x% bankroll]
Watch props: [count and next recheck time]
Main blocks: [short reason]
No trades placed by this workflow.
```

## Standard Prediction Packet Template

Create one packet per candidate market.

```markdown
## Prediction Packet

Market:
Game:
Market lane:
Kalshi event/market ticker:
Kalshi rules summary:
MLB gamePk:
Start time:

### Research View
Research status:
Fair probability:
Primary signals:
Counter-signals:
Required evidence present:
Missing evidence:

### Kalshi Availability View
Availability status:
Exact contract match:
Bid:
Ask:
Spread:
Depth:
Last trade/update:
Liquidity gate result:

### Decision View
Final status:
Confidence:
Quarter-Kelly size:
Applied caps:
Max entry:
Why:
How it loses:
Next recheck:
```

## Optional Structure Test With Today's Kalshi Calendar

Run this only when today's Kalshi baseball calendar is accessible. Do not make live picks.

Purpose:

- show available games;
- show available market types;
- show missing prop handling;
- show `WATCH_FOR_LISTING` handling;
- show `NOT_TRADEABLE` handling.

Test steps:

1. Load today's Kalshi baseball calendar.
2. Record game inventory and market types into a temporary structure-test section of `run_log.md`.
3. Select one listed market and run only the availability/tradeability classification. Do not produce a pick recommendation.
4. Select one research-edge prop candidate from the baseball framework. If it is not listed on Kalshi, classify it as `WATCH_FOR_LISTING`.
5. Select one listed but intentionally thin/wide market, if present, and classify it as `NOT_TRADEABLE`.
6. Confirm no output says a sportsbook-only prop is Kalshi-available.
7. Confirm no output claims a missing morning prop is unavailable forever.

If the calendar is inaccessible, record the access failure and skip the structure test. Do not invent example games or props.

## Source Links

- Kalshi baseball calendar: `https://kalshi.com/calendar/sports/baseball`
- Kalshi API docs: `https://docs.kalshi.com/getting_started/api_environments`
- Kalshi market API docs: `https://docs.kalshi.com/python-sdk/api/MarketsApi`
- Kalshi events API docs: `https://docs.kalshi.com/python-sdk/api/EventsApi`
- MLB Stats API schedule endpoint: `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD`
- Baseball Savant Statcast Search: `https://baseballsavant.mlb.com/en/statcast_search`
- NWS API docs: `https://www.weather.gov/documentation/services-web-api`
