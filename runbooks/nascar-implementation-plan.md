# NASCAR Dry-Run Implementation Plan

Use this plan to turn the NASCAR design notes into a dry-run workflow that writes files only and places no trades.

Source of truth:

- `ARCHITECTURE.md` (declares `fightAndRacingApp (type="UFC"|"NASCAR")`)
- `docs/SPORTSAPP.md` (NASCAR lanes, skills, Kalshi futures tickers, league enums)
- `docs/HOW-TO-PREDICT.md` (NASCAR subtypes and skill mapping)
- `docs/BUILDSTATUS.md` (NASCAR priority slot)
- `runbooks/mlb-implementation-plan.md` (dry-run discipline this plan mirrors)
- `runbooks/mlb-market-router-spec.md` (router shape to mirror)
- `runbooks/mlb-source-adapter-spec.md` (adapter envelope shape to mirror)
- `runbooks/mlb-output-schemas.md` (output file schema shape to mirror)
- `runbooks/mlb-cron-workflow-spec.md` (cron deferral pattern to mirror)

This is an implementation plan only. Do not create scripts, cron jobs, runtime integrations, live picks, or trades from this document. The plan creates no live execution path.

## Architectural Position

NASCAR lives under `fightAndRacingApp(type="NASCAR")` as the canonical shell, matching `ARCHITECTURE.md` and `docs/SPORTSAPP.md`.

`nascarRaceApp` and `nascarSeriesFuturesApp`, as referenced in `docs/BUILDSTATUS.md` row #7, are LANE GROUPS under that shell, not separate top-level apps:

- `nascarRaceApp` covers per-race markets: `race_winner`, `top3`.
- `nascarSeriesFuturesApp` covers season-long markets: `series_champion`.

Canonical lanes (the only values a NASCAR router may return as `market_lane`):

- `race_winner`
- `top3`
- `series_champion`

A router result outside this set must be one of `AMBIGUOUS`, `BLOCKED`, `OUT_OF_SCOPE`, or `NOT_NASCAR`.

Confirmed Kalshi NASCAR series futures tickers (per `docs/SPORTSAPP.md`):

- `KXNASCARTRUCKSERIES-NTS26` — NASCAR Trucks championship
- `KXNASCARCUPSERIES-NCS26` — NASCAR Cup championship
- `KXNASCARAUTOPARTSSERIES-NAPS26` — NASCAR O'Reilly (Xfinity / Auto Parts) championship

Series enums (per `docs/SPORTSAPP.md`): `NASCAR_CUP`, `NASCAR_TRUCKS`, `NASCAR_OREILLY`.

Agent reuse:

- No new agent directories. NASCAR is already named in `agents/companion-router/SOUL.md`, `agents/sports-pre-game/SOUL.md`, `agents/sports-live/SOUL.md`, `agents/alphaagent/SOUL.md`, `agents/sports-review/SOUL.md`, and `agents/decision-logic/SOUL.md`. Wire NASCAR into those agents only after the dry-run pipeline produces verified files.

## Repo Inspection Summary

Current repo shape (verified by prior audit):

- Runtime backend lives in `src/`.
- Frontend lives in `frontend/`.
- Tests live in `test/` and use Node's built-in `node:test`.
- Operator docs live in `runbooks/`.
- Operator state lives in `state/`.
- Session logs live in `channels/`.
- Role definitions live in `agents/`.
- Reusable operator workflows live in `skills/`.
- Deployment examples live in `deploy/`.
- GitHub workflow examples live in `.github/workflows/`.

Observed implementation patterns (verified):

- `package.json` is ESM (`"type": "module"`).
- Existing test command is `npm test`, mapped to `node --test`.
- `scripts/mlb/` is the only existing pipeline scaffold; it is the working reference.
- `scripts/nascar/` does not exist. No NASCAR test exists. No NASCAR runbook other than this one exists.
- The MLB dry-run does not import runtime `src/`. NASCAR will follow the same isolation rule.
- Existing state/output patterns use JSON files such as `pipeline-state.json` and `pipeline-card-outputs.json`.
- There are no installed cron workflows in the repo.

