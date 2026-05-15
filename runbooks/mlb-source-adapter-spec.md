# MLB Source Adapter Spec

Use this spec to define how the daily MLB workflow repeatedly accesses, normalizes, caches, validates, and reports the limited source stack.

Source of truth:

- `runbooks/mlb-prediction-process.md`
- `runbooks/mlb-market-router-spec.md`
- `runbooks/mlb-output-schemas.md`

This is an operator adapter spec only. Do not edit `src/`, create cron jobs, make live picks, or place trades from this document.

## Objective

Each adapter must produce stable, timestamped records that can be written into:

- `state/mlb/YYYY-MM-DD/slate_manifest.json`
- `state/mlb/YYYY-MM-DD/source_registry.json`
- `state/mlb/YYYY-MM-DD/picks.json`
- `state/mlb/YYYY-MM-DD/run_log.md`
- `state/mlb/YYYY-MM-DD/daily-baseball-guide.md`

Keep the source stack small:

1. Kalshi calendar / Trade API
2. Official MLB Stats API / MLB Gameday
3. Baseball Savant / Statcast
4. National Weather Service API
5. Optional price sanity source

Do not add more core sources unless the run log states why one of the five sources cannot satisfy a required data need.

## Shared Adapter Contract

Every adapter returns this envelope:

```json
{
  "source_id": "kalshi|mlb_official|baseball_savant|weather|optional_price_sanity",
  "status": "ok|degraded|blocked|skipped",
  "checked_at_utc": "YYYY-MM-DDTHH:MM:SSZ",
  "cache_key": "string",
  "cache_path": "state/mlb/YYYY-MM-DD/cache/source_id/file.json",
  "required": true,
  "records": [],
  "warnings": [],
  "errors": [],
  "source_urls": []
}
```

Status meanings:

- `ok`: source responded and required fields validated.
- `degraded`: source responded partially, had stale/missing optional fields, or required fallback/manual extraction.
- `blocked`: required data could not be retrieved or validated.
- `skipped`: optional source was intentionally not used.

Timestamp rules:

- Every adapter result requires `checked_at_utc`.
- Every cached raw response requires `fetched_at_utc`.
- Every normalized record requires `normalized_at_utc`.
- A source timestamp must be copied into `slate_manifest.json.source_timestamps` when the source contributes to the slate.
- `source_registry.json.sources[].last_checked_utc` must match the latest adapter check for that source.

Cache rules:

- Cache raw responses under `state/mlb/YYYY-MM-DD/cache/<source_id>/raw/`.
- Cache normalized records under `state/mlb/YYYY-MM-DD/cache/<source_id>/normalized/`.
- Cache filenames must include the run date, source id, logical query, and UTC fetch time.
- Do not overwrite raw cache files. Write a new file on each refresh.
- Normalized cache files may be superseded, but the run log must record the old and new filenames.
- Do not cache credentials, session cookies, or private account state.

Validation rules:

- Required fields must be present before `status: "ok"`.
- Optional fields may be null if the source did not provide them.
- If a required source is `blocked`, affected picks cannot be `CLEAR_PICK`.
- If an adapter produces contradictory records, use source conflict rules before writing picks.
- No adapter may infer Kalshi tradability from sportsbooks or non-Kalshi sources.

## Adapter: Kalshi Calendar / Trade API

Purpose:

- Discover tradable MLB markets.
- Capture exact listed contracts, rules, prices, bid/ask, liquidity, order books, close time, and market status.
- Determine whether an exact prop is `KALSHI_AVAILABLE` or `NOT_OFFERED_NOW`.

Access method:

- Primary: `https://kalshi.com/calendar/sports/baseball`.
- API fallback: Kalshi Trade API events, markets, market details, order book, trades, and candlesticks where available.
- If the calendar returns HTTP 429 or a challenge page, record the calendar issue and continue with the Trade API.

Required fields:

