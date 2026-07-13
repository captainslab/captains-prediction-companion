# HR Probability Engine — Phase 1

## Current gap

The existing projection engine deliberately returns `hr: null` at
`scripts/mlb/lib/projection-engine.mjs:268`. The current Baseball Savant
readonly sidecar keeps only a bounded three-day aggregate, so it does not yet
provide the multi-window ball-flight distributions needed for an honest HR
model.

Phase 1 therefore adds a code-owned, market-free foundation only. It does not
alter the existing projection engine, router, consumers, scheduler, or output.

## Architecture

`baseball-savant-distributions.mjs` converts Savant-shaped rows into compact
per-batter distributions: 7-day, 30-day, and season-to-date HR/PA and HR/BIP.
The season window is bounded from January 1 of the run-date year by default, or
by a validated `season_start` override; older rows are excluded and counted in
coverage rather than leaking into any window.
Distance-tail counts preserve explicit `null` when the source lacks that
measurement; missing data is never represented as zero.
The data-quality thresholds merge caller overrides onto the default thresholds,
and an invalid merged `stale_after_days` blocks the profile.
EV quantiles; launch-angle and spray buckets; distance tails; barrel,
hard-hit, sweet-spot, fly-ball, and pull-air rates; and handedness/pitch-family
splits. It is fixture-first and never writes `state/`.

`hr-engine/contracts.mjs` owns the immutable profile schema
`mlb_hr_feature_profile_v1` and rejects unknown or market-derived fields.
`power-profile.mjs` builds one shared power/contact/ball-flight profile and
blocks when quality gates fail. `data-quality.mjs` makes sample coverage,
freshness, and uncertainty explicit. `monte-carlo.mjs` supplies deterministic
seeded simulation primitives.

Two foundation-only adapters consume that same profile object:

1. `regular-game-scenario.mjs` accepts expected plate appearances, park,
   weather, and starter handedness.
2. `derby-scenario.mjs` accepts rounds, timer, swing count, and fatigue
   placeholders.

The Derby adapter is not routed through the `home_run_hitter` lane. There are
no router changes and no existing consumer changes in Phase 1.

## Future training path

The production model should be trained and evaluated with chronological
train/validation/test splits, never a random split across time. The first
target is a calibrated HR-on-contact probability model using the profile
features and explicit missingness indicators. Evaluation should include Brier
score, log-loss, calibration tables, and reliability curves, with calibration
checked by batter, handedness, pitch family, and time window.

The regular-game opportunity model should estimate plate appearances from
lineup slot, team context, starter/bullpen availability, and game state while
keeping opportunity separate from contact quality. The Derby path should learn
a swing and fatigue transform from round/timer observations, with fatigue
never silently substituted when the required event data is absent.
