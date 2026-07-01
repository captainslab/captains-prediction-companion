# World Cup Advances Model — Calibration Harness (Design)

Date: 2026-06-30
Status: Approved design (sub-project 1 of 3), revised after data feasibility check
Branch: fix/worldcup-advances-elo-poisson-preview

## Context

The World Cup "advances" model (`scripts/worldcup/lib/advances-model.mjs`) computes
`P(advance) = P(regWin) + P(regDraw)·[P(etWin) + P(etDraw)·P(penWin)]` from a
generative Elo→Poisson path. Today its only team-specific input is the Elo gap;
the Poisson/ET/penalty machinery is a fixed transform with hardcoded constants
(`ELO_GOAL_SUPREMACY_DIVISOR=600`, `ADVANCES_BASELINE_TOTAL_GOALS=2.4`, ~50/50
penalty prior, no home/neutral term). `calibration_status` is `V1_PROVISIONAL` —
the mapping has **never been validated against outcomes**.

Decision (brainstorm 2026-06-30): the model is meant to be a **genuine edge-seeker**
vs the Kalshi `KXWCADVANCE` market, validated **both** retrospectively (calibration
on history) **and** forward (paper-trade live). Price isolation is preserved: the
**model stays strictly price-free**; any model-vs-market comparison lives in a
separate decision/display layer (sub-project 2), never feeding the model.

This program decomposes into three sequenced sub-projects:

1. **Calibration harness** — *this spec.*
2. **Edge layer + forward paper-trade ledger** (later spec).
3. **Soft layer (iterative)** — home/neutral+venue → availability/XI →
   keeper/penalty-taker → rest/travel (later spec).

## Data feasibility finding (drove this revision)

Ground-truth check of eloratings.net `<year>_results.tsv` (2022):
- The **type code is the competition, not the round** — every 2022 World Cup match,
  group and knockout alike, is `WC`. Knockout matches are **not** identifiable from
  eloratings alone.
- **Penalty shootouts are recorded as draws with no winner** (Argentina–France final
  `3-3`, Argentina–Netherlands `2-2`, Brazil–Croatia `1-1`). eloratings **cannot**
  say who advanced in penalty ties.

eloratings reliably provides the hard part — **pre-match Elo for every match** — but
not round or shootout-winner. So instead of forcing a "knockout-advance" dataset,
we **calibrate the model's components on clean, abundant data** and validate the
composite where outcomes are identifiable.

## Goal (sub-project 1)

A reproducible harness that:
- calibrates the **regulation Elo→Poisson core** (the W/D/L engine) on **every**
  international match in eloratings (pre-match Elo + score + venue→home/neutral);
- tests the **penalty-layer** assumption (~50/50, Elo-independent) against historical
  **shootout** outcomes;
- spot-checks the **composite `p_advance`** on identifiable knockout ties;
- tunes the model constants on a train split and validates **out-of-sample** on a
  held-out test split (anti-overfit);
- emits a calibration report that sets `calibration_status: BACKTESTED` with real
  numbers (or shows the mapping is poorly calibrated).

## Data sources (confirmed)

**Primary — eloratings.net `<year>_results.tsv`** (HTTP 200, server-side TSV, no JS).
Tab columns (0-indexed): `0 year, 1 month, 2 day, 3 home_code, 4 away_code,
5 home_goals, 6 away_goals, 7 type_code (competition), 8 venue_code, 9 elo_change,
10 home_elo, 11 away_elo, …`. `home_elo`/`away_elo` are pre-match ratings. Neutral
is derived: a match is treated as neutral when `venue_code` equals neither team's
own country code (cross-checked against `en.teams.tsv`). One file per year; range is
configurable.

**Supplementary — shootout history** (penalty layer only): a results+shootouts
dataset that records penalty-shootout winners (e.g. the public
`martj42/international_results` `shootouts.csv`: `date, home_team, away_team,
winner`). Used solely to test the penalty prior. The exact source URL + license is
pinned in Task 0 of the plan after a fetch check; if unavailable, the penalty-layer
calibration degrades to "untested, prior retained" rather than blocking the core.

## Components (each independently testable)

- `scripts/worldcup/backtest/lib/results-tsv.mjs` — pure parser: an eloratings
  results row → `{date, homeCode, awayCode, homeGoals, awayGoals, typeCode,
  venueCode, homeElo, awayElo}`. No network.
