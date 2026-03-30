---
name: MLB Home Run Prop App
description: Alpha pipeline for MLB player home run prop markets. Hard gate on lineup confirmation. Binomial model over plate appearances.
triggers:
  - "MLB home run prop"
  - "HR prop"
  - "will player hit a home run"
  - "home run market"
---

# MLB Home Run Prop App

Handles: **MLB** HR props — "Will [Player] hit a home run today?"

## Hard Gate

**`lineup_confirmed=False` → immediate `no_bet_flag=True`.**
Do not proceed regardless of calculated edge. An HR prop is meaningless if the batter is scratched or batting 8th.

## Input Signals

| Signal | Field | Notes |
|--------|-------|-------|
| Lineup confirmed | `lineup_confirmed` | **Required = True to proceed** |
| Barrel rate % | `barrel_rate` | Statcast — % of batted balls classified as barrels |
| Opposing pitcher FIP | `opp_fip` | Lower = harder to HR |
| Park factor (HR) | `hr_park_factor` | HR-specific park factor |
| Plate appearances | `projected_pas` | Projected PAs today |
| Handedness matchup | `batter_hand`, `pitcher_hand` | For platoon splits |

## Pricing Model

```
P(≥1 HR) = 1 − (1 − P_per_PA)^N
P_per_PA = barrel_rate × hr_contact_rate × park_factor × handedness_adj
```

## Key Rules

- **lineup_confirmed=False** → no_bet immediately
- **barrel_rate < 4%** → confidence -15pp
- **proj PAs < 3** → confidence -10pp (limited exposure)
- **HR park factor < 0.85** → suppression note
- **Min edge** = 0.03

## Standard Output

```python
RouterOutput(
    fair_probability=0.18,
    edge=0.03,
    confidence=0.55,
    no_bet_flag=False,
    extra={
        "p_per_pa": 0.048,
        "projected_pas": 4,
        "lineup_confirmed": True,
    }
)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run_hr_prop.py` | Run app against a sample HR prop input |
