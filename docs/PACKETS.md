# Decision Packets

A **decision packet** is CPC's core output: a ranked, sectioned board that puts
the model's view and the market's price side by side so a human can spot edge in
under a minute. Every market type (MLB, NASCAR, mentions/politics) renders the
same shape from the shared renderer in `scripts/shared/decision-packet.mjs`.

## Anatomy

A packet has a TLDR line followed by five sections:

```
TLDR BOARD            counts + headline edge + the neutrality reminder
1. TOP EDGE           PICK / strong LEAN — model fair beats market by a margin
2. WATCHLIST          LEAN / WATCH — thin edge or incomplete evidence + trigger
3. FADES              FADE — market implied runs above model fair
4. BLOCKED            settlement- or model-critical input missing (research gap)
5. AUDIT ARTIFACTS    paths to the raw inventory — never the inventory itself
```

## The decision row

Each contract becomes one row with two strictly separated halves plus the edge
verdict:

- **Composite / model half** — `composite_score`, `composite_posture`,
  `layers_present`, `top_evidence_layers`, `missing_layers`. **No market price
  here.**
- **Market / board half** — `market_yes_bid`, `market_yes_ask`, `last_price`,
  `volume`, `open_interest`, `implied_probability`. **Never scored.**
- **Edge** — `fair_probability_or_range`, `edge_cents_or_pp`, `edge_status`,
  `confidence`.

`edge = model_fair − market_implied`, in percentage points (1pp ≈ 1¢ on Kalshi).

## Edge status & ranking

```
PICK  >  LEAN  >  FADE  >  WATCH  >  BLOCKED  >  PASS
```

| Status | Trigger |
|---|---|
| `PICK` | edge ≥ 7pp with non-low confidence |
| `LEAN` | edge ≥ 3pp, or ≥ 7pp at low confidence |
| `FADE` | edge ≤ −3pp (market overpriced vs model) |
| `WATCH` | inside the lean band / evidence incomplete |
| `BLOCKED` | a settlement- or model-critical input is missing |
| `PASS` | within the ±1.5pp noise band — market is efficient |

## Section examples

These are illustrative shapes, not real picks. Real boards are generated to
`state/packets/...`.

### TLDR BOARD

```
TLDR BOARD:
  rows=14 :: top_edge=2 | watchlist=5 | fades=1 | blocked=3 | pass=3
  headline: [PICK] KXMLBGAME-26MAY31-XYZ HOME_ML (+8pp)
  legend: edge_status PICK>LEAN>FADE>WATCH>BLOCKED>PASS; edge = model fair − market
          implied (pp). Market price is NEVER a composite input.
```

### 1. TOP EDGE CANDIDATES

```
=== 1. TOP EDGE CANDIDATES (2) ===
  Model fair beats market by a strong margin. Confirm trigger before acting.
#1 [PICK] KXMLBGAME-26MAY31-XYZ :: HOME_ML
    model: fair=58% score=0.71 posture=STRONG EVIDENCE LEAN layers=9/13 conf=high
    market: implied=50% yes_bid=0.49 yes_ask=0.51 last=0.50 | edge=+8pp
    why: front-line SP edge + park suppression; lineup confirmed
```

### 2. WATCHLIST / TRIGGER BOARD

```
=== 2. WATCHLIST / TRIGGER BOARD (5) ===
  Edge thin or evidence incomplete; each row lists what makes it playable.
#1 [WATCH] KXMLBGAME-26MAY31-XYZ :: OVER_8_5
    model: fair=53% score=0.55 posture=EVIDENCE LEAN layers=6/13 conf=medium
    market: implied=51% yes_bid=0.50 yes_ask=0.52 last=0.51 | edge=+2pp
    why: pace lean, but bullpen usage unconfirmed
    trigger: price=0.48 when=if line drops pre-lineup
```

### 3. FADES / OVERPRICED

```
=== 3. FADES / OVERPRICED (1) ===
  Market implied runs above model fair.
#1 [FADE] KXMLBGAME-26MAY31-XYZ :: AWAY_ML
    model: fair=42% score=0.40 posture=NO CLEAR PICK layers=7/13 conf=medium
    market: implied=52% yes_bid=0.51 yes_ask=0.53 last=0.52 | edge=-10pp
    why: name-brand SP priced up; underlying form does not support it
```

### 4. BLOCKED / NEEDS SOURCE

```
=== 4. BLOCKED / NEEDS SOURCE (3) ===
  Settlement- or model-critical input missing. Not a pick or a pass — research gap.
#1 [BLOCKED] KXMLBGAME-26MAY31-XYZ :: K_OVER_6_5
    model: fair=model_fair_estimate_pending score=MISSING posture=WATCH layers=3/13 conf=low
    market: implied=55% yes_bid=0.54 yes_ask=0.56 last=0.55 | edge=MISSING
    blocker: probable pitcher unconfirmed — no K-rate anchor
```

### 5. AUDIT ARTIFACTS

```
=== 5. AUDIT ARTIFACTS ===
  pass_rows_not_shown: 3 (efficient/no-edge; full list in audit inventory)
  - state/packets/2026-05-31/mlb-daily/KXMLBGAME-26MAY31-XYZ.inventory.txt
```

## Audit-only raw inventory

The giant per-contract dump (every strike, every price) is **never** in the
board. It is written to a separate `*.inventory.txt` via
`buildInventoryArtifact()` and referenced by path in the Audit Artifacts
section. The Discord formatter refuses to post anything that looks like a raw
inventory dump.

## Rendering API

```js
import {
  buildDecisionRow,
  renderSectionedPacket,
  buildInventoryArtifact,
  rankDecisionRows,
  bucketDecisionRows,
} from '../shared/decision-packet.mjs';
```

- `buildDecisionRow(input)` → one row (composite + market halves + edge).
- `rankDecisionRows(rows)` → rows sorted by status > |edge| > posture > score.
- `bucketDecisionRows(rows)` → `{ topEdge, watchlist, fades, blocked, passes }`.
- `renderSectionedPacket(rows, { auditArtifacts })` → the full board text.
- `buildInventoryArtifact({ marketType, date, eventTicker, inventoryLines })` →
  the audit-only dump text.
