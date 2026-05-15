# MLB Market Router Spec

Use this spec to route an incoming Kalshi MLB market URL, event title, market title, or contract title into one MLB workflow lane.

Source of truth: `runbooks/mlb-prediction-process.md`.

This is an operator runbook spec only. Do not edit `src/`, create cron jobs, make live picks, or place trades from this router.

## Objective

Route each accepted Kalshi MLB market into exactly one of these six canonical lanes:

1. `moneyline`
2. `run_line`
3. `game_total`
4. `yrfi_nrfi`
5. `home_run_hitter`
6. `pitcher_strikeouts`

If the market cannot be routed with high confidence, return an ambiguous or blocked route result instead of guessing. An accepted route must have exactly one `market_lane`.

## Routing Inputs

The router may receive any combination of:

- `kalshi_url`: Kalshi event, market, or calendar URL.
- `event_title`: Kalshi event title.
- `market_title`: Kalshi market title.
- `contract_title`: Kalshi contract or side title.
- `subtitle`: Kalshi subtitle or series subtitle.
- `rules_summary`: settlement wording or rule excerpt.
- `event_ticker`: Kalshi event ticker, if known.
- `market_ticker`: Kalshi market ticker, if known.
- `teams`: parsed away/home teams, if already known.
- `player_name`: parsed player name, if already known.
- `threshold`: parsed number such as total, spread, strikeout line, or first-inning condition.
- `game_date`: event date, if known.

Minimum useful input is either a Kalshi URL that can be resolved to titles/rules, or a market title with enough wording to classify the lane.

## Normalization

Before routing:

1. Lowercase a copy of all title and rule text.
2. Preserve the original text for output evidence.
3. Normalize punctuation, extra spaces, team abbreviations, and common market shorthand.
4. Extract candidate numbers such as `+1.5`, `-1.5`, `7.5`, `over`, `under`, and strikeout thresholds.
5. Extract candidate player names only when the title or rules clearly refer to a player market.
6. Prefer Kalshi title and rules over inferred meaning from URL slugs.

## Lane Detection Rules

Evaluate all lanes, collect candidates, then apply the precedence and ambiguity rules below.

### `pitcher_strikeouts`

Route here when the market is a player prop about a pitcher strikeout count.

Strong indicators:

- `strikeout`, `strikeouts`, `k`, or `ks`;
- `over` or `under` plus a numeric threshold;
- player name is a pitcher;
- wording such as "will [player] record at least X strikeouts".

Reject this lane if the market is about team strikeouts, batter strikeouts, or a non-MLB pitcher without a matching MLB game.

### `home_run_hitter`

Route here when the market is a player prop about a named hitter hitting a home run.

Strong indicators:

- `home run`, `homer`, `hr`, or `to hit a home run`;
- named player;
- same-game wording or MLB game context;
- yes/no contract on whether that player records a home run.

Reject this lane if the market is about total game home runs, team home runs, derby events, or season-long awards.

### `yrfi_nrfi`

Route here when the market is about whether a run is scored in the first inning.

Strong indicators:

- `yrfi`, `nrfi`;
- `first inning`;
- `1st inning`;
- `run scored in the first`;
- yes/no wording tied to the first inning only.

Reject this lane if the market covers any other inning, first five innings, or a player first-inning prop.

### `game_total`

Route here when the market is about combined full-game runs by both teams.

Strong indicators:

- `total runs`;
- `over` or `under` plus a run threshold;
- `combined runs`;
- wording that covers the full game rather than one team, one player, or one inning.

Reject this lane if the market is a team total, first-five total, first-inning total, series total, or player stat total.

### `run_line`

Route here when the market is about a team spread, handicap, margin, or run line.

Strong indicators:

- `run line`;
- `spread`;
- `+1.5`, `-1.5`, or another signed run handicap;
- wording such as "win by 2 or more", "lose by 1 or win", or "cover".

Reject this lane if the market is a binary game winner without a spread, or if the number is a total-runs threshold.

### `moneyline`

Route here when the market is a binary full-game winner market.

Strong indicators:

- `winner`;
- `win the game`;
- `will [team] beat [team]`;
- team-vs-team game outcome wording with no spread, total, inning, or player-stat condition.

Reject this lane if the market includes a run handicap, total threshold, inning condition, or player stat.

## Precedence

Some market titles contain generic words like "win" or numbers that can create false matches. Apply this precedence after candidate detection:

1. Player stat lanes before game lanes:
   - `pitcher_strikeouts`
   - `home_run_hitter`
2. Inning-specific lane:
   - `yrfi_nrfi`
3. Numbered game markets:
   - `game_total`
   - `run_line`
4. Generic game winner:
   - `moneyline`

