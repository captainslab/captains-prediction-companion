# MLB Source Adapter Discovery - 2026-05-16

- Checked UTC: 2026-05-16T17:13:15.141Z
- Mode: live-readonly
- Kalshi source status: degraded
- MLB source status: ok
- Baseball Savant source status: blocked
- Weather source status: ok
- Liquidity source status: ok
- Sportsbook reference status: ok
- Lineup/injury/bullpen status: ok
- Kalshi records found: 30
- Kalshi rejected records: 98
- MLB games found: 15
- Baseball Savant records found: 0
- Weather records found: 17
- Liquidity records found: 10
- Sportsbook reference records found: 15
- Context records found: 15

This is discovery only.
No picks made.
No trades placed.

## Warnings
- Kalshi calendar inaccessible or challenge-gated: HTTP 429.
- Live read-only Statcast CSV checked; Stage 4 records discovery summaries only and makes no picks.
- No usable Statcast rows were returned; MLB schedule context was not emitted as Baseball Savant evidence.
- Live read-only weather records are environment inputs only, not final model evidence or recommendations.
- Live read-only liquidity records are order book inputs only, not final recommendations.
- Sportsbook reference records are not Kalshi prices and are never executable prices.
- Lineup pending is a disclosed evidence state, not a full-slate blocker.

## Errors
- none
