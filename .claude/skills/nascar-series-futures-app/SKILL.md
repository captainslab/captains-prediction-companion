---
name: NASCAR Series Futures App
description: Alpha pipeline for NASCAR series championship futures markets. Long-horizon only — points-based, not live polling. Refreshes after each race, not on fast live cadence.
triggers:
  - "NASCAR championship"
  - "NASCAR series futures"
  - "NASCAR Cup champion"
  - "NASCAR points standings"
  - "NASCAR season winner"
---

# NASCAR Series Futures App

Handles: **NASCAR_CUP**, **NASCAR_XFINITY**, **NASCAR_TRUCKS** — series championship futures.
Does NOT handle race-level markets (→ `nascar_race_app`).

## Known Kalshi Market IDs (deterministic, confidence 0.98)

| Market ID | Series | Season |
|-----------|--------|--------|
| `KXNASCARCUPSERIES-NCS26` | NASCAR Cup | 2026 |
| `KXNASCARTRUCKSERIES-NTS26` | NASCAR Trucks | 2026 |
| `KXNASCARAUTOPARTSSERIES-NAPS26` | NASCAR O'Reilly (ARCA) | 2026 |

Router checks exact market ID before any other classification. Confidence = 0.98 on exact match.

## Refresh Cadence

- **Refresh after each race** (weekly cadence during season)
- **NOT on fast live polling** — no 20-second ticks
- Season points + wins + schedule remaining = primary inputs

## Input Signals

| Signal | Field | Notes |
|--------|-------|-------|
| Current points rank | `points_rank` | 1 = championship leader |
| Points behind leader | `points_deficit` | |
| Wins this season | `wins` | Regular season wins |
| Playoff eligible | `playoff_eligible` | Bool |
| Races remaining | `races_remaining` | |
| Manufacturer | `manufacturer` | |

## Key Rules

- **points_rank = 1** → base probability 35-45% (spread across field)
- **Not playoff eligible** → hard cap at 0.05 (must win race to enter)
- **< 5 races remaining** → points_deficit > 50 → near-impossible, confidence +10pp
- **Min edge** = 0.04, **confidence floor** = 0.45

## Standard Output

```python
RouterOutput(
    fair_probability=0.28,
    edge=0.08,
    confidence=0.55,
    extra={
        "points_rank": 2,
        "wins": 3,
        "playoff_eligible": True,
        "races_remaining": 18,
    }
)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/run_nascar_futures.py` | Run app against a sample futures input |
