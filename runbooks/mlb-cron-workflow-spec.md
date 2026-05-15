# MLB Cron Workflow Spec

Use this spec to define scheduled MLB operator workflows. This file documents schedules and run behavior only.

Source of truth:

- `runbooks/mlb-prediction-process.md`
- `runbooks/mlb-market-router-spec.md`
- `runbooks/mlb-output-schemas.md`
- `runbooks/mlb-source-adapter-spec.md`

Do not install cron jobs from this document. Do not edit `src/`, runtime code, or existing operator files to implement scheduling.

## Objective

Define two scheduled MLB workflows:

1. Morning Scan
   - Build the daily slate, source registry, initial statuses, and Daily Baseball Guide.
2. Pre-Game Refresh
   - Recheck lineups, weather, prop availability, order books, liquidity, and status changes before first pitch.

Both workflows are non-trading workflows. They may produce `CLEAR_PICK` statuses only when the existing prediction process allows it, but they must not place trades.

## State Folder Layout

Each run date writes under:

`state/mlb/YYYY-MM-DD/`

Required files:

```text
state/mlb/YYYY-MM-DD/
  slate_manifest.json
  source_registry.json
  picks.json
  daily-baseball-guide.md
  run_log.md
  cache/
    kalshi/
      raw/
      normalized/
    mlb_official/
      raw/
      normalized/
    baseball_savant/
      raw/
      normalized/
    weather/
      raw/
      normalized/
    optional_price_sanity/
      raw/
      normalized/
  snapshots/
    YYYYMMDDTHHMMSSZ-slate_manifest.json
    YYYYMMDDTHHMMSSZ-picks.json
    YYYYMMDDTHHMMSSZ-daily-baseball-guide.md
```

Raw cache files are append-only. Output files may be rewritten atomically, but each rewrite must first create a timestamped snapshot.

## Workflow: Morning Scan

Purpose:

- scan Kalshi baseball calendar / Trade API;
- inventory today's tradable MLB board;
- map Kalshi events to official MLB games;
- build `source_registry.json`;
- build `slate_manifest.json`;
- produce initial `picks.json` statuses;
- produce `daily-baseball-guide.md`;
- produce `run_log.md`;
- mark missing props as `WATCH_FOR_LISTING` when baseball research edge exists;
- do not force picks.

Recommended trigger:

- Run once in the morning in `America/Chicago`.
- Proposed documentation-only time: `08:30 America/Chicago`.
- If the slate starts unusually early, run no later than 4 hours before first pitch.

Inputs:

- run date in `America/Chicago`;
- Kalshi baseball calendar URL and Trade API access;
- MLB Stats API schedule for the run date;
- Baseball Savant/Statcast query definitions;
- stadium venue map for NWS point lookup;
- optional price sanity URL only when already known and reliable.

Source adapter call order:

1. Kalshi calendar / Trade API adapter.
2. Official MLB Stats API / MLB Gameday adapter.
3. MLB market router using Kalshi titles/rules and mapped MLB context.
4. Baseball Savant / Statcast adapter for required lane evidence.
5. National Weather Service API adapter for outdoor/weather-sensitive games.
6. Optional price sanity adapter, skipped by default.

Outputs:

- `source_registry.json`
- `slate_manifest.json`
- `picks.json`
- `daily-baseball-guide.md`
- `run_log.md`
- cache and snapshot files

Morning status behavior:

- `RESEARCH_EDGE` + exact Kalshi market + clean liquidity gate may become `CLEAR_PICK`.
- `RESEARCH_EDGE` + missing exact Kalshi prop becomes `WATCH_FOR_LISTING`.
- Listed but weak-liquidity markets become `NOT_TRADEABLE`.
- Unclear sources or unresolved starters/lineups become `BLOCKED`, `LEAN`, or `PASS` according to evidence quality.
- Do not force picks when evidence is thin.

Documentation-only cron example:

```cron
# Documentation only. Do not install yet.
# Run MLB morning scan at 08:30 America/Chicago.
CRON_TZ=America/Chicago
30 8 * * * cd /home/jordan/captains-prediction-companion && ./scripts/mlb-morning-scan --date today
```

The command path is illustrative. Do not create `scripts/` or runtime code from this spec.

## Workflow: Pre-Game Refresh

Purpose:

- refresh official MLB lineups/starters/game status;
- refresh Kalshi market availability;
- recheck `WATCH_FOR_LISTING` props;
- refresh liquidity/order books;
- refresh weather for outdoor parks;
- update `picks.json` statuses;
- update `daily-baseball-guide.md`;
- log changes in `run_log.md`;
- downgrade `CLEAR_PICK` candidates if source, price, liquidity, or rules changed;
- do not place trades.

Recommended trigger:

- T-minus 120, 60, 30, and 10 minutes before first pitch for games with active candidates.
- Also run after confirmed lineups, meaningful weather change, postponement/delay, starter change, or Kalshi board update.

Practical large-slate scheduling:

- Do not create one cron entry per game.
- Use one frequent dispatcher schedule during MLB game windows.
- The dispatcher reads `slate_manifest.json` and `picks.json`, computes which games need refresh, and exits if no game is inside a refresh window.
- Suggested dispatcher cadence: every 10 minutes from late morning through evening in `America/Chicago`.
- The dispatcher must only process games with active candidates: `CLEAR_PICK`, `WATCH_FOR_LISTING`, `NOT_TRADEABLE` with recheck, `LEAN` with needed trigger, or `BLOCKED` with retry path.

Inputs:

- existing `state/mlb/YYYY-MM-DD/` folder;
- current `slate_manifest.json`;
- current `source_registry.json`;
- current `picks.json`;
- current `daily-baseball-guide.md`;
- current `run_log.md`;
- cached source data from morning scan;
- active game window and refresh targets.

Source adapter call order:

1. Official MLB Stats API / MLB Gameday adapter for game status, starters, and lineups.
2. Kalshi calendar / Trade API adapter for updated listed markets, props, prices, and order books.
3. MLB market router for newly listed or changed Kalshi markets.
4. National Weather Service API adapter for outdoor/weather-sensitive games.
5. Baseball Savant / Statcast adapter only if player pool, lineup, pitcher, or query inputs changed.
6. Optional price sanity adapter only if already used and cheap to refresh.

Outputs:

- updated `picks.json`;
- updated `daily-baseball-guide.md`;
- appended `run_log.md`;
- refreshed source cache files;
- snapshots before overwrite;
- optional short notification summary.

Documentation-only cron example:

```cron
# Documentation only. Do not install yet.
# Dispatcher checks whether any active MLB game needs pre-game refresh.
CRON_TZ=America/Chicago
*/10 10-23 * * * cd /home/jordan/captains-prediction-companion && ./scripts/mlb-pregame-refresh-dispatcher --date today
```

The command path is illustrative. Do not create `scripts/` or runtime code from this spec.

## Recheck Rules For `WATCH_FOR_LISTING`

Watchlisted props must be rechecked:

- T-minus 120 minutes;
- T-minus 60 minutes;
- T-minus 30 minutes;
- T-minus 10 minutes;
- immediately after confirmed lineups post;
- immediately after a relevant Kalshi board update if detected.

Recheck logic:

1. Search Kalshi for exact prop match: same player, game date, teams, market type, threshold or stat condition, settlement source/rules.
2. If still missing, keep `availability_status: "NOT_OFFERED_NOW"` and final status `WATCH_FOR_LISTING`; update `next_recheck_utc`.
3. If listed, change `availability_status` to `KALSHI_AVAILABLE`, pull order book and rules, then run the liquidity/tradeability gate.
4. If tradeability passes and research edge still holds, final status may become `CLEAR_PICK`.
5. If listed but spread/depth/freshness/rules fail, final status becomes `NOT_TRADEABLE`.
6. If lineup/starter/player context invalidates the research edge, final status becomes `PASS`, `LEAN`, or `BLOCKED`.

