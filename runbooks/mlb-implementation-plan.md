# MLB Dry-Run Implementation Plan

Use this plan to turn the MLB runbooks into a dry-run workflow that writes files only and places no trades.

Source of truth:

- `runbooks/mlb-prediction-process.md`
- `runbooks/mlb-market-router-spec.md`
- `runbooks/mlb-output-schemas.md`
- `runbooks/mlb-source-adapter-spec.md`
- `runbooks/mlb-cron-workflow-spec.md`

This is an implementation plan only. Do not create scripts, cron jobs, runtime integrations, live picks, or trades from this document.

## Repo Inspection Summary

Current repo shape:

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

Observed implementation patterns:

- `package.json` is ESM (`"type": "module"`).
- Existing test command is `npm test`, mapped to `node --test`.
- Existing atomic JSON write helper is `src/storage.js`, but the dry-run MLB implementation should not import runtime `src/` in the first pass.
- Existing state/output patterns use JSON files such as `pipeline-state.json` and `pipeline-card-outputs.json`.
- Existing session logs use markdown sections in `channels/session-template.md`.
- There is no current `scripts/` directory.
- There are no installed cron workflows in the repo; `runbooks/mlb-cron-workflow-spec.md` is documentation only.

## Script Location Decision

Future dry-run scripts should live under:

`scripts/mlb/`

Reason:

- The workflow is operator tooling, not app runtime.
- It should not be imported by `src/server.js`.
- It can be run from the shell, CI, or a later cron wrapper without changing runtime API behavior.
- It keeps dry-run implementation separate from frontend, server, and deployment configuration.

Future tests should live under:

`test/mlb-*.test.js`

Reason:

- The repo already uses Node's built-in test runner.
- No new test framework or `package.json` script is required.

## Existing Patterns To Reuse Later

State files:

- Use JSON files under `state/mlb/YYYY-MM-DD/`.
- Use deterministic IDs for games, router results, and pick candidates.
- Write output files atomically through a local dry-run helper in `scripts/mlb/lib/file-io.mjs`.
- Keep raw source cache files append-only.

Run logs:

- Use markdown with stable sections, following the style of `channels/session-template.md`.
- Append run entries instead of rewriting past entries.
- Include proof sections after each dry-run command.

Scheduled workflows:

- Do not install cron in the implementation stage.
- Implement dispatcher logic as a dry-run command first.
- Keep example cron blocks in runbooks only until a later explicit scheduling task.

## Minimum Dry-Run Implementation Stages

### Stage 1: Router Dry-Run

Goal:

- Implement lane routing for placeholder or supplied Kalshi market titles.
- Return exactly one lane or an `AMBIGUOUS`, `BLOCKED`, or `OUT_OF_SCOPE` result.
- Produce no picks and no trades.

Future files to create:

- `scripts/mlb/router-dry-run.mjs`
- `scripts/mlb/lib/router.mjs`
- `test/mlb-router.test.js`

Inputs:

- Placeholder JSON fixtures embedded in tests.
- Optional local JSON input path for manual dry runs.

Outputs:

- Console JSON route result.
- Optional `state/mlb/YYYY-MM-DD/router-dry-run.json` when `--out` is supplied.

Test commands:

```bash
node --test test/mlb-router.test.js
node scripts/mlb/router-dry-run.mjs --title "Will the Alpha City Aces beat the Beta Town Bears?"
```

Proof required:

- `node --test test/mlb-router.test.js` passes.
- Router returns `moneyline`, `run_line`, `game_total`, `yrfi_nrfi`, `home_run_hitter`, and `pitcher_strikeouts` for placeholder examples.
- Ambiguous placeholder title returns `route_status: "AMBIGUOUS"` with `market_lane: null`.
- `git status --short` shows only expected dry-run files.

### Stage 2: Source Adapter Dry-Run

Goal:

- Implement read-only source adapters with cache and normalization envelopes.
- Use placeholder fixtures first; enable live public GET checks only behind an explicit `--live-readonly` flag.
- Do not use authenticated Kalshi endpoints or execution endpoints.

Future files to create:

- `scripts/mlb/source-adapter-dry-run.mjs`
- `scripts/mlb/lib/adapters/kalshi.mjs`
- `scripts/mlb/lib/adapters/mlb-official.mjs`
- `scripts/mlb/lib/adapters/baseball-savant.mjs`
- `scripts/mlb/lib/adapters/weather.mjs`
- `scripts/mlb/lib/adapters/optional-price-sanity.mjs`
- `scripts/mlb/lib/cache.mjs`
- `test/mlb-source-adapters.test.js`

Inputs:

- Placeholder fixtures in tests.
- Optional run date.
- Optional `--live-readonly` for public GET source checks.

Outputs:

- Adapter envelopes.
- Raw cache files under `state/mlb/YYYY-MM-DD/cache/<source_id>/raw/`.
- Normalized cache files under `state/mlb/YYYY-MM-DD/cache/<source_id>/normalized/`.

Test commands:

```bash
node --test test/mlb-source-adapters.test.js
node scripts/mlb/source-adapter-dry-run.mjs --date 2026-06-01 --fixtures-only
```

Proof required:

- Adapter envelopes include `source_id`, `status`, `checked_at_utc`, `cache_key`, `cache_path`, `records`, `warnings`, `errors`, and `source_urls`.
- Kalshi HTTP 429/challenge placeholder maps to `degraded` when API fallback fixture succeeds.
- Missing Kalshi prop fixture produces `NOT_OFFERED_NOW`.
- Weak liquidity fixture produces `KALSHI_AVAILABLE` plus `tradeability_status: "FAIL"` in downstream normalized fields.

### Stage 3: Output Writer Dry-Run

Goal:

- Write and validate `slate_manifest.json`, `source_registry.json`, `picks.json`, `daily-baseball-guide.md`, and `run_log.md`.
- Use placeholder data only.
- Keep JSON schema validation local and deterministic.

Future files to create:

- `scripts/mlb/output-writer-dry-run.mjs`
- `scripts/mlb/lib/file-io.mjs`
- `scripts/mlb/lib/output-writer.mjs`
- `scripts/mlb/lib/schema-validation.mjs`
- `test/mlb-output-writer.test.js`

Inputs:

- Placeholder adapter envelopes.
- Placeholder router results.
- Placeholder pick candidates.

Outputs:

- `state/mlb/YYYY-MM-DD/slate_manifest.json`
- `state/mlb/YYYY-MM-DD/source_registry.json`
- `state/mlb/YYYY-MM-DD/picks.json`
- `state/mlb/YYYY-MM-DD/daily-baseball-guide.md`
- `state/mlb/YYYY-MM-DD/run_log.md`
- `state/mlb/YYYY-MM-DD/snapshots/`

Test commands:

```bash
node --test test/mlb-output-writer.test.js
node scripts/mlb/output-writer-dry-run.mjs --date 2026-06-01 --fixtures-only
```

Proof required:

- All five output files exist.
- JSON files parse.
- Placeholder `WATCH_FOR_LISTING`, `NOT_TRADEABLE`, `BLOCKED`, and `AMBIGUOUS` cases follow `runbooks/mlb-output-schemas.md`.
- `run_log.md` contains `No trades placed`.

### Stage 4: Morning Scan Dry-Run

Goal:

- Compose router, adapters, and output writer into a single file-producing morning scan.
- Default to fixture mode.
- Support explicit read-only public source checks later through `--live-readonly`.

Future files to create:

- `scripts/mlb/morning-scan-dry-run.mjs`
- `scripts/mlb/lib/morning-scan.mjs`
- `test/mlb-morning-scan.test.js`

Inputs:

- Run date.
- Fixture mode by default.
- Existing runbook-defined source stack.

Outputs:

- Full `state/mlb/YYYY-MM-DD/` run folder.
- Initial statuses in `picks.json`.
- Daily guide.
- Run log.

Test commands:

```bash
node --test test/mlb-morning-scan.test.js
node scripts/mlb/morning-scan-dry-run.mjs --date 2026-06-01 --fixtures-only
```

Proof required:

- Run folder exists.
- All five daily files exist.
- Missing placeholder prop is `WATCH_FOR_LISTING`.
- No placeholder pick claims live execution.
- No trades placed proof appears in `run_log.md` and `daily-baseball-guide.md`.