- `event_ticker`
- `event_title`
- `market_ticker`
- `market_title`
- `contract_title`
- `rules_summary`
- `market_status`
- `close_time_utc`
- `yes_bid`
- `yes_ask`
- `spread`
- `last_trade_ts`
- `orderbook_depth`
- `volume` or equivalent activity field when available
- `source_url`
- `checked_at_utc`

Optional fields:

- `series_ticker`
- `open_interest`
- `candlesticks`
- `last_price`
- `liquidity_score`
- `settlement_source`
- `fees_or_fee_notes`

Refresh cadence:

- Morning scan.
- T-minus 120 minutes, 60 minutes, 30 minutes, 20 minutes, and 10 minutes for games with active candidates.
- Immediately after lineups post for home run hitter and pitcher strikeout candidates.
- Any time a `WATCH_FOR_LISTING` prop is rechecked.

Cache policy:

- Raw calendar/API responses: keep every fetch.
- Normalized market inventory: write one snapshot per refresh.
- Order books: cache per market ticker and fetch time.
- Trades/candlesticks: cache only when used for stale-price or historical review.

Failure handling:

- Calendar HTTP 429/challenge-gated: set Kalshi source `status: "degraded"` if API fallback succeeds; write the 429 note to `run_log.md`.
- Calendar and API unavailable: set `status: "blocked"` and mark affected markets `BLOCKED`.
- Exact prop missing: set `availability_status: "NOT_OFFERED_NOW"`; if research status is `RESEARCH_EDGE`, final status is `WATCH_FOR_LISTING`.
- Listed market with wide spread, weak depth, stale price, or unclear rules: keep `availability_status: "KALSHI_AVAILABLE"` but set `tradeability_status: "FAIL"` and final status `NOT_TRADEABLE`.

Source health status mapping:

- `ok`: exact market inventory, rules, prices, and order books validated.
- `degraded`: UI blocked but API works, or non-critical fields such as candlesticks are unavailable.
- `blocked`: no reliable Kalshi market/rules/price data.
- `skipped`: never valid for required Kalshi intake.

Output fields:

- `slate_manifest.json`: `kalshi_calendar_url`, `source_timestamps.kalshi`, `games[].kalshi_events`, `games[].listed_market_lanes`, `router_results`, `unmatched_or_excluded_markets`.
- `source_registry.json`: Kalshi source row, status, access method, URLs, limitations, source gaps.
- `picks.json`: `kalshi_event_ticker`, `kalshi_market_ticker`, `kalshi_contract_name`, `availability_status`, `tradeability_status`, `market_probability`, `yes_bid`, `yes_ask`, `spread`, `last_trade_ts`, `visible_depth_at_entry`, `source_urls`.
- `run_log.md`: calendar/API access, 429 fallback, market inventory changes, prop rechecks, liquidity failures.
- `daily-baseball-guide.md`: listed markets, `Watch For Listing`, `Not Tradeable`, source health.

Placeholder normalized record:

```json
{
  "source_id": "kalshi",
  "checked_at_utc": "2026-06-01T14:00:00Z",
  "event_ticker": "KXMLB-PLACEHOLDER-001",
  "market_ticker": "KXMLB-PLACEHOLDER-001-WINNER",
  "market_title": "Will the Alpha City Aces beat the Beta Town Bears?",
  "market_lane": "moneyline",
  "market_status": "open",
  "yes_bid": 0.48,
  "yes_ask": 0.53,
  "spread": 0.05,
  "last_trade_ts": "2026-06-01T13:58:00Z",
  "orderbook_depth": 250
}
```

## Adapter: Official MLB Stats API / MLB Gameday

Purpose:

- Provide official game schedule, game IDs, probable pitchers, confirmed lineups, game status, box scores, starters, and final results.
- Map Kalshi events to MLB `gamePk` values.

Access method:

- Schedule: `statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher,team`.
- Live game data: `statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live`.
- Box score: `statsapi.mlb.com/api/v1/game/{gamePk}/boxscore`.
- Backup: MLB.com official game pages or probable pitcher pages, recorded in `run_log.md`.

