---
name: Baseball Game App
description: Alpha pipeline for MLB and NCAAB game markets (sides, totals, moneylines). Handles park factors, FIP-based pitching estimates, and wind/temperature adjustments.
triggers:
  - "analyze MLB game"
  - "baseball spread"
  - "baseball total"
  - "baseball moneyline"
  - "MLB game market"
---

# Baseball Game App

Handles: **MLB** and **NCAA_BB** (baseball) — sides, totals, and moneylines.

## Input Signals

| Signal | Field | Notes |
|--------|-------|-------|
| Home pitcher FIP | `fip_home` | Fielding Independent Pitching |
| Away pitcher FIP | `fip_away` | |
| Park factor | `park_factor` | Normalized to 1.0 = neutral |
| Wind speed (mph) | `wind_mph` | |
| Wind direction | `wind_dir` | "out" boosts runs, "in" suppresses |
| Temperature (°F) | `temp_f` | <50°F suppresses offense |
| Lineup confirmed | `lineup_confirmed` | Bool — starters submitted |
| Market total | `market_total` | |

## Workflow

1. Router dispatches to `baseball_game_app.run(inp)`
2. `build_context(inp)` assembles signals
3. Estimate run total from FIP differential + park factor
4. Apply wind/temp adjustment
5. Return RouterOutput with `fair_total` and `weather_flag`

## Key Rules

- **FIP differential > 1.5** → confidence -10pp
- **Wind "out" > 15mph** → +0.8 runs to total
- **Temp < 50°F** → -0.6 runs to total
- **Park factor > 1.10** → hitter-friendly flag
- **Min edge** = 0.02, **confidence floor** = 0.45

## Standard Output

```python
RouterOutput(
    fair_probability=0.54,
    edge=0.04,
    confidence=0.58,
    extra={
        "fair_total": 8.4,
        "weather_flag": True,
    }
)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run_baseball_app.py` | Run app against a sample input |