## Script Location Decision

Future dry-run scripts should live under:

`scripts/nascar/`

Reason:

- The workflow is operator tooling, not app runtime.
- It must not be imported by `src/server.js` or any frontend code.
- It can be run from the shell, CI, or a later cron wrapper without changing runtime API behavior.
- It keeps NASCAR dry-run implementation separate from MLB scripts, frontend, server, and deployment configuration.
- It parallels `scripts/mlb/` so future shared lifting (e.g. a `scripts/lib/` layer) is a later, evidence-driven refactor — not a Stage 1 concern.

Future tests should live under:

`test/nascar-*.test.js`

Reason:

- The repo already uses Node's built-in test runner; no new framework or `package.json` script is required.
- Filename prefix mirrors `test/mlb-*.test.js`.

## Existing Patterns To Reuse Later

State files:

- Use JSON files under `state/nascar/YYYY-MM-DD/` for per-race-weekend artifacts.
- Use JSON files under `state/nascar/series/YYYY/` for series-futures snapshots (one folder per season).
- Use deterministic IDs for races, drivers, router results, and pick candidates.
- Write output files atomically through a local dry-run helper in `scripts/nascar/lib/file-io.mjs`.
- Keep raw source cache files append-only.

Run logs:

- Use markdown with stable sections, following the style of `channels/session-template.md`.
- Append run entries instead of rewriting past entries.
- Include proof sections after each dry-run command.

Scheduled workflows:

- Do not install cron in the implementation stage.
- Implement dispatcher logic as a dry-run command first.
- Keep example cron blocks in runbooks only until a later explicit scheduling task.
- NASCAR cadence note: race weekends are typically Fri practice/qualifying → Sat support race → Sun Cup race. Scheduling stays paper-only until Stage 4 proof passes.

## NASCAR-Specific Modeling Inputs (Plan Only)

These are inputs the later modeling stage must accept. They are NOT to be implemented in Stage 1 or Stage 2. Listed here so router and adapter contracts can leave room for them.

Per-race inputs:

- Track type: superspeedway, intermediate (1.5mi), short track, road course, drafting/plate.
- Driver season form: average finish, average running position, top-10 rate, DNF rate, laps led.
- Recent track-specific form: last 3 starts at this track and at this track type.
- Practice speed: 1-lap, 5-lap, 10-lap, 20-lap consecutive averages.
- Qualifying result and starting position.
- Tire falloff profile (track-dependent).
- Pit strategy expectations and stage cautions.
- Weather: rain risk, temperature, wind (road courses + superspeedways sensitive).
- Equipment: team, manufacturer, engine package.
- Cautions / wreck risk profile (plate-track tail risk).

Series-futures inputs:

- Current playoff bracket / points standing.
- Remaining races and track-type distribution.
- Implied probability from Kalshi ticker price.
- Manufacturer / team trend across recent races.

Required market distinction (router contract):

- Per-race markets resolve in hours/days → priced from race-weekend model.
- Series-futures markets resolve at season end → priced from season simulation, not single-race model.
- The router MUST tag `market_scope: "race" | "series"` alongside `market_lane`.

## Driver Universe And Candidate Pool (Race-Winner Default)

This section governs the default `race_winner` modeling universe for a normal Cup points race. It exists to keep the model from spraying probability mass across the entire 36+ car field and to keep candidate selection grounded in evidence rather than ticker enumeration.

Default pool:

- Default candidate pool = top 20 drivers in current season points at the time of the race.
- The remaining drivers stay in a single bucket: `FIELD` (a.k.a. longshot bucket). They are NOT priced individually by default.
- Modeled probability mass on `FIELD` is summed and held as one tail-risk number, not 16+ micro-priced entries.

Override rules (promote a driver from FIELD into the active candidate pool only when at least one trigger fires):

