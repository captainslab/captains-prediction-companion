---
name: UFC Fight App
description: Alpha pipeline for UFC/MMA fight markets — moneylines, method of victory, round totals. Composite striking/grappling model with takedown defense adjustment.
triggers:
  - "UFC fight"
  - "MMA market"
  - "UFC moneyline"
  - "fight outcome"
  - "method of victory"
  - "round total UFC"
---

# UFC Fight App

Handles: **UFC** — moneylines, method of victory, round over/unders.

## Input Signals

| Signal | Field | Notes |
|--------|-------|-------|
| Striking accuracy (home) | `str_acc_a`, `str_acc_b` | Significant strike accuracy % |
| Striking defense | `str_def_a`, `str_def_b` | |
| Takedown accuracy | `td_acc_a`, `td_acc_b` | |
| Takedown defense | `td_def_a`, `td_def_b` | |
| Win rate (finish) | `finish_rate_a`, `finish_rate_b` | % of wins by finish |
| Reach differential | `reach_diff` | Inches, Fighter A minus B |
| Weight class | `weight_class` | Affects TD/finish base rates |

## Pricing Model

```
P(A wins) = sigmoid(composite_score_diff)
composite_score = w_str * str_composite + w_td * grappling_composite + w_reach * reach_adj
str_composite = str_acc × (1 − opp_str_def)
grappling_composite = td_acc × (1 − opp_td_def)
```

## Key Rules

- **Reach diff > 4"** → +3pp for longer fighter
- **finish_rate > 70%** → method_of_victory confidence +8pp
- **Weight class heavyweight** → finish rate base +10pp
- **Min edge** = 0.03, **confidence floor** = 0.45

## Standard Output

```python
RouterOutput(
    fair_probability=0.61,
    edge=0.06,
    confidence=0.59,
    extra={
        "composite_score_diff": 0.44,
        "grappling_dominant": True,
        "finish_rate_a": 0.72,
    }
)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run_ufc_app.py` | Run app against a sample UFC input |