Do not mark a research-edge missing prop as `PASS` solely because it is absent from Kalshi during a recheck.

## Status Transition Rules

Allowed transitions:

| From | To | Required reason |
|---|---|---|
| `WATCH_FOR_LISTING` | `WATCH_FOR_LISTING` | Exact Kalshi prop still missing; next recheck set |
| `WATCH_FOR_LISTING` | `CLEAR_PICK` | Exact Kalshi prop appears, research edge still holds, liquidity gate passes |
| `WATCH_FOR_LISTING` | `NOT_TRADEABLE` | Exact Kalshi prop appears but liquidity/rules/price gate fails |
| `WATCH_FOR_LISTING` | `PASS` | Baseball research edge no longer exists |
| `WATCH_FOR_LISTING` | `BLOCKED` | Required source, lineup, starter, or rules data missing |
| `CLEAR_PICK` | `CLEAR_PICK` | Sources and liquidity remain valid; price still inside max entry |
| `CLEAR_PICK` | `NOT_TRADEABLE` | Spread widened, depth weakened, stale price, halted market, or rules issue |
| `CLEAR_PICK` | `LEAN` | Edge or confidence fell below clear-pick threshold |
| `CLEAR_PICK` | `PASS` | Fair value no longer beats market after refresh |
| `CLEAR_PICK` | `BLOCKED` | Required data conflict or source outage appears |
| `NOT_TRADEABLE` | `CLEAR_PICK` | Same exact market now passes liquidity gate and research edge still holds |
| `NOT_TRADEABLE` | `NOT_TRADEABLE` | Gate still fails; update reason and recheck time |
| `LEAN` | `CLEAR_PICK` | Missing trigger resolves, edge strengthens, Kalshi gate passes |
| `LEAN` | `PASS` | Evidence weakens or price becomes efficient |
| `BLOCKED` | `LEAN` | Required data returns but edge is not clear |
| `BLOCKED` | `CLEAR_PICK` | Required data returns, research edge exists, Kalshi gate passes |
| `BLOCKED` | `PASS` | Returned data eliminates the edge |

Invalid transitions:

- Any status to `CLEAR_PICK` without `research_status: "RESEARCH_EDGE"`, `availability_status: "KALSHI_AVAILABLE"`, and `tradeability_status: "PASS"`.
- `NOT_OFFERED_NOW` directly to `CLEAR_PICK` without first confirming exact Kalshi listing and liquidity.
- Ambiguous router result to any pick status before routing is resolved.
- Any automated transition that claims a trade was placed.

Every transition must append a `run_log.md` row with UTC time, item ID, old status, new status, and reason.

## Idempotency Rules

Reruns must not corrupt prior output.

Rules:

1. Use deterministic IDs for games, router results, and picks.
2. Read existing output files before writing.
3. Write raw cache files append-only.
4. Before rewriting `slate_manifest.json`, `picks.json`, or `daily-baseball-guide.md`, copy the current file to `snapshots/`.
5. Write new output to a temporary file, validate it, then atomically move it into place.
6. Append to `run_log.md`; do not rewrite prior log entries except to repair a malformed file with a clear repair note.
7. Re-running the same refresh window should update timestamps and current market fields, not duplicate pick IDs.
8. If a run fails halfway, leave a partial-run note and keep the last valid output files intact.

## Notification Summary Format

Use this short summary after Morning Scan and after any Pre-Game Refresh that changes statuses:

```text
MLB Kalshi YYYY-MM-DD HH:MM UTC
Workflow: morning_scan|pre_game_refresh
Source health: Kalshi [ok/degraded/blocked], MLB [ok/degraded/blocked], Savant [ok/degraded/blocked], Weather [ok/degraded/blocked], Optional [ok/skipped/degraded/blocked]
Board: CLEAR_PICK n | WATCH_FOR_LISTING n | NOT_TRADEABLE n | LEAN n | PASS n | BLOCKED n
Changed statuses: n
Next refresh: YYYY-MM-DDTHH:MM:SSZ or none
Main blocks: [short reason]
No trades placed by this workflow.
```

