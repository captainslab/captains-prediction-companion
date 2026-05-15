# MLB Run Log - 2026-05-15

## Run Metadata
- Operator: sports-pre-game
- Started UTC: 2026-05-15T22:22:18.468Z
- Run date: 2026-05-15
- Run folder: state/mlb/2026-05-15/
- Schema version: 1.0
- Mode: output-writer-dry-run

## Source Checks
| Source | Status | Checked UTC | Access method | Limitation |
|---|---|---|---|---|
| Kalshi | ok | 2026-05-15T22:22:18.406Z | Existing discovery JSON | Fixture mode: no live Kalshi source was called. |
| MLB official | ok | 2026-05-15T22:22:18.405Z | Existing discovery JSON | Fixture mode: no live MLB source was called. |
| Baseball Savant | ok | 2026-05-15T22:22:18.406Z | Existing discovery JSON | Fixture mode: no live Baseball Savant/Statcast source was called. |
| Weather | ok | 2026-05-15T22:22:18.406Z | Existing discovery JSON | Fixture mode: no live weather source was called. |
| Liquidity | ok | 2026-05-15T22:22:18.407Z | Existing discovery JSON | Fixture mode: no live liquidity source was called. |
| Optional price sanity | skipped |  | Not called | Optional only |

## Kalshi Intake
| Event | Market | Ticker | Status | Notes |
|---|---|---|---|---|
| Alpha City Aces at Beta Town Bears | captured | KXMLB-PLACEHOLDER-001 | listed | Discovery only |

## Router Results
| Market | Route status | Lane | Candidates | Needed clarification |
|---|---|---|---|---|
| none |  |  |  | No Kalshi same-day markets to route |

## Prediction Status Changes
| Time UTC | ID | Old status | New status | Reason |
|---|---|---|---|---|
| none |  |  |  | No pick candidates were created |

## Failure Handling
| Case | Item | Handling | Next action |
|---|---|---|---|
| kalshi_discovery_degraded | Same-day Kalshi MLB board | No final picks | Re-run live-readonly discovery or inspect Kalshi UI closer to first pitch |
| statcast_adapter_status | Baseball Savant/Statcast | Status ok with 3 records; no final picks | Refresh adapter or keep blocked until usable evidence exists |
| weather_adapter_status | Weather | Status ok with 1 records; no final picks | Refresh adapter or keep blocked until usable evidence exists |
| missing_liquidity | Order book/liquidity | Block tradeability gate | Implement liquidity enrichment |

## Output Writes
| File | Wrote UTC | Status |
|---|---|---|
| state/mlb/2026-05-15/slate_manifest.json | 2026-05-15T22:22:18.468Z | ok |
| state/mlb/2026-05-15/source_registry.json | 2026-05-15T22:22:18.468Z | ok |
| state/mlb/2026-05-15/picks.json | 2026-05-15T22:22:18.468Z | ok |
| state/mlb/2026-05-15/daily-baseball-guide.md | 2026-05-15T22:22:18.468Z | ok |
| state/mlb/2026-05-15/run_log.md | 2026-05-15T22:22:18.468Z | ok |

## No-Trade Confirmation
- No live picks placed.
- No trades placed.
- Output writer read local discovery files only.