- `pole_winner`: driver won pole for this race.
- `top5_starting_position`: confirmed top-5 starting position.
- `top5_practice_speed`: top-5 in a meaningful practice session (single-lap or relevant multi-lap average).
- `strong_multi_lap_average`: top-tier 10-lap / 20-lap consecutive average vs field.
- `elite_track_history`: clearly elite history at this specific track or this track type (e.g., multi-win or repeated top-5s at the venue/style).
- `kalshi_price_or_liquidity`: Kalshi price and/or liquidity is meaningful enough that ignoring the driver creates pricing or exposure blind spots (e.g., a non-top-20 driver trading materially above noise with real depth).
- `special_format_rule`: format-specific reason (transfer race seed, heat-race winner, last-chance qualifier slot, etc.).

Override discipline:

- Each promoted driver must record which trigger(s) fired in the candidate record (e.g., `override_reasons: ["top5_practice_speed", "kalshi_price_or_liquidity"]`).
- No trigger fired → driver stays in `FIELD`. Narrative, vibes, or recency bias are not triggers.
- `kalshi_price_or_liquidity` alone promotes the driver to "review" status, not automatically to a tradeable candidate; the modeling stage still must justify fair value vs price.

Pool shape (normal points race):

- Active candidate pool = top 20 by points ∪ override-promoted drivers.
- `FIELD` bucket = every other entered driver, collapsed into one synthetic candidate with summed implied probability.
- Total modeled probability mass across (active candidates + `FIELD`) must sum to 1.0 before any pricing comparison.

## Special Event Override (Exhibition / Non-Points Format)

Some NASCAR weekends are not normal points races and the default top-20 pool is the wrong starting universe. These weekends require a `special_event_override` block on the race record.

Reference example market (exhibition / format curveball — used as an example only, NOT as the default NASCAR model):

- `https://kalshi.com/markets/kxnascarrace/nascar-race/KXNASCARRACE-NASA26?utm_source=kalshiapp_eventpage`
- Ticker: `KXNASCARRACE-NASA26` — All-Star Race style event. Treat as a `special_event_override` case; do NOT let its quirks bleed into the default Cup points-race model.

Trigger conditions for `special_event_override`:

- All-Star Race
- Clash (preseason exhibition)
- Any exhibition / non-points event
- Heat races, transfer races, last-chance qualifiers
- Cut-down / elimination formats
- Any race with format-specific qualifying, inversions, mandatory pit windows, or non-standard stage structure

When `special_event_override` is active:

- Set `event_format_adjustment: true` on the race record and record the format type (e.g., `format_type: "all_star"`, `"clash"`, `"heat"`, `"transfer"`, `"cutdown"`).
- Default candidate pool is NOT top 20 in points. Build the pool from format-defined participants (e.g., heat winners, transfer race graduates, locked-in entries) plus any drivers with a direct path in (fan vote, provisional, owner points, etc.).
- Up-weight the following inputs vs the normal points-race model:
  - Format rules (who can win, how transfers work, inversions, mandatory pit stops, stage lengths).
  - Qualifying result and starting position (often disproportionately predictive in short exhibitions).
  - Practice speed (small-sample format → practice carries more signal).
  - Inversions (starting-order flips after segments).
  - Transfers / cuts (eligibility changes mid-event).
  - Clean air dependency (track-position-driven outcomes).
  - Track position generally.
  - Pit strategy and pit-window rules specific to the format.
- Down-weight season-long points form, season DNF rate, and full-season track-type averages — these are weaker priors for one-off exhibitions.
- `FIELD` bucket may not apply the same way; if the format has a small fixed participant set, every eligible participant is a named candidate and there is no `FIELD` collapse.

Separation rule:

- Normal Cup points-race modeling (top-20 default pool + override triggers + `FIELD` bucket) and `special_event_override` modeling MUST stay separate code paths and separate config blocks.
- A race record is exactly one of: normal points race OR `special_event_override`. Never both.
- If event classification is ambiguous, the router emits `ESCALATE` rather than guessing which model to apply.

## Minimum Dry-Run Implementation Stages

### Stage 1: Router Dry-Run

Goal:

- Implement lane routing for placeholder or supplied Kalshi NASCAR market titles.
- Return exactly one of `race_winner`, `top3`, `series_champion`, or one of `AMBIGUOUS`, `BLOCKED`, `OUT_OF_SCOPE`, `NOT_NASCAR`.
- Tag `market_scope` as `"race"` or `"series"`.
- Produce no picks and no trades.

Future files to create:

- `scripts/nascar/router-dry-run.mjs`
- `scripts/nascar/lib/router.mjs`
- `test/nascar-router.test.js`

Inputs:

- Placeholder JSON fixtures embedded in tests.
- Optional local JSON input path for manual dry runs.
- Optional `--rules` text to mimic the MLB router signature.

Outputs:

- Console JSON route result with fields: `route_status`, `market_lane`, `market_scope`, `candidate_lanes`, `series` (one of `NASCAR_CUP`, `NASCAR_TRUCKS`, `NASCAR_OREILLY`, or null), `kalshi_ticker_hint` (e.g. `KXNASCARCUPSERIES-NCS26` when detected), and `decision_status: "NO_TRADE"`.
- Optional `state/nascar/YYYY-MM-DD/router-dry-run.json` when `--out` is supplied.

Test commands:

```bash
node --test test/nascar-router.test.js
node scripts/nascar/router-dry-run.mjs --title "Will Driver A win the Cup Series race at Daytona?"
```

Proof required:

- `node --test test/nascar-router.test.js` passes.
- Router returns `race_winner` for a per-race win-only title.
- Router returns `top3` for a per-race top-3 / podium title.
- Router returns `series_champion` for a season-long Cup / Trucks / Xfinity championship title and tags the matching Kalshi ticker hint.
- Title referencing `KXNASCARCUPSERIES-NCS26` routes to `series_champion` with `series: "NASCAR_CUP"`.
- Title referencing `KXNASCARTRUCKSERIES-NTS26` routes to `series_champion` with `series: "NASCAR_TRUCKS"`.
- Title referencing `KXNASCARAUTOPARTSSERIES-NAPS26` routes to `series_champion` with `series: "NASCAR_OREILLY"`.
- Ambiguous placeholder title returns `route_status: "AMBIGUOUS"` with `market_lane: null`.
- Non-NASCAR title (e.g. UFC, MLB) returns `route_status: "NOT_NASCAR"`.
- `git status --short` shows only expected dry-run files.

### Stage 2: Source Adapter Dry-Run

Goal:

- Implement read-only source adapters with cache and normalization envelopes.
- Use placeholder fixtures first; enable live public GET checks only behind an explicit `--live-readonly` flag.
- Do not use authenticated Kalshi endpoints or execution endpoints.

Future files to create:

- `scripts/nascar/source-adapter-dry-run.mjs`
- `scripts/nascar/lib/adapters/kalshi.mjs` (futures tickers + per-race markets, read-only)
- `scripts/nascar/lib/adapters/nascar-official.mjs` (schedule, entries, results)
- `scripts/nascar/lib/adapters/practice.mjs` (practice speed / lap averages)
- `scripts/nascar/lib/adapters/qualifying.mjs` (qualifying results, starting grid)
- `scripts/nascar/lib/adapters/weather.mjs` (race-day forecast)
- `scripts/nascar/lib/adapters/optional-price-sanity.mjs` (sportsbook cross-check, optional)
- `scripts/nascar/lib/cache.mjs`
- `test/nascar-source-adapters.test.js`

Inputs:

- Placeholder fixtures in tests.
- Optional run date (race weekend Friday).
- Optional series filter: `cup | trucks | oreilly`.
- Optional `--live-readonly` for public GET source checks.

Outputs:

- Adapter envelopes.
- Raw cache files under `state/nascar/YYYY-MM-DD/cache/<source_id>/raw/`.
- Normalized cache files under `state/nascar/YYYY-MM-DD/cache/<source_id>/normalized/`.
- Series-futures snapshots under `state/nascar/series/YYYY/cache/<source_id>/`.

Test commands:

