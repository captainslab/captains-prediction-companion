# Kalshi Mentions Discovery

## Status
**Updated 2026-06-10.** The Kalshi API's general `category=Mentions` and `status=open` event listings are **unreliable** for discovering earnings-call mention markets. True mention markets exist but are organized under series tickers (e.g. `KXEARNINGSMENTION*`) with empty event status fields, making them invisible to standard category+status queries.

## Root Cause
- Earnings-call mention markets are under series tickers like `KXEARNINGSMENTIONCBRL`, `KXEARNINGSMENTIONV`, etc.
- Event containers have `status: ""` (empty string) and no `close_time`.
- Markets have `status: "active"` and `close_time`.
- General queries with `status=open` filter out these events because the container status is empty.

## What We Did
1. Added `KALSHI_SOURCES.broad` — queries without category filter (catches mention markets that DO have status).
2. Added `fetchMentionEventsBySeries()` — scans all series for mention-related tickers, then fetches events per-series **without status filter**.
3. Added `classifyMentionMarket()` — detects mention-style language in event/market/contract text.
4. Added `filterMentionEvents()` — filters discovery results to only true mention markets.
5. Updated `generate-mentions-daily.mjs` to **merge** broad discovery + series-scan discovery, deduplicating by `event_ticker`.

## How It Works Now
```
fetchKalshiEvents('broad')          // General listing (catches active-status mentions)
  -> filterByEventDate()
  -> filterMentionEvents()

fetchMentionEventsBySeries()        // Series scan (catches empty-status mentions like CBRL)
  -> filterByEventDate()
  -> filterMentionEvents()

Merge + dedupe by event_ticker
  -> buildKalshiEventPacket()
```

## Mention-Style Detection
Positive signals (must have one):
- "will X say" / "will X mention"
- "say during" / "mention during"
- "transcript" / "earnings call" / "conference call"
- "speech" / "remarks"

Negative signals (automatic rejection):
- IPO timing, M&A close, acquisition
- Production/delivery/passenger/store metrics
- CEO succession, leadership changes
- "when will" / "will achieve" / "will announce" / "will close"
- Standard election/political winner markets

## No-Results Behavior
When zero mention markets exist, the generator:
- Does NOT fail
- Writes a clean `no-events` packet with classification stats
- Reports: total events scanned, mention events found, rejected events, markets scanned

## CBRL Example
Cracker Barrel (CBRL) earnings-call mention market **was missed** by general category queries because:
- Series: `KXEARNINGSMENTIONCBRL`
- Event status: empty string
- Event close_time: missing
- Only discoverable via `series_ticker` query or series scan

The series-scan discovery now finds it and 132+ other earnings mention series.

## Files Changed
- `scripts/packets/lib/kalshi-discovery.mjs` — added broad source, series scan, classifier, filter
- `scripts/packets/generate-mentions-daily.mjs` — merges broad + series-scan discovery
- `test/mentions-classifier.test.mjs` — 14 tests proving detection accuracy

## Backward Compatibility
- `KALSHI_SOURCES.mentions` is kept with deprecation comment.
- Existing code using `fetchKalshiEvents('mentions')` still works but returns non-mention events.
