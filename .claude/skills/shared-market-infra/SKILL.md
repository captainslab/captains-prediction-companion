---
name: Shared Market Infrastructure
description: Shared alpha engines used across all sports apps — Kelly bankroll manager, CLV tracker, consensus price engine, no-bet classifier, Monte Carlo pricer, model calibration reporter.
triggers:
  - "Kelly sizing"
  - "closing line value"
  - "CLV tracking"
  - "bankroll management"
  - "no-bet classifier"
  - "consensus price"
  - "calibration report"
---

# Shared Market Infrastructure

These modules live in `backend/core/sports/` and are called by the orchestration layer — **not** by individual apps. Apps return `RouterOutput`; the shared infra applies EV/Kelly/CLV on top.

## Modules

### `kelly.py` — KellyBankrollManager

```python
KellyBankrollManager(bankroll=1000.0, max_fraction=0.25, kelly_fraction=0.25)
  .size_bet(edge, confidence, odds)  → units
  .compute_ev(edge, odds)            → EV in cents
```

| Parameter | Default | Notes |
|-----------|---------|-------|
| `kelly_fraction` | 0.25 | Quarter-Kelly (conservative) |
| `max_fraction` | 0.25 | Hard cap per bet |
| Live scaling | ×0.5 | Applied automatically for live markets |
| Futures cap | 15% | Max bankroll on any single future |

### `advanced.py` — Shared Helpers

| Class | Purpose |
|-------|---------|
| `ClosingLineTracker` | Records fair_prob at analysis time; computes CLV at close |
| `ConsensusPriceEngine` | Aggregates prices across venues (Kalshi, Polymarket, PredictIt) |
| `InjuryNewsGate` | Blocks bet if key player injury detected in news |
| `MonteCarloPricer` | Simulation-based fair value for complex markets |
| `ModelCalibrationReporter` | Tracks predicted vs actual outcomes for calibration |
| `NoBetClassifier` | Applies edge/confidence/CLV/staleness gates |

### `orchestration.py` — Orchestration Layers

| Class | Role |
|-------|------|
| `SportsPreGamePlanner` | Runs pre-game pipeline: router → app → Kelly → CLV record |
| `SportsLiveExecutor` | Runs live pipeline: router → app → Kelly (×0.5) → output |
| `SportsReviewAnalyst` | Post-game: CLV vs close, calibration update, no-bet review |

## No-Bet Gates (NoBetClassifier)

A bet is blocked if ANY of:
- `edge < min_edge` (app-specific, typically 2-4¢)
- `confidence < confidence_floor` (app-specific, typically 0.45-0.50)
- `is_stale=True` and staleness > TTL
- CLV history shows persistent negative CLV for this market type

## Data Flow

```
CompanionRouter.dispatch(RouterInput)
  → App.run(RouterInput)           → RouterOutput (fair_prob, edge, confidence)
  → NoBetClassifier.classify()     → no_bet_flag
  → KellyBankrollManager.size()    → units
  → ClosingLineTracker.record()    → CLV record
  → Final output
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run_kelly.py` | Compute Kelly sizing for a given edge/confidence/odds |
| `scripts/check_clv.py` | Show CLV log for a market or pipeline |
| `scripts/calibration_report.py` | Print calibration table across all apps |
