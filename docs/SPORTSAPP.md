# SPORTSAPP.md — Sports Prediction Pipeline

## Overview

Three pipeline shells handle all sports markets. Resolution is outcome-based (score, result, stat), not text-based — separate from `mentionsApp`.

```
gameApp       (sport="NFL"|"NCAAFB"|"NBA"|"NCAABB"|"MLB"|"NCAAB")
propApp       (propType="HR"|"K"|"playerPoints"|"playerReb")
fightAndRacingApp  (type="UFC"|"NASCAR")
```

**Why this split:** Pythagorean win model, possession/scoring distribution, injury gate, and Kelly sizing are identical across gameApp sports — only efficiency metrics and exponents differ. Player props need distribution modeling at batter/pitcher/player level. UFC and NASCAR share no score/clock analog with team sports but share enough infra to use one shell for V1.

---

## Agents

Three dedicated agents operate the sports pipeline:

### sports-pre-game (Pre-Game Planner)
- Calls `sports_calendar_router` to identify active sports for the day
- Routes each active sport to its dedicated modeling skill
- Constructs fair probability estimates for relevant markets
- Compares model probabilities to market-implied probabilities
- Evaluates EV and applies Kelly fractional sizing
- Logs all opportunities (bet and no-bet)
- Outputs structured bet recommendations with rationale

### sports-live (Live / In-Play Executor)
- Initializes from pre-game watchlist
- Polls live game/race/fight state at configured interval (default: 20s)
- Updates fair probabilities from live data (scores, clock, events)
- Enforces higher EV threshold than pre-game phase (default: 5%)
- Checks exposure caps and drawdown limits before execution
- Pauses when drawdown exceeds threshold (default: 15%)
- Logs all decisions with live snapshots

### sports-review (Review / Analytics)
- Captures placed odds and closing prices
- Calculates CLV by bet and aggregated segments
- Measures probability calibration over time windows
- Groups performance by league, phase, market subtype, and timing
- Surfaces threshold and configuration adjustment recommendations

### sports-calendar-router (Helper)
- Determines which sports have scheduled events on a given date
- Filters to preferred sport list with priority ordering
- Returns active sports list to pre-game and live agents

---

## Workflows

### Pre-Game Planning
1. `sports_calendar_router` → active sports list
2. Pull schedules and historical stats per active league
3. Route each sport to dedicated modeling skill
4. Build fair probability estimates
5. Compare to market-implied probabilities
6. EV calculator → evaluate edge per market
7. Kelly fractional sizing with configured caps
8. Log opportunities; output structured recommendations

### Live / In-Play Execution
1. Load watchlist from pre-game planner
2. Poll live state at interval
3. Update fair probabilities from live data
4. Compare live model to current market prices
5. Check EV threshold (higher than pre-game)
6. Check exposure caps and drawdown limits
7. Execute or skip; log decision with live snapshot

### Futures Re-Evaluation
- Operates on long-horizon markets separately from live markets
- Updates NASCAR series championship probabilities after each race
- Refreshes lower-frequency than live polling
- Uses season-to-date stats and remaining schedule
- Re-prices based on updated driver points and market conditions

### Advanced Information-Driven
- Triggers event-driven refresh on injury / lineup / weather changes
- Gates trades on confirmation of critical availability info
- `injury_news_gate`: delays recommendations under uncertainty
- `consensus_price_engine`: compares across venues, flags stale prices
- Blocks trades when market has already moved post-news
- Applies confidence weighting to Kelly sizes

### Post-Bet Analysis
1. Capture entry odds and market-implied probability at entry
2. Fetch closing prices near event lock
3. Calculate CLV by bet and segment
4. Measure calibration over rolling time windows
5. Group by league, phase, market subtype, timing
6. Output parameter adjustment recommendations

---

## Sports and Market Types

### gameApp sports

**NFL / NCAA Football** (`sport="NFL"|"NCAAFB"`)
- Markets: moneyline, spread, total
- Inputs: EPA, efficiency ratings, QB status, injuries, weather
- Live inputs: score, clock, possession state, drive context
- Output: fair win probability, fair spread/total, injury-adjusted edge, confidence

**NBA / NCAA Men's Basketball** (`sport="NBA"|"NCAABB"`)
- Markets: moneyline, spread, total
- Inputs: pace, efficiency, rest, travel, lineup availability
- Live inputs: score state, foul trouble, possession pace, rotation stress
- Output: fair probabilities, schedule-adjusted edges, late-game volatility flags

**MLB / NCAA Baseball** (`sport="MLB"|"NCAAB"`)
- Markets: moneyline, total
- Inputs: starter quality, lineup handedness, weather, park context, bullpen state
- Output: fair prices, confidence levels

### propApp types

**Home Run Props** (`propType="HR"`)
- Inputs: barrel rate, hard-hit rate, launch angle, power form, pitcher HR allowance, park factor, wind
- Signal taxonomy: power signal, pitcher signal, park signal, weather signal

**Pitcher Strikeout Props** (`propType="K"`)
- Inputs: K rate, K/BF, swinging-strike rate, CSW%, batters-faced projection, opponent K profile, game context
- Output: fair over/under probability, workload adjustment