## Failure And Partial-Run Behavior

General:

- Log all failures in `run_log.md`.
- Set source health to `degraded` or `blocked` according to the source adapter spec.
- Do not delete prior valid output files.
- Do not produce `CLEAR_PICK` for affected markets when required data is missing.

Morning Scan:

- If Kalshi is blocked, create `source_registry.json` and `run_log.md`, then mark slate build `BLOCKED`.
- If MLB official data is blocked, preserve Kalshi inventory but mark game mapping and affected picks `BLOCKED`.
- If Savant is blocked, player props and Statcast-dependent lanes cannot be `CLEAR_PICK`.
- If weather is blocked for outdoor/weather-sensitive games, affected totals, YRFI/NRFI, and HR props become `BLOCKED`.
- If optional price sanity is unavailable, set it to `skipped` and continue.

Pre-Game Refresh:

- If a refresh fails for one game, continue with other active games and log the failed game.
- If Kalshi order book refresh fails, downgrade existing `CLEAR_PICK` candidates for affected markets to `BLOCKED` or `NOT_TRADEABLE` until refreshed.
- If lineups or starters change, invalidate affected research and recompute before allowing `CLEAR_PICK`.
- If output validation fails, keep the previous valid output and write a failure note.

## Proof Required After Each Run

After Morning Scan:

```text
pwd
date -u
test -d state/mlb/YYYY-MM-DD && echo RUN_FOLDER_EXISTS
test -f state/mlb/YYYY-MM-DD/source_registry.json && echo SOURCE_REGISTRY_EXISTS
test -f state/mlb/YYYY-MM-DD/slate_manifest.json && echo SLATE_MANIFEST_EXISTS
test -f state/mlb/YYYY-MM-DD/picks.json && echo PICKS_EXISTS
test -f state/mlb/YYYY-MM-DD/daily-baseball-guide.md && echo GUIDE_EXISTS
test -f state/mlb/YYYY-MM-DD/run_log.md && echo RUN_LOG_EXISTS
grep -n "No trades placed" state/mlb/YYYY-MM-DD/run_log.md
git status --short
```

After Pre-Game Refresh:

```text
pwd
date -u
test -f state/mlb/YYYY-MM-DD/picks.json && echo PICKS_EXISTS
test -f state/mlb/YYYY-MM-DD/daily-baseball-guide.md && echo GUIDE_EXISTS
test -f state/mlb/YYYY-MM-DD/run_log.md && echo RUN_LOG_EXISTS
grep -n "pre_game_refresh" state/mlb/YYYY-MM-DD/run_log.md
grep -n "No trades placed" state/mlb/YYYY-MM-DD/run_log.md
git status --short
```

Required human proof excerpt:

- final run folder path;
- source health summary;
- status counts;
- changed statuses;
- next refresh time;
- proof that no trades were placed;
- git status.

## Placeholder Example

Morning Scan example:

```text
Run date: 2026-06-01
Workflow: morning_scan
Games found: Alpha City Aces at Beta Town Bears
Kalshi lanes listed: moneyline, game_total
Research-edge HR prop: Placeholder Player HR
Kalshi prop status: NOT_OFFERED_NOW
Final status: WATCH_FOR_LISTING
Next recheck: 2026-06-01T22:05:00Z
No trades placed by this workflow.
```

Pre-Game Refresh example:

```text
Run date: 2026-06-01
Workflow: pre_game_refresh
Game: Alpha City Aces at Beta Town Bears
Trigger: T-minus 60 minutes
Lineups: refreshed
Kalshi prop recheck: Placeholder Player HR still missing
Final status remains: WATCH_FOR_LISTING
No trades placed by this workflow.
```

## Non-Goals

- Do not install cron jobs.
- Do not create scripts.
- Do not edit runtime code.
- Do not place trades.
- Do not make live picks from placeholder examples.
- Do not add new core sources.
- Do not touch unrelated dirty files.