### Stage 5: Pre-Game Refresh Dry-Run

Goal:

- Re-read an existing run folder and update statuses based on placeholder refresh events.
- Prove status transitions, snapshots, and idempotency.
- Do not place trades.

Future files to create:

- `scripts/mlb/pregame-refresh-dry-run.mjs`
- `scripts/mlb/lib/pregame-refresh.mjs`
- `test/mlb-pregame-refresh.test.js`

Inputs:

- Existing `state/mlb/YYYY-MM-DD/` folder.
- Placeholder refresh event, such as prop appears, liquidity fails, lineup changes, or source outage.

Outputs:

- Updated `picks.json`.
- Updated `daily-baseball-guide.md`.
- Appended `run_log.md`.
- Snapshot files before overwrites.

Test commands:

```bash
node --test test/mlb-pregame-refresh.test.js
node scripts/mlb/pregame-refresh-dry-run.mjs --date 2026-06-01 --fixtures-only --event prop-appears-thin-book
```

Proof required:

- `WATCH_FOR_LISTING` can transition to `NOT_TRADEABLE` when prop appears with weak liquidity.
- `CLEAR_PICK` can downgrade when liquidity/source state changes.
- Rerunning the same refresh does not duplicate pick IDs.
- Prior outputs are snapshotted before overwrite.
- `run_log.md` contains old status, new status, reason, UTC timestamp, and `No trades placed`.

## Proposed Files To Create Later

Create only these files in the later implementation task:

```text
scripts/mlb/router-dry-run.mjs
scripts/mlb/source-adapter-dry-run.mjs
scripts/mlb/output-writer-dry-run.mjs
scripts/mlb/morning-scan-dry-run.mjs
scripts/mlb/pregame-refresh-dry-run.mjs
scripts/mlb/lib/router.mjs
scripts/mlb/lib/cache.mjs
scripts/mlb/lib/file-io.mjs
scripts/mlb/lib/output-writer.mjs
scripts/mlb/lib/schema-validation.mjs
scripts/mlb/lib/morning-scan.mjs
scripts/mlb/lib/pregame-refresh.mjs
scripts/mlb/lib/adapters/kalshi.mjs
scripts/mlb/lib/adapters/mlb-official.mjs
scripts/mlb/lib/adapters/baseball-savant.mjs
scripts/mlb/lib/adapters/weather.mjs
scripts/mlb/lib/adapters/optional-price-sanity.mjs
test/mlb-router.test.js
test/mlb-source-adapters.test.js
test/mlb-output-writer.test.js
test/mlb-morning-scan.test.js
test/mlb-pregame-refresh.test.js
```

Generated dry-run output paths:

```text
state/mlb/YYYY-MM-DD/slate_manifest.json
state/mlb/YYYY-MM-DD/source_registry.json
state/mlb/YYYY-MM-DD/picks.json
state/mlb/YYYY-MM-DD/daily-baseball-guide.md
state/mlb/YYYY-MM-DD/run_log.md
state/mlb/YYYY-MM-DD/cache/
state/mlb/YYYY-MM-DD/snapshots/
```

Do not create these generated state paths until a later dry-run execution task.

## No-Touch List

