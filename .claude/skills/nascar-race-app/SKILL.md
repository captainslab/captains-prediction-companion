---
name: NASCAR Race App
description: Alpha pipeline for NASCAR race markets — top-3 finish, race winner, stage markets. Practice speed + qualifying + tire falloff model with live running order updates.
triggers:
  - "NASCAR race"
  - "NASCAR winner"
  - "NASCAR top 3"
  - "stock car race market"
  - "NASCAR stage"
---

# NASCAR Race App

Handles: **NASCAR_CUP**, **NASCAR_XFINITY**, **NASCAR_TRUCKS** — race-level markets.
Does NOT handle series championship futures (→ `nascar_series_futures_app`).

## Input Signals

### Pre-race
| Signal | Field | Notes |
|--------|-------|-------|
| Practice speed rank | `practice_rank` | 1 = fastest |
| Qualifying position | `qualifying_pos` | Grid position |
| Driver season avg finish | `avg_finish` | Season to date |
| Manufacturer | `manufacturer` | Toyota/Chevy/Ford reliability delta |
| Track type | `track_type` | "superspeedway" \| "intermediate" \| "short" \| "road" |

### Live
| Signal | Field | Notes |
|--------|-------|-------|
| Current running position | `running_pos` | Live |
| Laps led | `laps_led` | |
| Tire age (laps) | `tire_age` | Laps since last pit |
| Caution active | `caution_flag` | Bool |

## Key Rules

- **practice_rank ≤ 3** → +6pp win probability
- **qualifying_pos ≤ 5** → +4pp
- **Superspeedway** → chaos factor: confidence -8pp, all probabilities compressed
- **Tire age > 40 laps** → tire falloff flag, pit strategy volatility
- **Caution live** → volatility_flag = True
- **Min edge** = 0.03, **confidence floor** = 0.40 (NASCAR is volatile)

## Standard Output

```python
RouterOutput(
    fair_probability=0.22,
    edge=0.07,
    confidence=0.52,
    extra={
        "track_type": "intermediate",
        "volatility_flag": False,
        "tire_falloff_flag": True,
    }
)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run_nascar_race.py` | Run app against a sample NASCAR race input |