Required fields:

- `game_pk`
- `game_date`
- `start_time_utc`
- `away_team`
- `home_team`
- `mlb_status`
- `probable_pitchers.away`
- `probable_pitchers.home`
- `source_url`
- `checked_at_utc`

Optional fields:

- `confirmed_lineups`
- `batting_order`
- `starting_pitchers_confirmed`
- `venue_id`
- `venue_name`
- `box_score`
- `game_status_detail`
- `postponement_or_delay_note`

Refresh cadence:

- Morning scan.
- T-minus 120, 60, 20 minutes.
- Immediately after lineup confirmation.
- After delay, postponement, starter change, or game status change.
- Post-game for result review and settlement support.

Cache policy:

- Cache schedule once per scan.
- Cache live feed per `gamePk` and fetch time.
- Cache box score after final status.
- Never overwrite raw official responses.

Failure handling:

- Schedule unavailable: set `status: "blocked"` and block game mapping.
- Probable pitcher missing: mark starter-dependent lanes `BLOCKED` until refreshed.
- Confirmed lineup missing: YRFI/NRFI and player props may remain `LEAN`, `WATCH_FOR_LISTING`, or `BLOCKED` depending on materiality.
- MLB status conflict with Kalshi open market: log conflict; do not clear a pick until status reconciles.

Source health status mapping:

- `ok`: schedule, `gamePk`, teams, status, and probable pitchers validated.
- `degraded`: game exists but lineup/starter confirmation is incomplete.
- `blocked`: schedule or game mapping cannot be retrieved.
- `skipped`: never valid for official MLB data.

Output fields:

- `slate_manifest.json`: `games[].game_pk`, `game`, `game_date`, `start_time_utc`, `teams`, `mlb_status`, `probable_pitchers`.
- `source_registry.json`: MLB source row, status, URLs, source gaps.
- `picks.json`: `game_pk`, `game`, `start_time_utc`, evidence notes, source URLs, blocked reasons.
- `run_log.md`: schedule pulls, mapping decisions, starter/lineup changes, status changes.
- `daily-baseball-guide.md`: slate overview, MLB status, blocked source notes.

Placeholder normalized record:

```json
{
  "source_id": "mlb_official",
  "checked_at_utc": "2026-06-01T14:01:00Z",
  "game_pk": 100001,
  "game": "Alpha City Aces at Beta Town Bears",
  "start_time_utc": "2026-06-01T23:05:00Z",
  "mlb_status": "Preview",
  "probable_pitchers": {
    "away": "Placeholder Pitcher A",
    "home": "Placeholder Pitcher B"
  }
}
```

## Adapter: Baseball Savant / Statcast

Purpose:

- Provide repeatable player and matchup skill signals for batter and pitcher analysis.
- Support K%, barrel rate, hard-hit rate, HR profile, batted-ball shape, pitch mix, and pitch-level matchup checks.

Access method:

- Baseball Savant Statcast Search UI and CSV export URLs.
- Use small reproducible query URLs and save them in `run_log.md`.
- Backup: FanGraphs leaderboard CSV only when Savant is unavailable and the backup URL is recorded.

Required fields:

- `query_url`
- `query_type`
- `player_name` or `team_name`
- `season_or_date_range`
- `sample_size`
- `checked_at_utc`
- market-lane-specific metrics used by the model

Required lane metrics:

- Home run hitters: `barrel_rate`, `hard_hit_rate`, `fly_ball_or_launch_profile`, `handedness`, and pitcher HR/pitch profile when available.
- Pitcher strikeouts: `k_rate`, `whiff_or_swinging_strike_proxy`, `pitch_mix`, opponent strikeout profile when available.
- Game totals/YRFI/NRFI: starter contact profile, top-of-order power/contact signals, and run-environment-relevant batted-ball indicators.

Optional fields:

- `expected_stats`
- `recent_form_window`
- `pitch_type_matchup`
- `platoon_split`
- `park_adjusted_note`
- `data_quality_note`

Refresh cadence:

- Morning scan for baseline metrics.
- Refresh after confirmed lineups when player/order changes matter.
- No need to refetch static season-to-date metrics every pre-game interval unless query inputs changed.

Cache policy:

- Cache raw CSV downloads with query URL and fetch time.
- Cache normalized metric tables per lane and date.
- Keep query URLs stable and small enough to re-run.

Failure handling:

- Savant unavailable and no backup: set `status: "blocked"` for affected player-prop and contact-profile lanes.
- Partial metric availability: set `status: "degraded"` and list missing metrics.
- Small sample or missing player match: mark affected candidate `BLOCKED` or `LEAN`; do not force a pick.
- Backup source used: record in `source_registry.json` and `run_log.md`.

Source health status mapping:

- `ok`: required lane metrics returned and sample-size notes are recorded.
- `degraded`: partial metrics, stale query, backup source, or limited sample.
- `blocked`: required metrics unavailable.
- `skipped`: invalid for required Statcast checks.

Output fields:

- `slate_manifest.json`: source timestamp and notes when Statcast affects slate readiness.
- `source_registry.json`: Baseball Savant source row, backup use, limitations, source gaps.
- `picks.json`: `fair_probability`, `edge_probability_points`, `confidence`, `primary_evidence`, `risk_notes`, `source_urls`.
- `run_log.md`: query URLs, metric refreshes, backup use, data gaps.
- `daily-baseball-guide.md`: evidence summaries, leans, blocked items, run notes.

Placeholder normalized record:

```json
{
  "source_id": "baseball_savant",
  "checked_at_utc": "2026-06-01T14:03:00Z",
  "query_type": "home_run_hitter_profile",
  "player_name": "Placeholder Player",
  "sample_size": 120,
  "barrel_rate": 0.14,
  "hard_hit_rate": 0.48,
  "handedness": "R",
  "data_quality_note": "Placeholder example only"
}
```

## Adapter: National Weather Service API

Purpose:

- Provide outdoor game weather: wind, temperature, precipitation, rain/postponement risk, and weather-sensitive run environment.

Access method:

- `api.weather.gov/points/{lat},{lon}` to resolve grid metadata.
- `api.weather.gov/gridpoints/{office}/{x},{y}/forecast/hourly` for hourly forecast.
- Backup: Weather.gov forecast page for the same stadium point, recorded in `run_log.md`.
- Stadium coordinates come from a maintained operator venue map. The venue map is reference data, not a new daily source.

Required fields:

- `game_pk`
- `venue_name`
- `lat`
- `lon`
- `forecast_hour_utc`
- `temperature`
- `wind_speed`
- `wind_direction`
- `precipitation_probability`
- `short_forecast`
- `checked_at_utc`

Optional fields:

- `roof_status`
- `humidity`
- `wind_gust`
- `rain_delay_risk`
- `run_environment_note`
- `manual_weather_note`

Refresh cadence:

- Morning scan.
- T-minus 120, 60, and 20 minutes for outdoor parks.
- After meaningful forecast, delay, postponement, or roof-state update.
- Skip weather modeling for fixed indoor parks unless game status/weather risk is relevant.

Cache policy:

- Cache point lookup once per venue per run date.
- Cache hourly forecast per stadium and fetch time.
- Preserve raw forecast responses.

Failure handling:

- Outdoor weather unavailable: set `status: "blocked"` for weather-sensitive totals, YRFI/NRFI, and HR candidates.
- Indoor/fixed-roof game: set weather adapter `status: "ok"` or `skipped` for that game with a roof note.
- Retractable roof unknown and weather material: mark affected markets `BLOCKED` until clarified.
- NWS API partial response: set `status: "degraded"` and list missing fields.

Source health status mapping:

