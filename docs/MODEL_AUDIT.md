# CPC Model Audit

Status: audit current as of 2026-05-31 (branch `fix/decision-packets-composite-market`).
Scope: read-only model inventory, source-gap audit, calibration capability, and
market-neutrality verification across all CPC model families. No scoring weights
were changed by this audit.

## Cardinal rule (verified)

Market price — bid, ask, last, midpoint, volume, open interest, implied prob —
**never** enters composite scoring. Market data is used only for post-hoc edge
comparison: `edge = model/reference fair − market implied`. This audit confirms
the rule holds structurally and, for MLB/NASCAR/mentions, by regression test.

---

## 1. Model inventory

| Family | Scoring core(s) | Layers / weights | Output | Market in score? |
|---|---|---|---|---|
| MLB | `scripts/mlb/lib/evidence-ledger.mjs` | 13 layers, weights sum = 1.00 (renormalized over present layers) | per-side `composite_score`, evidence ledger, total signal | No |
| MLB | `scripts/mlb/lib/multi-lane-ceiling.mjs` | gating thresholds (ML/RL/TOTAL/YRFI) | 8 lanes + CLV metadata | No |
| MLB | `scripts/mlb/scoring-core.mjs` | gate/threshold ladder | classifications + `edge_pp` | Reads price for `edge_pp` ONLY (post-model) |
| NASCAR | `scripts/nascar/lib/final-ceiling.mjs` | 7 layers, sum = 1.00 (one at 0.00, always UNAVAILABLE) | single `final_ceiling` + ledger | No |
| NASCAR | `scripts/nascar/lib/multi-lane-ceiling.mjs` | 5 SCORE_PARTS, sum = 1.00 | win/top_5/top_10/top_20 lanes | No |
| NASCAR | `scripts/nascar/lib/ceiling.mjs` | 4 discovery fields (sp/practice/long-run/points) | one ceiling market/driver | No |
| Mentions | `scripts/mentions/mention-composite-core.mjs` | profile-supplied layer defs (political 9, earnings 10), sum = 1.00 | composite, posture, ledger | No (throw-guard) |
| Mentions | `scripts/mentions/source-ladder.mjs` | 6-tier trust order + qualification cap | posture cap | No (throw-guard) |
| Politics | `scripts/politics/lib/*` (branch swarm) | qualitative — NO numeric composite | rendered research report | No (tier-6 context only) |
| UFC | `scripts/packets/generate-ufc-weekly.mjs` | none — packet only, shared decision-process | WATCH-capped board | n/a (no model) |
| Shared | `scripts/shared/decision-process.mjs` | 8 market-type checklists | decision status | No |
| Shared | `scripts/shared/decision-packet.mjs` | edge thresholds (7/3/1.5 pp) | sectioned packet | Reads price for implied-prob edge ONLY |

Key facts:
- **UFC has no model code.** Only a Kalshi board capture, hard-capped at WATCH.
- **Politics has no numeric composite.** It is an LLM branch swarm with a
  7-tier source classifier (market = tier 6, low-trust) and integrity checks.
- All weighted composites sum to 1.00 and renormalize over present layers
  (missing layers are never zero-filled).

---

## 2. Source / data gaps

