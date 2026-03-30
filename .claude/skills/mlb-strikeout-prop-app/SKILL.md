---
name: MLB Strikeout Prop App
description: Alpha pipeline for MLB pitcher strikeout prop markets. Hard gate on lineup/starter confirmation. Poisson model over projected batters faced.
triggers:
  - "MLB strikeout prop"
  - "K prop"
  - "pitcher strikeout market"
  - "will pitcher strikeout"
  - "strikeout total"
---

# MLB Strikeout Prop App

Handles: **MLB** strikeout props — "Will [Pitcher] record over/under X strikeouts?"

## Hard Gate

**`lineup_confirmed=False` → immediate `no_bet_flag=True`.**
A strikeout prop is meaningless if the starter hasn't been confirmed or the bullpen is being deployed.

## Input Signals

| Signal | Field | Notes |
|--------|-------|-------|
| Lineup confirmed | `lineup_confirmed` | **Required = True to proceed** |
| K/BF rate | `k_per_bf` | Strikeouts per batter faced (season) |
| SwStr% | `swstr_pct` | Swinging strike rate |
| Opposing K% | `opp_k_pct` | Opposing lineup's strikeout rate |
| Projected BF | `projected_bf` | Projected batters faced |
| Market line | `market_line` | Over/under prop line |

## Pricing Model

```
λ = k_per_bf × projected_bf × (1 + swstr_adj) × opp_k_adj
P(K > line) = 1 − Poisson_CDF(line, λ)
P(K < line) = Poisson_CDF(line − 1, λ)
```

## Key Rules

- **lineup_confirmed=False** → no_bet immediately
- **proj BF < 15** → confidence -15pp (short outing risk)
- **SwStr% < 8%** → confidence -10pp
- **Opp K% < 18%** → contact-heavy lineup note
- **Min edge** = 0.03

## Standard Output

```python
RouterOutput(
    fair_probability=0.58,   # P(over)
    edge=0.08,
    confidence=0.62,
    no_bet_flag=False,
    extra={
        "fair_k_lambda": 6.3,
        "market_line": 5.5,
        "projected_bf": 24,
        "lineup_confirmed": True,
    }
)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run_k_prop.py` | Run app against a sample K prop input |