**Player Props** (`propType="playerPoints"|"playerReb"`)
- Distribution model at player level, not team level
- Separate from gameApp team-outcome modeling

### fightAndRacingApp types

**UFC** (`type="UFC"`)
- Markets: moneyline, method-of-victory
- Inputs: striking volume/defense, takedown efficiency, grappling, style matchup, form context
- Live inputs: round state, knockdowns, control time, striking/grappling balance observed
- Output: fight win probability, style-matchup edge, uncertainty discount for thin data

**NASCAR** (`type="NASCAR"` — Cup, Trucks, O'Reilly)
- Race markets: winner, top-3/podium
- Series futures: championship winner (Kalshi markets)
- Race inputs: practice speed, multi-lap averages, tire falloff, qualifying context, track history, season form
- Live inputs: running order, cautions, pit strategy, lap data, stage changes
- Kalshi market IDs:
  - `KXNASCARTRUCKSERIES-NTS26` → NASCAR Trucks championship
  - `KXNASCARCUPSERIES-NCS26` → NASCAR Cup championship
  - `KXNASCARAUTOPARTSSERIES-NAPS26` → NASCAR O'Reilly championship

---

## Market Subtype Log Keys

```
nfl_moneyline, nfl_spread, nfl_total
ncaa_fb_moneyline, ncaa_fb_spread, ncaa_fb_total
nba_moneyline, nba_spread, nba_total
ncaa_bb_moneyline, ncaa_bb_spread, ncaa_bb_total
mlb_moneyline, mlb_total
mlb_home_run_prop, mlb_pitcher_strikeout_prop
ncaa_baseball_moneyline, ncaa_baseball_total
ufc_moneyline, ufc_method
nascar_race_winner, nascar_top3
nascar_series_champion
```

---

## Advanced Modules

| Module | Purpose |
|--------|---------|
| `closing_line_tracker` | Stores entry odds + closing odds; computes CLV by bet and segment; labels market state (open/midday/pre-lock/live) |
| `consensus_price_engine` | Normalizes prices across venues; builds consensus implied probability; flags stale venues |
| `injury_news_gate` | Blocks/downgrades trades until critical info confirmed; event-driven refresh on material changes |
| `monte_carlo_pricer` | Simulates event paths for pre-game/live/futures; outputs fair probability distributions and confidence intervals |
| `model_calibration_reporter` | Measures whether stated probabilities win at stated rates; reports by league/phase/market/timing |
| `no_bet_classifier` | Blocks weak/stale/late/noisy edges; integrates confidence, CLV history, and info quality flags |

---

## Shared Output Contract

Every sport-specific skill outputs standardized JSON to the trading pipeline:

```json
{
  "league": "NFL",
  "event_id": "...",
  "market_type": "spread",
  "market_subtype": "nfl_spread",
  "fair_probability": 0.54,
  "market_probability": 0.48,
  "edge": 0.06,
  "expected_value": 0.11,
  "confidence": "medium",
  "confidence_notes": "...",
  "primary_signal": "...",
  "secondary_signals": ["...", "..."],
  "no_bet_flag": false,
  "recommended_stake_cap": 0.02,
  "notes": "..."
}
```

---

## Configuration Structure

```yaml
sports_routing:
  preferred_sports: [NFL, NBA, MLB, UFC, NASCAR, NCAAFB, NCAABB, NCAAB]
  min_games_per_league: 1
  max_active_sports: 5

sports_pre_game:
  min_ev_threshold: 0.02        # 2%
  max_kelly_fraction: 0.25      # 25%
  max_bets_per_game: 3

sports_live:
  min_ev_threshold: 0.05        # 5%
  max_live_exposure_pct: 0.30   # 30%
  poll_interval_seconds: 20
  drawdown_pause_threshold: 0.15 # 15%

sports_futures:
  enabled: true
  min_ev_threshold: 0.03        # 3%
  max_kelly_fraction: 0.15      # 15%
  max_open_series_markets: 3

sports_advanced:
  clv_tracking: true
  closing_price_capture_minutes_before_lock: 10
  consensus_pricing: true
  stale_price_threshold: 0.03
  injury_gating: true
  news_reaction_mode: event_driven
  monte_carlo_run_count: 10000
  calibration_reporting: true
  no_bet_classifier: true
  market_state_labeling: true
```

---

## Data Sources

| Category | Sources |
|----------|---------|
| Schedules / Events | Sports schedules API, league-specific APIs (NFL/NBA/MLB/UFC/NASCAR), event normalization via league aliases |
| Prices | Kalshi (prediction markets incl. NASCAR series futures), Polymarket (sports contracts), optional sportsbook feeds |
| Stats — Football | EPA, efficiency ratings |
| Stats — Basketball | Pace, efficiency, rest metrics |
| Stats — Baseball | Pitcher projections, weather APIs, park factors |
| Stats — UFC | Striking/grappling databases |
| Stats — NASCAR | Practice speed data, qualifying data |

---

## Implementation Order

1. `gameApp` — football first, then basketball, then baseball
2. `propApp` — HR props, then strikeout props, then player points/reb
3. `fightAndRacingApp` — NASCAR first (active Kalshi futures), then UFC

Full spec for mentions pipeline: `docs/MENTIONSAPP.md`