- `ok`: required game-window forecast fields validated or weather not material with documented roof/indoor note.
- `degraded`: partial forecast, backup weather.gov page, or uncertain roof note.
- `blocked`: material weather data unavailable.
- `skipped`: optional per-game skip for fixed indoor/weather-insensitive context, not for the whole source if other outdoor games need weather.

Output fields:

- `slate_manifest.json`: `games[].weather_status`, source timestamp, weather notes.
- `source_registry.json`: Weather source row, backup use, limitations, source gaps.
- `picks.json`: weather evidence in `primary_evidence`, blocked/weather risks in `risk_notes`.
- `run_log.md`: forecast fetches, roof notes, weather changes, blocked weather-sensitive markets.
- `daily-baseball-guide.md`: slate weather note, source health, blocked items.

Placeholder normalized record:

```json
{
  "source_id": "weather",
  "checked_at_utc": "2026-06-01T14:05:00Z",
  "game_pk": 100001,
  "venue_name": "Placeholder Park",
  "forecast_hour_utc": "2026-06-01T23:00:00Z",
  "temperature": 72,
  "wind_speed": "9 mph",
  "wind_direction": "out to left",
  "precipitation_probability": 15,
  "short_forecast": "Partly cloudy"
}
```

## Adapter: Optional Price Sanity Source

Purpose:

- Provide an optional external price sanity check only when a reliable, public, no-login source is easy to access.
- This source never proves Kalshi availability and never blocks the workflow if unavailable.

Access method:

- Manual same-day URL recorded in `run_log.md`.
- No login, private account, or random prediction-blog dependency.
- Do not scrape or store terms-restricted data if the source disallows it.

Required fields:

- None when skipped.
- If used: `source_url`, `checked_at_utc`, `market_description`, `observed_price_or_range`, `limitations`.

Optional fields:

- `book_count`
- `consensus_note`
- `staleness_note`
- `mapping_confidence`

Refresh cadence:

- Optional morning scan.
- Optional pre-game refresh only if already used and easy to repeat.
- Never delay required workflow outputs for this source.

Cache policy:

- Cache only the URL, timestamp, and normalized sanity note.
- Do not cache private pages, credentials, or account-specific views.

Failure handling:

- No reliable source available: `status: "skipped"`.
- Source unavailable after use: `status: "degraded"` and continue.
- Price conflicts with Kalshi: log as a sanity warning only; Kalshi remains tradability source.

Source health status mapping:

- `ok`: optional source used and recorded.
- `degraded`: optional source partially available or stale.
- `blocked`: optional source attempted but inaccessible; do not block picks.
- `skipped`: default when not used.

Output fields:

- `source_registry.json`: optional source row with `required: false`.
- `run_log.md`: optional source use or skip reason.
- `picks.json`: optional sanity note in `risk_notes` only when used.
- `daily-baseball-guide.md`: optional price sanity source health line.
- `slate_manifest.json`: no required output.

Placeholder normalized record:

```json
{
  "source_id": "optional_price_sanity",
  "status": "skipped",
  "checked_at_utc": "2026-06-01T14:06:00Z",
  "required": false,
  "records": [],
  "warnings": ["No optional public no-login price sanity source used"]
}
```

## Source Conflict Rules

Use this hierarchy:

1. Kalshi controls tradability, listed contracts, rules, bid/ask, liquidity, and order book state.
2. Official MLB controls schedule, game identity, probable/confirmed starters, lineups, game status, box scores, and final game state.
3. Baseball Savant controls Statcast skill signals.
4. NWS controls outdoor weather forecasts.
5. Optional price sanity source is advisory only.

Conflict handling:

- If Kalshi lists a market but MLB cannot confirm the game or player context, keep the Kalshi record but mark affected candidates `BLOCKED`.
- If a sportsbook or optional price source lists a prop that Kalshi does not list, set Kalshi availability to `NOT_OFFERED_NOW`; do not call it tradeable.
- If MLB changes starter or lineup after research, invalidate affected player props and rerun evidence before final status.
- If NWS weather and manual roof notes conflict, mark weather-sensitive markets `BLOCKED` until the roof/weather state is clarified.
- If router output is `AMBIGUOUS`, do not write the item to `picks.json`; keep it in `slate_manifest.json.router_results` and `run_log.md`.