Precedence does not override contradiction. If two lanes remain plausible after rules and context are checked, return `AMBIGUOUS`.

## Ambiguous-Market Handling

Do not guess.

Return `route_status: "AMBIGUOUS"` when:

- multiple lane candidates remain plausible;
- title and rules disagree;
- a number could be either a spread or total and wording does not resolve it;
- player name extraction conflicts with a team/game market;
- the market appears to be a team total, first-five market, series market, award market, season market, or other non-covered MLB type;
- Kalshi URL cannot be resolved and the supplied title is too vague.

For ambiguous results, set `market_lane` to `null`, include `candidate_lanes`, and provide `needed_clarification`.

## Required Output Schema

Return one JSON object per routed input:

```json
{
  "route_status": "ROUTED|AMBIGUOUS|BLOCKED|OUT_OF_SCOPE",
  "market_lane": "moneyline|run_line|game_total|yrfi_nrfi|home_run_hitter|pitcher_strikeouts|null",
  "candidate_lanes": [],
  "kalshi_url": null,
  "event_ticker": null,
  "market_ticker": null,
  "event_title": null,
  "market_title": null,
  "contract_title": null,
  "game_date": null,
  "teams": {
    "away": null,
    "home": null
  },
  "player_name": null,
  "threshold": null,
  "side_hint": "YES|NO|OVER|UNDER|TEAM|PLAYER|null",
  "confidence": 0,
  "matched_signals": [],
  "reject_signals": [],
  "needed_clarification": [],
  "next_workflow": "runbooks/mlb-prediction-process.md",
  "notes": []
}
```

Rules:

- `ROUTED` requires exactly one non-null `market_lane`.
- `AMBIGUOUS`, `BLOCKED`, and `OUT_OF_SCOPE` must use `market_lane: null`.
- `confidence` is a routing confidence score only. It is not pick confidence.
- The router must not assign `CLEAR_PICK`, `PASS`, `WATCH_FOR_LISTING`, or any trade decision status. Those belong to the prediction process runbook.

## Failure Cases

Return `BLOCKED` when:

- the Kalshi URL cannot be accessed or resolved and no useful title/rules are supplied;
- required text is missing;
- the market is clearly MLB-related but the lane cannot be determined from available fields;
- the title is truncated enough to change meaning;
- rules are required to distinguish lanes and are unavailable.

Return `OUT_OF_SCOPE` when:

- the market is not MLB;
- the market is baseball but not one of the six supported lanes;
- the market is a season-long, series-long, futures, awards, standings, playoff, team total, first-five, live-only, or non-game prop market.

## Placeholder Examples

These examples use placeholder games only. They are not live picks.

### Moneyline

Input title: `Will the Alpha City Aces beat the Beta Town Bears?`

Output:

```json
{
  "route_status": "ROUTED",
  "market_lane": "moneyline",
  "candidate_lanes": ["moneyline"],
  "market_title": "Will the Alpha City Aces beat the Beta Town Bears?",
  "confidence": 92,
  "matched_signals": ["team-vs-team game outcome", "no spread", "no total", "no player prop"],
  "reject_signals": [],
  "needed_clarification": [],
  "next_workflow": "runbooks/mlb-prediction-process.md"
}
```

### Run Line

Input title: `Alpha City Aces -1.5 runs vs Beta Town Bears`

Output lane: `run_line`

### Game Total

Input title: `Alpha City Aces vs Beta Town Bears: Over 8.5 total runs?`

Output lane: `game_total`

### YRFI / NRFI

Input title: `Will there be a run scored in the 1st inning of Aces vs Bears?`

Output lane: `yrfi_nrfi`

### Home Run Hitter

Input title: `Will Placeholder Player hit a home run in Aces vs Bears?`

Output lane: `home_run_hitter`

### Pitcher Strikeouts

Input title: `Will Placeholder Pitcher record over 5.5 strikeouts?`

Output lane: `pitcher_strikeouts`

### Ambiguous

Input title: `Aces vs Bears over 1.5`

Output:

```json
{
  "route_status": "AMBIGUOUS",
  "market_lane": null,
  "candidate_lanes": ["run_line", "game_total"],
  "market_title": "Aces vs Bears over 1.5",
  "confidence": 40,
  "matched_signals": ["numeric threshold", "over wording"],
  "reject_signals": ["missing total-runs wording", "missing team handicap wording"],
  "needed_clarification": ["Need Kalshi rules or full market title to distinguish spread from total"],
  "next_workflow": "runbooks/mlb-prediction-process.md"
}
```

## Non-Goals

- No live picks.
- No trade recommendations.
- No liquidity checks.
- No source discovery.
- No cron jobs.
- No runtime implementation.
- No edits outside this runbook spec.