- `scripts/worldcup/backtest/lib/neutral.mjs` — pure: derive `neutral` / which side
  is home from `venueCode` + team→country map.
- `scripts/worldcup/backtest/lib/calibration-metrics.mjs` — pure: binary + 3-class
  Brier, log-loss, reliability-curve binning, Elo-gap bucketing.
- `scripts/worldcup/backtest/fetch-results.mjs` — fetch `<year>_results.tsv` over a
  year range → cache to `state/worldcup/backtest/results/<year>.tsv` (uncommitted).
- `scripts/worldcup/backtest/build-regulation-dataset.mjs` — parse cached results
  into a regulation dataset (match record + observed W/D/L) →
  `state/worldcup/backtest/regulation_dataset.json` + a small **committed fixture**
  for tests.
- `scripts/worldcup/backtest/fetch-shootouts.mjs` + `build-shootout-dataset.mjs` —
  fetch/normalize shootout outcomes → `state/worldcup/backtest/shootout_dataset.json`
  (+ committed fixture). Fail-soft if source unavailable.
- `scripts/worldcup/backtest/run-calibration.mjs` — orchestrator: load datasets →
  call the **real** `eloToLambdas`/`computeAdvance` (with a config) per match →
  compute regulation metrics, penalty-layer test, composite spot-check → tune
  constants (train/test) → write `state/worldcup/backtest/calibration_report.json`
  + console summary.

## Model parameterization (no logic fork)

`eloToLambdas` / `computeAdvance` currently hardcode their constants. Refactor them
to accept an **optional config** (`{ eloGoalSupremacyDivisor, baselineTotalGoals,
homeAdvantageElo, penaltyPrior }`) defaulting to today's values, so the backtest
tunes the **real model** — never a forked computation. Default output is unchanged
when no config is passed (existing tests keep passing).

## Data flow

```
eloratings <year>_results.tsv ─▶ fetch-results ─▶ results-tsv parse + neutral
   ─▶ build-regulation-dataset ─▶ regulation_dataset.json
shootouts source ─▶ fetch/build-shootout-dataset ─▶ shootout_dataset.json
regulation_dataset ─▶ run-calibration ─▶ eloToLambdas/Poisson(config) per match
   ─▶ calibration-metrics (W/D/L Brier, log-loss, reliability, Elo-gap buckets)
   ─▶ train/test tune ─▶ penalty-layer test (shootouts) ─▶ composite spot-check
   ─▶ calibration_report.json + summary
```

## Tuning methodology

- Deterministic train/test split (by a fixed hash of `date+homeCode+awayCode`; no
  `Math.random`), documented.
- Search the config grid to minimize **log-loss on TRAIN**; report Brier/log-loss/
  reliability on the held-out **TEST** split as the out-of-sample result.
- Report the default-constants baseline alongside the tuned result so any
  improvement (and overfit risk) is explicit.

## Price isolation

The harness reads **only** Elo ratings and match outcomes. No price, odds, implied
probability, volume, or market data enters dataset construction, the model call,
metrics, or tuning. (Market comparison is sub-project 2.)

## Success criteria

- Regulation core calibrated on all eloratings matches: report W/D/L Brier,
  log-loss, reliability curve (overall + by Elo-gap bucket), default vs tuned, train
  vs test.
- Penalty prior tested against shootout history (or explicitly marked untested if
  the source is unavailable), with the observed shootout-vs-Elo relationship.
- Composite `p_advance` spot-checked on identifiable knockout ties, with documented
  sample limits.
- Tests cover: TSV row parsing, neutral derivation, metric math (binary + 3-class),
  deterministic split, and the penalty/shootout join on a fixture.
- No existing World Cup test regresses; `eloToLambdas`/`computeAdvance` default
  output is unchanged when called without a config.

## Out of scope (this sub-project)

- The edge layer / model-vs-market comparison + forward paper-trade ledger (#2).
- Any soft-layer signal — XI, injuries, keeper/penalty-taker, rest/travel,
  venue-specific effects (#3).
- A full knockout-round dataset (not needed: the core calibrates on all matches; the
  composite is only spot-checked).
- Two-leg aggregate ties (excluded with a logged count if encountered).
- Any Telegram send or production packet change driven by calibration results.