## Timestamp Requirements

Use UTC timestamps only.

Required timestamp fields:

- Adapter envelope: `checked_at_utc`
- Raw cache file metadata: `fetched_at_utc`
- Normalized record metadata: `normalized_at_utc`
- `slate_manifest.json`: `generated_at_utc`, `source_timestamps`
- `source_registry.json`: `generated_at_utc`, `sources[].last_checked_utc`
- `picks.json`: `generated_at_utc`, `last_trade_ts`, `next_recheck_utc` when applicable
- `run_log.md`: every source check, recheck, status change, and output write

Freshness rules:

- Kalshi last trade/update is stale if older than 30 minutes in the morning or older than 10 minutes inside the final hour before first pitch.
- Official MLB starters and lineups must be refreshed after lineup confirmation.
- Weather must be refreshed near game time for outdoor parks.
- Static Statcast season metrics can remain valid across same-day refreshes unless player pool, lineup, or query inputs change.

## Output Write Mapping

Adapter results must write only the fields owned by that source.

| Source | `slate_manifest.json` | `source_registry.json` | `picks.json` | `run_log.md` | `daily-baseball-guide.md` |
|---|---|---|---|---|---|
| Kalshi | market inventory, listed lanes, router input, source timestamp | source row, status, gaps | Kalshi tickers, contract, availability, tradeability, price, liquidity | access, 429 fallback, prop rechecks, liquidity failures | source health, listed markets, watch/not tradeable |
| MLB official | game mapping, teams, start, status, pitchers | source row, gaps | game fields, blocked official-data notes | schedule, gamePk mapping, lineup/starter changes | slate overview, blocked official gaps |
| Baseball Savant | readiness notes and timestamp | source row, backup/gaps | evidence, fair-probability inputs, confidence notes | query URLs, metric refreshes | evidence summaries, leans/blocked |
| Weather | weather status and notes | source row, gaps | weather evidence and risk notes | forecast pulls, roof/weather changes | weather note, blocked weather items |
| Optional price sanity | none required | optional source row | optional risk note only | use/skip reason | source health line |

## Failure-Handling Summary

Missing Kalshi prop:

- Kalshi adapter writes `availability_status: "NOT_OFFERED_NOW"`.
- If baseball research status is `RESEARCH_EDGE`, final status is `WATCH_FOR_LISTING`.
- Write to `daily-baseball-guide.md` under `Watch For Listing`.
- Add a recheck time to `picks.json.next_recheck_utc` and `run_log.md`.

Weak liquidity:

- Kalshi adapter writes `availability_status: "KALSHI_AVAILABLE"` and `tradeability_status: "FAIL"`.
- Final status is `NOT_TRADEABLE`.
- Record spread, depth, last update, and failed gate in `picks.json`, `run_log.md`, and guide.

Source outage:

- Required source outage sets adapter `status: "blocked"` or `degraded`.
- Add a `source_gaps` entry.
- Affected candidates cannot be `CLEAR_PICK`.
- If the missing source is material, final status is `BLOCKED`.

Ambiguous router result:

- Keep result in `slate_manifest.json.router_results`.
- Do not add item to `picks.json`.
- Log needed clarification in `run_log.md`.

Kalshi calendar HTTP 429/challenge:

- Use Trade API fallback.
- If fallback succeeds, Kalshi status is `degraded`, not `blocked`.
- If fallback fails, Kalshi status is `blocked` and affected markets are `BLOCKED`.

## Non-Goals

- No live picks.
- No trade execution.
- No cron jobs.
- No runtime implementation.
- No new core daily sources unless documented in `run_log.md`.
- No edits outside this runbook spec.