Do not edit these files or directories during the dry-run implementation unless a later user request explicitly expands scope:

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
frontend/app/
deploy/systemd/
deploy/nginx/
```

## Test Command Matrix

Run stages independently:

```bash
node --test test/mlb-router.test.js
node --test test/mlb-source-adapters.test.js
node --test test/mlb-output-writer.test.js
node --test test/mlb-morning-scan.test.js
node --test test/mlb-pregame-refresh.test.js
```

Run all repo tests:

```bash
npm test
```

Run dry-run commands:

```bash
node scripts/mlb/router-dry-run.mjs --title "Will the Alpha City Aces beat the Beta Town Bears?"
node scripts/mlb/source-adapter-dry-run.mjs --date 2026-06-01 --fixtures-only
node scripts/mlb/output-writer-dry-run.mjs --date 2026-06-01 --fixtures-only
node scripts/mlb/morning-scan-dry-run.mjs --date 2026-06-01 --fixtures-only
node scripts/mlb/pregame-refresh-dry-run.mjs --date 2026-06-01 --fixtures-only --event prop-appears-thin-book
```

Live public source checks, if later approved:

```bash
node scripts/mlb/source-adapter-dry-run.mjs --date YYYY-MM-DD --live-readonly
node scripts/mlb/morning-scan-dry-run.mjs --date YYYY-MM-DD --live-readonly
```

`--live-readonly` must use public GET-style source access only and must not call authenticated trade execution endpoints.

## Proof Required By Stage

Router dry-run:

```text
node --test test/mlb-router.test.js
node scripts/mlb/router-dry-run.mjs --title "Aces vs Bears over 1.5"
Expected: route_status AMBIGUOUS, market_lane null
git status --short
```

Source adapter dry-run:

```text
node --test test/mlb-source-adapters.test.js
node scripts/mlb/source-adapter-dry-run.mjs --date 2026-06-01 --fixtures-only
Show adapter envelopes
Show cache files created under state/mlb/2026-06-01/cache/
Show no trades placed statement
git status --short
```

Output writer dry-run:

```text
node --test test/mlb-output-writer.test.js
node scripts/mlb/output-writer-dry-run.mjs --date 2026-06-01 --fixtures-only
test -f state/mlb/2026-06-01/slate_manifest.json && echo SLATE_EXISTS
test -f state/mlb/2026-06-01/source_registry.json && echo SOURCE_REGISTRY_EXISTS
test -f state/mlb/2026-06-01/picks.json && echo PICKS_EXISTS
test -f state/mlb/2026-06-01/daily-baseball-guide.md && echo GUIDE_EXISTS
test -f state/mlb/2026-06-01/run_log.md && echo RUN_LOG_EXISTS
grep -n "No trades placed" state/mlb/2026-06-01/run_log.md
git status --short
```

Morning scan dry-run:

```text
node --test test/mlb-morning-scan.test.js
node scripts/mlb/morning-scan-dry-run.mjs --date 2026-06-01 --fixtures-only
Show source health summary
Show status counts
Show WATCH_FOR_LISTING placeholder
Show No trades placed proof
git status --short
```

Pre-game refresh dry-run:

```text
node --test test/mlb-pregame-refresh.test.js
node scripts/mlb/pregame-refresh-dry-run.mjs --date 2026-06-01 --fixtures-only --event prop-appears-thin-book
Show changed status row
Show snapshot file path
Show No trades placed proof
git status --short
```

## Rollback Plan

For a failed later implementation:

1. Do not use `git reset --hard`.
2. Remove only files created by the MLB dry-run implementation if the user approves removal:
   - `scripts/mlb/`
   - `test/mlb-*.test.js`
   - generated `state/mlb/YYYY-MM-DD/` dry-run output folders
3. Leave existing runbooks untouched unless the user explicitly asks to revise them.
4. Leave unrelated dirty files untouched.
5. If output files were generated, archive or delete only the affected `state/mlb/YYYY-MM-DD/` folder after confirming the date.
6. Re-run `git status --short` and report remaining changes.

## Trade Safety And Live Execution Avoidance

Hard rules:

- No order placement functions.
- No authenticated trading endpoints.
- No private account endpoints.
- No environment variables for Kalshi trading credentials.
- No writes outside `state/mlb/YYYY-MM-DD/` except future dry-run scripts and tests.
- No cron installation.
- No package script that could run MLB workflow automatically.
- No `src/server.js` integration.
- No UI button or API route that triggers the MLB workflow.

Implementation safeguards:

- Every CLI command name includes `dry-run`.
- Default mode is `--fixtures-only`.
- Live source access requires explicit `--live-readonly`.
- Any function that writes outputs must include `No trades placed by this workflow` in `run_log.md`.
- Tests must assert that generated outputs do not contain execution claims such as `trade placed`, `order submitted`, or `filled`.
- Kalshi adapter may read market data only; it must not expose any order placement method.

## Next Smallest Safe Step

The next implementation step, if approved later, is Stage 1 only:

Create `scripts/mlb/router-dry-run.mjs`, `scripts/mlb/lib/router.mjs`, and `test/mlb-router.test.js`.

Do not start source adapters, output writers, morning scan, pre-game refresh, cron, or runtime integration until Stage 1 proof passes.
