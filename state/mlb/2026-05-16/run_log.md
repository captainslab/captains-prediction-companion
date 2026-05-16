# MLB Run Log - 2026-05-16

## Run Metadata
- Operator: sports-pre-game
- Started UTC: 2026-05-16T16:18:30.002Z
- Run date: 2026-05-16
- Run folder: state/mlb/2026-05-16/
- Schema version: 1.0
- Mode: output-writer-dry-run

## Source Checks
| Source | Status | Checked UTC | Access method | Limitation |
|---|---|---|---|---|
| Kalshi | degraded | 2026-05-16T15:39:22.043Z | Existing discovery JSON | Kalshi calendar inaccessible or challenge-gated: HTTP 429. |
| MLB official | ok | 2026-05-16T15:02:39.418Z | Existing discovery JSON | Schedule/status only |
| Baseball Savant | blocked | 2026-05-16T15:02:43.180Z | Existing discovery JSON | Live read-only Statcast CSV checked; Stage 4 records discovery summaries only and makes no picks.; No usable Statcast rows were returned; MLB schedule context was not emitted as Baseball Savant evidence. |
| Weather | ok | 2026-05-16T15:39:18.082Z | Existing discovery JSON | Live read-only weather records are environment inputs only, not final model evidence or recommendations. |
| Liquidity | blocked | 2026-05-16T15:02:43.217Z | Existing discovery JSON | No Kalshi market tickers provided; cannot fetch liquidity. |
| Sportsbook reference | ok | 2026-05-16T15:39:34.189Z | Existing discovery JSON | Sportsbook reference records are not Kalshi prices and are never executable prices. |
| Lineup/injury/bullpen | ok | 2026-05-16T15:39:50.042Z | Existing discovery JSON | Lineup pending is a disclosed evidence state, not a full-slate blocker. |
| Optional price sanity | skipped |  | Not called | Optional only |

## Kalshi Intake
| Event | Market | Ticker | Status | Notes |
|---|---|---|---|---|
| San Francisco vs A's | captured | KXMLBGAME-26MAY162140SFATH | listed | Discovery only |
| Los Angeles D vs Los Angeles A | captured | KXMLBGAME-26MAY162138LADLAA | listed | Discovery only |
| San Diego vs Seattle | captured | KXMLBGAME-26MAY161915SDSEA | listed | Discovery only |
| New York Y vs New York M | captured | KXMLBGAME-26MAY161915NYYNYM | listed | Discovery only |
| Boston vs Atlanta | captured | KXMLBGAME-26MAY161915BOSATL | listed | Discovery only |
| Texas vs Houston | captured | KXMLBGAME-26MAY161910TEXHOU | listed | Discovery only |
| Milwaukee vs Minnesota | captured | KXMLBGAME-26MAY161910MILMIN | listed | Discovery only |
| Chicago C vs Chicago WS | captured | KXMLBGAME-26MAY161910CHCCWS | listed | Discovery only |
| Cincinnati vs Cleveland | captured | KXMLBGAME-26MAY161810CINCLE | listed | Discovery only |
| Miami vs Tampa Bay | captured | KXMLBGAME-26MAY161610MIATB | listed | Discovery only |
| Philadelphia vs Pittsburgh | captured | KXMLBGAME-26MAY161605PHIPIT | listed | Discovery only |
| Baltimore vs Washington | captured | KXMLBGAME-26MAY161605BALWSH | listed | Discovery only |
| Arizona vs Colorado | captured | KXMLBGAME-26MAY161510AZCOL | listed | Discovery only |
| Kansas City vs St. Louis | captured | KXMLBGAME-26MAY161415KCSTL | listed | Discovery only |
| Toronto vs Detroit | captured | KXMLBGAME-26MAY161310TORDET | listed | Discovery only |
| San Francisco vs A's: Total Runs | captured | KXMLBTOTAL-26MAY162140SFATH | listed | Discovery only |
| Los Angeles D vs Los Angeles A: Total Runs | captured | KXMLBTOTAL-26MAY162138LADLAA | listed | Discovery only |
| San Diego vs Seattle: Total Runs | captured | KXMLBTOTAL-26MAY161915SDSEA | listed | Discovery only |
| New York Y vs New York M: Total Runs | captured | KXMLBTOTAL-26MAY161915NYYNYM | listed | Discovery only |
| Boston vs Atlanta: Total Runs | captured | KXMLBTOTAL-26MAY161915BOSATL | listed | Discovery only |
| Texas vs Houston: Total Runs | captured | KXMLBTOTAL-26MAY161910TEXHOU | listed | Discovery only |
| Milwaukee vs Minnesota: Total Runs | captured | KXMLBTOTAL-26MAY161910MILMIN | listed | Discovery only |
| Chicago C vs Chicago WS: Total Runs | captured | KXMLBTOTAL-26MAY161910CHCCWS | listed | Discovery only |
| Cincinnati vs Cleveland: Total Runs | captured | KXMLBTOTAL-26MAY161810CINCLE | listed | Discovery only |
| Miami vs Tampa Bay: Total Runs | captured | KXMLBTOTAL-26MAY161610MIATB | listed | Discovery only |
| Philadelphia vs Pittsburgh: Total Runs | captured | KXMLBTOTAL-26MAY161605PHIPIT | listed | Discovery only |
| Baltimore vs Washington: Total Runs | captured | KXMLBTOTAL-26MAY161605BALWSH | listed | Discovery only |
| Arizona vs Colorado: Total Runs | captured | KXMLBTOTAL-26MAY161510AZCOL | listed | Discovery only |
| Kansas City vs St. Louis: Total Runs | captured | KXMLBTOTAL-26MAY161415KCSTL | listed | Discovery only |
| Toronto vs Detroit: Total Runs | captured | KXMLBTOTAL-26MAY161310TORDET | listed | Discovery only |

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
| statcast_adapter_status | Baseball Savant/Statcast | Status blocked with 0 records; no final picks | Refresh adapter or keep blocked until usable evidence exists |
| weather_adapter_status | Weather | Status ok with 17 records; no final picks | Refresh adapter or keep blocked until usable evidence exists |
| missing_liquidity | Order book/liquidity | Block tradeability gate | Implement liquidity enrichment |

## Output Writes
| File | Wrote UTC | Status |
|---|---|---|
| state/mlb/2026-05-16/slate_manifest.json | 2026-05-16T16:18:30.002Z | ok |
| state/mlb/2026-05-16/source_registry.json | 2026-05-16T16:18:30.002Z | ok |
| state/mlb/2026-05-16/picks.json | 2026-05-16T16:18:30.002Z | ok |
| state/mlb/2026-05-16/daily-baseball-guide.md | 2026-05-16T16:18:30.002Z | ok |
| state/mlb/2026-05-16/run_log.md | 2026-05-16T16:18:30.002Z | ok |
| state/mlb/2026-05-16/today-execution-board.json | 2026-05-16T16:18:30.002Z | ok |
| state/mlb/2026-05-16/today-execution-board.md | 2026-05-16T16:18:30.002Z | ok |

## No-Trade Confirmation
- No live picks placed.
- No trades placed.
- Output writer read local discovery files only.