```bash
node --test test/nascar-source-adapters.test.js
node scripts/nascar/source-adapter-dry-run.mjs --date 2026-02-13 --fixtures-only
```

Proof required:

- Adapter envelopes include `source_id`, `status`, `checked_at_utc`, `cache_key`, `cache_path`, `records`, `warnings`, `errors`, and `source_urls`.
- Kalshi HTTP 429 / challenge placeholder maps to `degraded` when fallback fixture succeeds.
- Missing per-race winner market produces `NOT_OFFERED_NOW`.
- All three series-futures tickers (`KXNASCARTRUCKSERIES-NTS26`, `KXNASCARCUPSERIES-NCS26`, `KXNASCARAUTOPARTSSERIES-NAPS26`) appear as separate normalized records with valid envelopes.
- Weak liquidity fixture produces `KALSHI_AVAILABLE` plus `tradeability_status: "FAIL"` in downstream normalized fields.
- Practice and qualifying fixtures normalize into driver-keyed records.

### Stage 3: Output Writer Dry-Run

Goal:

- Write and validate `weekend_manifest.json`, `source_registry.json`, `picks.json`, `daily-nascar-guide.md`, `series-futures-snapshot.json`, and `run_log.md`.
- Use placeholder data only.
- Keep JSON schema validation local and deterministic.

Future files to create:

- `scripts/nascar/output-writer-dry-run.mjs`
- `scripts/nascar/lib/file-io.mjs`
- `scripts/nascar/lib/output-writer.mjs`
- `scripts/nascar/lib/schema-validation.mjs`
- `test/nascar-output-writer.test.js`

Inputs:

- Placeholder adapter envelopes.
- Placeholder router results (mix of `race_winner`, `top3`, `series_champion`).
- Placeholder pick candidates.

Outputs:

- `state/nascar/YYYY-MM-DD/weekend_manifest.json`
- `state/nascar/YYYY-MM-DD/source_registry.json`
- `state/nascar/YYYY-MM-DD/picks.json`
- `state/nascar/YYYY-MM-DD/daily-nascar-guide.md`
- `state/nascar/YYYY-MM-DD/run_log.md`
- `state/nascar/YYYY-MM-DD/snapshots/`
- `state/nascar/series/YYYY/series-futures-snapshot.json`

Test commands:

```bash
node --test test/nascar-output-writer.test.js
node scripts/nascar/output-writer-dry-run.mjs --date 2026-02-13 --fixtures-only
```

Proof required:

- All six output paths exist.
- JSON files parse.
- Placeholder `WATCH_FOR_LISTING`, `NOT_TRADEABLE`, `BLOCKED`, and `AMBIGUOUS` cases follow a NASCAR adaptation of `runbooks/mlb-output-schemas.md` (to be authored as `runbooks/nascar-output-schemas.md` in a later doc task).
- `run_log.md` contains `No trades placed`.
- `series-futures-snapshot.json` records all three Kalshi futures tickers with implied probabilities and last-checked timestamp.

### Stage 4: Race Weekend Scan Dry-Run

Goal:

- Compose router, adapters, and output writer into a single file-producing race-weekend scan.
- Default to fixture mode.
- Support explicit read-only public source checks later through `--live-readonly`.
- Handle both per-race lanes and series-futures lanes in one pass.

Future files to create:

- `scripts/nascar/weekend-scan-dry-run.mjs`
- `scripts/nascar/lib/weekend-scan.mjs`
- `test/nascar-weekend-scan.test.js`

Inputs:

- Run date (race weekend Friday).
- Optional series filter.
- Fixture mode by default.

Outputs:

- Full `state/nascar/YYYY-MM-DD/` run folder.
- Updated `state/nascar/series/YYYY/series-futures-snapshot.json`.
- Initial statuses in `picks.json`.
- Daily guide.
- Run log.

Test commands:

```bash
node --test test/nascar-weekend-scan.test.js
node scripts/nascar/weekend-scan-dry-run.mjs --date 2026-02-13 --fixtures-only
```

Proof required:

- Run folder exists.
- All six output artifacts exist.
- Missing placeholder per-race market is `WATCH_FOR_LISTING`.
- No placeholder pick claims live execution.
- `No trades placed` proof appears in `run_log.md` and `daily-nascar-guide.md`.
- Series-futures snapshot covers all three confirmed tickers.

### Stage 5: Pre-Race Refresh Dry-Run

Goal:

- Re-read an existing run folder and update statuses based on placeholder refresh events (qualifying complete, weather change, driver withdrawal, practice speed update, liquidity change, source outage).
- Prove status transitions, snapshots, and idempotency.
- Do not place trades.

Future files to create:

- `scripts/nascar/prerace-refresh-dry-run.mjs`
- `scripts/nascar/lib/prerace-refresh.mjs`
- `test/nascar-prerace-refresh.test.js`

Inputs:

- Existing `state/nascar/YYYY-MM-DD/` folder.
- Placeholder refresh event: `qualifying-complete`, `weather-change`, `driver-withdrawal`, `practice-update`, `liquidity-failure`, `source-outage`.

Outputs:

- Updated `picks.json`.
- Updated `daily-nascar-guide.md`.
- Appended `run_log.md`.
- Snapshot files before overwrites.

Test commands:

```bash
node --test test/nascar-prerace-refresh.test.js
node scripts/nascar/prerace-refresh-dry-run.mjs --date 2026-02-13 --fixtures-only --event qualifying-complete
```

Proof required:

- `WATCH_FOR_LISTING` can transition to `NOT_TRADEABLE` when market appears with weak liquidity.
- `CLEAR_PICK` can downgrade when weather or liquidity changes.
- Driver-withdrawal event removes affected `race_winner` / `top3` candidates.
- Rerunning the same refresh does not duplicate pick IDs.
- Prior outputs are snapshotted before overwrite.
- `run_log.md` contains old status, new status, reason, UTC timestamp, and `No trades placed`.

### Stage 6 (Deferred): Live Race + Series Tracker

Not in this plan's execution scope. Only sketched here so future work has a landing pad. Live tracking depends on the `agents/sports-live/SOUL.md` 20s polling cadence and must not be implemented until Stages 1–5 have passing proof and explicit user approval.

## Proposed Files To Create Later

Create only these files in the later implementation task:

```text
scripts/nascar/router-dry-run.mjs
scripts/nascar/source-adapter-dry-run.mjs
scripts/nascar/output-writer-dry-run.mjs
scripts/nascar/weekend-scan-dry-run.mjs
scripts/nascar/prerace-refresh-dry-run.mjs
scripts/nascar/lib/router.mjs
scripts/nascar/lib/cache.mjs
scripts/nascar/lib/file-io.mjs
scripts/nascar/lib/output-writer.mjs
scripts/nascar/lib/schema-validation.mjs
scripts/nascar/lib/weekend-scan.mjs
scripts/nascar/lib/prerace-refresh.mjs
scripts/nascar/lib/adapters/kalshi.mjs
scripts/nascar/lib/adapters/nascar-official.mjs
scripts/nascar/lib/adapters/practice.mjs
scripts/nascar/lib/adapters/qualifying.mjs
scripts/nascar/lib/adapters/weather.mjs
scripts/nascar/lib/adapters/optional-price-sanity.mjs
test/nascar-router.test.js
test/nascar-source-adapters.test.js
test/nascar-output-writer.test.js
test/nascar-weekend-scan.test.js
test/nascar-prerace-refresh.test.js
```

Companion runbooks expected later (not in scope for this plan):

```text
runbooks/nascar-prediction-process.md
runbooks/nascar-market-router-spec.md
runbooks/nascar-output-schemas.md
runbooks/nascar-source-adapter-spec.md
runbooks/nascar-cron-workflow-spec.md
```

Generated dry-run output paths:

```text
state/nascar/YYYY-MM-DD/weekend_manifest.json
state/nascar/YYYY-MM-DD/source_registry.json
state/nascar/YYYY-MM-DD/picks.json
state/nascar/YYYY-MM-DD/daily-nascar-guide.md
state/nascar/YYYY-MM-DD/run_log.md
state/nascar/YYYY-MM-DD/cache/
state/nascar/YYYY-MM-DD/snapshots/
state/nascar/series/YYYY/series-futures-snapshot.json
state/nascar/series/YYYY/cache/
```

Do not create these generated state paths until a later dry-run execution task.

## No-Touch List

Do not edit these files or directories during the NASCAR dry-run implementation unless a later user request explicitly expands scope:

```text
src/
frontend/
deploy/
.github/workflows/
package.json
package-lock.json
frontend/package.json
frontend/package-lock.json
agents/
skills/
channels/
public/
data/
.runtime/
.kalshi/
.firecrawl/
scripts/mlb/
test/mlb-router.test.js
test/mlb-source-adapters.test.js
test/pipeline.test.js
test/server.test.js
runbooks/mlb-implementation-plan.md
runbooks/mlb-prediction-process.md
runbooks/mlb-market-router-spec.md
runbooks/mlb-output-schemas.md
runbooks/mlb-source-adapter-spec.md
runbooks/mlb-cron-workflow-spec.md
```

Specific runtime files that must not be touched:

```text
src/server.js
src/kalshiApi.js
src/pipelineService.js
src/captainLabsStore.js
src/storage.js
src/eventMarketContract.js
src/eventMarketAlpha.js
src/eventMarketPrompt.js
src/eventMarketTool.js
frontend/app/
deploy/systemd/
deploy/nginx/
```

Credential and trading endpoint no-touch:

```text
.env*
any Kalshi authenticated trading endpoint
any Polymarket authenticated trading endpoint
any account / wallet / order endpoint
```

## Test Command Matrix

Run stages independently:

```bash
node --test test/nascar-router.test.js
node --test test/nascar-source-adapters.test.js
node --test test/nascar-output-writer.test.js
node --test test/nascar-weekend-scan.test.js
node --test test/nascar-prerace-refresh.test.js
```

Run all repo tests:

```bash
npm test
```

Run dry-run commands:

```bash
node scripts/nascar/router-dry-run.mjs --title "Will Driver A win the Cup Series race at Daytona?"
node scripts/nascar/source-adapter-dry-run.mjs --date 2026-02-13 --fixtures-only
node scripts/nascar/output-writer-dry-run.mjs --date 2026-02-13 --fixtures-only
node scripts/nascar/weekend-scan-dry-run.mjs --date 2026-02-13 --fixtures-only
node scripts/nascar/prerace-refresh-dry-run.mjs --date 2026-02-13 --fixtures-only --event qualifying-complete
```

Live public source checks, if later approved:

```bash
node scripts/nascar/source-adapter-dry-run.mjs --date YYYY-MM-DD --live-readonly
node scripts/nascar/weekend-scan-dry-run.mjs --date YYYY-MM-DD --live-readonly
```

`--live-readonly` must use public GET-style source access only and must not call authenticated trade execution endpoints.

## Proof Required By Stage

Router dry-run:

```text
node --test test/nascar-router.test.js
node scripts/nascar/router-dry-run.mjs --title "Driver A over/under 12.5 finishing position"
Expected: route_status AMBIGUOUS, market_lane null
node scripts/nascar/router-dry-run.mjs --title "Who will win the 2026 NASCAR Cup Series championship? (KXNASCARCUPSERIES-NCS26)"
Expected: market_lane series_champion, series NASCAR_CUP, market_scope series
git status --short
```

Source adapter dry-run:

```text
node --test test/nascar-source-adapters.test.js
node scripts/nascar/source-adapter-dry-run.mjs --date 2026-02-13 --fixtures-only
Show adapter envelopes
Show cache files created under state/nascar/2026-02-13/cache/
Show all three Kalshi series-futures tickers normalized
Show no trades placed statement
git status --short
```

Output writer dry-run:

```text
node --test test/nascar-output-writer.test.js
node scripts/nascar/output-writer-dry-run.mjs --date 2026-02-13 --fixtures-only
test -f state/nascar/2026-02-13/weekend_manifest.json && echo WEEKEND_EXISTS
test -f state/nascar/2026-02-13/source_registry.json && echo SOURCE_REGISTRY_EXISTS
test -f state/nascar/2026-02-13/picks.json && echo PICKS_EXISTS
test -f state/nascar/2026-02-13/daily-nascar-guide.md && echo GUIDE_EXISTS
test -f state/nascar/2026-02-13/run_log.md && echo RUN_LOG_EXISTS
test -f state/nascar/series/2026/series-futures-snapshot.json && echo FUTURES_EXISTS
grep -n "No trades placed" state/nascar/2026-02-13/run_log.md
git status --short
```

Weekend scan dry-run:

```text
node --test test/nascar-weekend-scan.test.js
node scripts/nascar/weekend-scan-dry-run.mjs --date 2026-02-13 --fixtures-only
Show source health summary
Show status counts
Show WATCH_FOR_LISTING placeholder
Show No trades placed proof
git status --short
```

Pre-race refresh dry-run:

```text
node --test test/nascar-prerace-refresh.test.js
node scripts/nascar/prerace-refresh-dry-run.mjs --date 2026-02-13 --fixtures-only --event qualifying-complete
Show changed status row
Show snapshot file path
Show No trades placed proof
git status --short
```

## Rollback Plan

For a failed later implementation:

1. Do not use `git reset --hard`.
2. Remove only files created by the NASCAR dry-run implementation if the user approves removal:
   - `scripts/nascar/`
   - `test/nascar-*.test.js`
   - generated `state/nascar/YYYY-MM-DD/` dry-run output folders
   - generated `state/nascar/series/YYYY/` dry-run output folders
3. Leave existing runbooks (MLB and otherwise) untouched unless the user explicitly asks to revise them.
4. Leave unrelated dirty files (e.g. unrelated `channels/` notes) untouched.
5. Re-run `git status --short` and report remaining changes.

## Trade Safety And Live Execution Avoidance

This plan places no trades and creates no live execution path.

Hard rules:

- No order placement functions.
- No authenticated Kalshi or Polymarket trading endpoints.
- No private account endpoints.
- No environment variables for Kalshi trading credentials.
- No writes outside `state/nascar/YYYY-MM-DD/` and `state/nascar/series/YYYY/` except future dry-run scripts and tests.
- No cron installation.
- No package script that could run the NASCAR workflow automatically.
- No `src/server.js` integration.
- No UI button or API route that triggers the NASCAR workflow.
- No edits to `scripts/mlb/` while NASCAR is being built.

Implementation safeguards:

- Every CLI command name includes `dry-run`.
- Default mode is `--fixtures-only`.
- Live source access requires explicit `--live-readonly`.
- Any function that writes outputs must include `No trades placed by this workflow` in `run_log.md`.
- Tests must assert that generated outputs do not contain execution claims such as `trade placed`, `order submitted`, or `filled`.
- Kalshi adapter may read market data only; it must not expose any order placement method.
- Series-futures adapter logic must read tickers only; no order routes against `KXNASCARTRUCKSERIES-NTS26`, `KXNASCARCUPSERIES-NCS26`, or `KXNASCARAUTOPARTSSERIES-NAPS26`.

## Next Smallest Safe Step

The next implementation step, if approved later, is Stage 1 only:

Create `scripts/nascar/router-dry-run.mjs`, `scripts/nascar/lib/router.mjs`, and `test/nascar-router.test.js`. Lanes are `race_winner`, `top3`, `series_champion`. Tag `market_scope`. Recognize the three Kalshi futures tickers (`KXNASCARTRUCKSERIES-NTS26`, `KXNASCARCUPSERIES-NCS26`, `KXNASCARAUTOPARTSSERIES-NAPS26`). Return `NOT_NASCAR` for non-NASCAR titles.

Do not start source adapters, output writers, weekend scan, pre-race refresh, cron, or runtime integration until Stage 1 proof passes.
