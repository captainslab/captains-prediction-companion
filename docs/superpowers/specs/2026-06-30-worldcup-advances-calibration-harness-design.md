# World Cup Advances Model — Calibration Harness (Design)

Date: 2026-06-30
Status: Approved design (sub-project 1 of 3)
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
separate decision/display layer, never feeding the model.

This program is too large for one spec. It decomposes into three sequenced
sub-projects:

1. **Calibration harness** — *this spec.* Foundation: historical knockout dataset
   + backtest of the real `computeAdvance` + calibration report + out-of-sample
   constant tuning. Answers "is the Elo→advance mapping calibrated, and what are
   the best-fit constants?"
2. **Edge layer + forward paper-trade ledger** — price-isolated model vs Kalshi,
   logged per knockout this WC, settled, measured (CLV/Brier vs market). Gates any
   shipped signal.
3. **Soft layer (iterative)** — home/neutral+venue → availability/XI →
   keeper/penalty-taker → rest/travel, each added **only if it improves** the
   sub-project-1 backtest and sub-project-2 forward results.

Sub-projects 2 and 3 get their own spec → plan → implementation cycles later.

## Goal (sub-project 1)

Produce a reproducible calibration harness that:
- builds a historical international-knockout dataset (pre-match Elo + advance
  outcome) from eloratings.net, with no scraping (server-side TSV);
- backtests the **real** `computeAdvance` against actual advance outcomes;
- reports Brier score, log-loss, and a reliability curve (overall and by Elo-gap
  bucket);
- tunes the model constants on a train split and validates out-of-sample on a
  held-out test split (anti-overfit);
- emits a calibration report that either sets `calibration_status: BACKTESTED`
  with real numbers or shows the mapping is poorly calibrated.

## Data source (confirmed feasible)

eloratings.net serves history as server-side TSV (HTTP 200, no JS):
- `https://www.eloratings.net/<year>_results.tsv` — every international match for a
  year: `year, month, day, home_code, away_code, home_goals, away_goals,
  type_code, venue_code, elo_change, home_elo, away_elo, …`. `home_elo`/`away_elo`
  are the ratings **at match time** (pre-match basis for that fixture).
- `https://www.eloratings.net/en.teams.tsv` — code → English team name (already
  used by `elo-ratings-fetch.mjs`).

**Open risk to resolve in-build:** decoding the `type_code` legend (which codes are
knockout rounds of WC/Euro/Copa/AFCON/Gold Cup/Nations League, vs group/friendly)
and the **penalty-shootout resolution** (how a drawn knockout that went to
penalties records the advancing side). The build includes an explicit
legend-mapping step and a verification pass on known historical ties before any
metric is trusted.

## Components (each independently testable)

- `scripts/worldcup/backtest/build-knockout-dataset.mjs` — fetch `<year>_results.tsv`
  over a configurable year range; parse rows; filter to knockout matches via the
  decoded type-code legend; derive the per-match **advance outcome** (single-leg:
  team that won after ET/penalties advanced; handle the penalty-draw case from
  score + code); write `state/worldcup/backtest/knockout_dataset.json`
  (uncommitted runtime artifact) + a small committed fixture sample for tests.
- `scripts/worldcup/backtest/lib/results-tsv.mjs` — pure parser for a `<year>_results.tsv`
  row → structured match record. No network.
- `scripts/worldcup/backtest/lib/knockout-legend.mjs` — pure type-code → competition/round
  classification + `isKnockout` predicate.
- `scripts/worldcup/backtest/lib/calibration-metrics.mjs` — pure: Brier, log-loss,
  reliability-curve binning, Elo-gap bucketing.
- `scripts/worldcup/backtest/run-calibration.mjs` — orchestrator: load dataset →
  for each match call the **real `computeAdvance`** with `(home_elo, away_elo,
  neutral)` → collect predictions vs outcomes → compute metrics → tune constants
  (train/test split) → write `state/worldcup/backtest/calibration_report.json` +
  console summary.

## Model parameterization (no logic fork)

`computeAdvance` / `eloToLambdas` currently hardcode their constants. Refactor them
to accept an **optional config object** (`{ eloGoalSupremacyDivisor,
baselineTotalGoals, homeAdvantageElo, penaltyPrior }`) defaulting to today's
values, so the backtest tunes the **real model** by passing candidate configs —
never a copied/forked computation. Default behavior is unchanged when no config is
passed (existing tests keep passing).

## Data flow

```
<year>_results.tsv (eloratings) ─▶ results-tsv parse ─▶ knockout-legend filter
   ─▶ advance-outcome derivation ─▶ knockout_dataset.json
knockout_dataset.json ─▶ run-calibration ─▶ computeAdvance(config) per match
   ─▶ calibration-metrics (Brier/log-loss/reliability) ─▶ train/test tune
   ─▶ calibration_report.json + summary
```

## Tuning methodology

- Deterministic train/test split (e.g., by hash of match id, or by era — split
  rule fixed and documented; no `Math.random`).
- Search the config grid to minimize **log-loss on TRAIN**; report Brier/log-loss
  /reliability on the held-out **TEST** split as the out-of-sample result.
- Report both the default-constants baseline and the tuned result so any
  improvement is explicit and overfit risk is visible.

## Price isolation

The harness reads **only** Elo ratings and match outcomes. No price, odds, implied
probability, volume, or market data enters dataset construction, the model call,
metrics, or tuning. (Market comparison is sub-project 2's edge layer.)

## Success criteria

- Dataset builds reproducibly from eloratings TSVs with a documented type-code
  legend and a verified penalty-resolution rule (spot-checked against known ties).
- `run-calibration` outputs Brier, log-loss, and a reliability curve overall and by
  Elo-gap bucket, plus default-vs-tuned and train-vs-test numbers.
- Tests cover: TSV row parsing, knockout classification, advance-outcome derivation
  (incl. a penalty-shootout fixture), metric math, and deterministic split.
- No existing World Cup test regresses; `computeAdvance` default output is
  unchanged when called without a config.

## Out of scope (this sub-project)

- The edge layer / model-vs-market comparison and forward paper-trade ledger
  (sub-project 2).
- Any soft-layer signal — XI, injuries, keeper/penalty-taker, rest/travel,
  venue-specific effects (sub-project 3).
- Any Telegram send or production packet change driven by calibration results.
- Two-leg aggregate ties (WC/Euro/Copa knockouts are single-leg; if the dataset
  surfaces two-leg competitions, they are excluded with a logged count, not
  silently dropped).
