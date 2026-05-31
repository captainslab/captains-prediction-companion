# Architecture

Captains Prediction Companion (CPC) is a **research-only** prediction-market
system. It ingests a market, scores it with a market-neutral composite model,
and renders a decision packet that puts the model's view and the market's price
side by side.

## Two faces of CPC

CPC has two cooperating surfaces:

1. **MCP server** (`src/server.js`) — a live Node service that ChatGPT or any
   MCP-compatible client talks to. It accepts a market URL, classifies it, runs
   it through the AI pipeline, and returns a structured prediction card.
2. **Packet generators** (`scripts/packets/`) — batch CLIs that build a full
   day's decision board for a sport/market class and write it to `state/`.

Both share the same scoring vocabulary and the same decision-packet renderer.

## Data flow

```
                 ┌──────────────────────────┐
   market URL ──▶│  classify market type     │
                 │  (sports / mention / pol) │
                 └─────────────┬─────────────┘
                               ▼
              ┌────────────────────────────────────┐
              │  composite evidence ledger          │   model half
              │  (form, matchup, venue, lineup …)   │   — NO market price
              │  → score, posture, fair probability │
              └────────────────┬───────────────────┘
                               │
   market data ───────────────┼──────────────┐       market half
   (bid/ask/last/vol/OI)      │              ▼       — NEVER scored
                               ▼     ┌─────────────────┐
                     ┌──────────────▶│ buildDecisionRow │
                     │               └────────┬────────┘
                     │                        ▼
                     │            edge = fair − implied (pp)
                     │                        ▼
                     │            ┌────────────────────────┐
                     └───────────▶│ renderSectionedPacket   │
                                  │ TLDR / Top Edge / Watch /│
                                  │ Fades / Blocked / Audit  │
                                  └────────────────────────┘
```

## The neutrality boundary (the core invariant)

The single most important rule in the codebase:

> **Market price, bid/ask, volume, and open interest are carried ONLY in the
> `market` half of a decision row and are NEVER read back into composite
> scoring.**

- The composite half arrives already-scored from the domain model
  (`mention_composite`, MLB scoring-core, NASCAR ceiling, …).
- `buildDecisionRow()` does not mutate composite fields with market data.
- Edge is the *comparison* of the two halves: `model_fair − market_implied`,
  always in percentage points, always model-vs-market.

This is enforced in `scripts/shared/decision-packet.mjs` and locked by
`test/mlb-composite-neutrality.test.mjs` and the decision-board test suites.

## Shared layers

| Module | Responsibility |
|---|---|
| `scripts/shared/decision-packet.mjs` | Row schema, edge math, ranking, sectioned board, audit-inventory split |
| `scripts/shared/decision-process.mjs` | Market-type checklists + posture gate (NO CLEAR PICK → STRONG EVIDENCE LEAN) |
| `scripts/shared/discord-format.mjs` | Offline Discord dry-run formatting (no network, no tokens) |
| `scripts/packets/lib/common.mjs` | Arg parsing, state-dir layout, audit writing, Telegram-safe chunking |
| `scripts/packets/lib/kalshi-discovery.mjs` | Event/market normalization from Kalshi |

## Edge status vocabulary

Every row resolves to one `edge_status`, ranked for the board:

```
PICK  >  LEAN  >  FADE  >  WATCH  >  BLOCKED  >  PASS
```

- **PICK** — model fair beats market by a strong margin (≥7pp) with confidence.
- **LEAN** — moderate edge (≥3pp) or strong edge at low confidence.
- **FADE** — market implied runs above model fair (overpriced).
- **WATCH** — thin edge or incomplete evidence; needs a trigger.
- **BLOCKED** — settlement- or model-critical input missing (research gap, not a
  pass).
- **PASS** — inside the noise band (≤1.5pp); the market is efficient.

## Cross-pipeline agents

Three operator agents sit above all pipelines (see `AGENTS.md`):

- **`@companion-router`** — normalizes incoming markets, routes to the correct
  pipeline.
- **`@alphaagent`** — data acquisition (Kalshi, stats APIs, weather), auth,
  rate-limit handling, freshness reporting.
- **`@decision-logic`** — shared EV / Kelly / CLV / fair-value math and exposure
  caps. Emits a canonical posture, never an executed trade.

## What CPC deliberately does not do

- No live order placement, bankroll automation, or trade execution.
- No market price feeding composite scores.
- No raw contract inventory inside the user-facing board (audit file only).
- No secret reads/prints/commits.

See [SECURITY_PRIVACY.md](./SECURITY_PRIVACY.md) for the full boundary set.