| Family | Critical gap | Availability | Difficulty | Value | Risk | Recommendation |
|---|---|---|---|---|---|---|
| MLB | Park-factor adapter (neutral 100 hardcoded) | free static tables | low | high | none | implement (backlog) |
| MLB | Statcast batted-ball (barrel/whiff) | blocked (Savant 403) | high | med | fragile scrape | backlog (Firecrawl spike) |
| MLB | Live lineup/injury context default | built, defaults to fixture mode | low | high | none | flip default (op change) |
| NASCAR | Generic live practice/qualifying fetcher | snapshot-only (one race) | med | high | fragile scrape | backlog |
| NASCAR | Official race context/results feed | fixture-only | med | high | fragile scrape | backlog |
| Mentions | Transcript word-match ingestion (#1 tier) | hand-fed, no fetcher | high | high | login/paid excluded | backlog (Firecrawl spike) |
| Mentions | SEC filing keyword fetch (EDGAR) | free, no auth | low | med | none | implement (backlog) |
| Mentions | Earnings calendar | stub | low | med | scrape-fragile | implement (backlog) |
| Politics | Official .gov / reporting evidence fetch | manual/LLM branch only | med | high | scrape-fragile | backlog |
| UFC | Fighter record / form / status | missing entirely | med | high | scrape-fragile | backlog |
| UFC | Settlement-criteria parse | in Kalshi payload, unparsed | low | med | none | implement (backlog) |

Note: `scripts/mlb/source-adapters/stats-readonly.mjs` **is built and wired** into
`late-slate-composite-refresh.mjs`. The AGENTS.md "stats adapter NOT built"
handoff (lines ~271-300) is **stale doc-debt**, not a live gap.

---

## 3. Calibration & backtest capability

Measurable now:
- MLB post-hoc W/L/Push grading against **real box scores** (`statsapi.mlb.com`,
  not price) via `scripts/mlb/composite-backtest-report.mjs` `evaluateOutcome()`.
- Per-bucket hit-rate roll-ups (the calibration skeleton) by market type and
  model-metric bucket.
- CLV struct + delta math exist (`buildClvTrackingMetadata`), metadata-only.

Not measurable now:
- **No committed outcome/result store in any schema.** `picks.json` logs
  predictions (`fair_probability`, `final_status`, `side`) but has no `result` /
  `settled_outcome` / `graded_at` field. Predictions persist; outcomes do not.
- Mentions / politics / NASCAR have **no outcome resolver** at all.
- CLV cannot be measured longitudinally (no committed time-series of prices).
- No cross-date Brier / log-loss / reliability-curve aggregator.

To enable per-family calibration (backlog):
1. A committed/seed graded-outcome ledger per family (`settled_outcome` = event
   result, never closing price).
2. An outcome field added to the prediction schema so prediction+outcome join
   reproducibly offline.
3. Per-family settlement resolvers mirroring MLB's `fetchFinalResults`.
4. A `scripts/shared/calibration-report.mjs` aggregator (read-only, analysis
   only — same pattern as the existing MLB backtest report).

A read-only calibration scaffold **can be added safely** — the MLB backtester is
precedent (asserts `no_trades_placed`, neutrality-test-guarded). The blocker is
data (a committed outcome ledger), not safety.

---

## 4. Market-neutrality verdict

| Family | Verdict | Evidence |
|---|---|---|
| MLB | PASS | pinned by `test/mlb-composite-neutrality.test.mjs` (pollute-vs-clean deepEqual) |
| NASCAR | PASS | structurally neutral + **new** `test/nascar-composite-neutrality.test.js` |
| Mentions | PASS | active throw-guard `assertNoPricingInLayer` + tests |
| Politics | PASS | no numeric composite; **new** `test/politics-neutrality.test.mjs` |
| UFC | n/a | no model |

Grep result: **zero score-path market hits**. Every market identifier traces to
ingest, display, post-hoc edge, a presence-only gate, audit/PnL, or an active
throw-guard. `market_reference_prob` (renamed from `fair_value`) is confined to
edge/display paths only.

---

## 5. Recommendations (priority order)

1. (DONE this pass) Add NASCAR + politics market-neutrality regression tests.
2. Add a committed per-family outcome ledger + `settled_outcome` schema field,
   then a read-only `calibration-report.mjs` aggregator (Brier/log-loss/CLV).
3. MLB park-factor adapter (free static data, removes hardcoded neutral 100).
4. Mentions EDGAR filing fetch + earnings-calendar (free, no-auth quick wins).
5. Clean up stale AGENTS.md stats-adapter handoff (doc-debt).

High-risk / explicit-approval-required (NOT done here): global MLB layer
reweighting, live scraping of fragile sites, any market-price-as-input change,
`src/server.js` edits, delivery-behavior changes.
