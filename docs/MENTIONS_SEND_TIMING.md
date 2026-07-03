# Mentions packet send timing — buffer before event start

## Symptom
Mentions packets arrive ~at the event start, leaving no time to get action ready.
Target: a 30–60 min buffer.

## How mentions are delivered
`scripts/mentions/mentions-watch.mjs` runs from cron (wrapper
`scripts/mentions/mentions-watch.sh`). Each run discovers **same-day** Kalshi
mention markets and sends each packet **once, on first discovery** — there is no
"deliver N minutes before start" logic. Delivery time ≈ discovery time.

Two throttles shape when a packet actually lands:
1. **Per-run cap** — the wrapper sets `MENTIONS_WATCH_MAX_NEW_PER_RUN=1`
   (deliberate: one full generate+synthesize+send is ~3–7 min and must finish
   inside the cron runner's 600s script timeout).
2. **Cron cadence** — ~15 min between ticks.

So prod drains **~1 event per 15-min tick**. A day with 8 events spreads over
~2h. Evidence (2026-07-03 `seen-events.json`): deliveries at 00:01, 00:17, 00:46,
01:02, 01:17, 01:31, 01:46, 02:01 UTC. Mentions also frequently render
`event_time_central: UNCONFIRMED`, so the pipeline usually can't schedule against
a real start time.

## Fix shipped in code (this commit)
`mentions-watch.mjs` now orders each run's queue **soonest-closing event first**
(`orderByImminence` / `eventImminenceMs`, by `close_time` / `expected_expiration_time`
— time fields only, price-isolation preserved) *before* the throttle slice.

Effect: even at cap=1, the single event delivered each tick is now the **most
imminent** one. An about-to-start packet jumps to the front of the queue instead
of waiting behind events discovered earlier that have hours of runway. By
construction, the events delivered last are the ones with the most runway.

The module default cap was also raised `3 → 6` for non-wrapper callers; **prod is
still governed by the wrapper env (currently 1)** — see below to widen it.

Residual gap the code fix can't close: an event whose Kalshi market is *listed*
close to its start is discovered late; ordering can't back-date discovery. That's
what the cron changes below address.

## Recommended Hermes / wrapper changes (apply on deploy — cron is operator-owned)

These are drafts for you/the operator to apply; cron schedules + the Hermes
profile are not edited by the agent.

### 1. Run the watcher more frequently — biggest lever for late-listed events
Change the mentions-watch cron from ~every 15 min to **every 5 min**, so a
newly-listed market is picked up within ≤5 min instead of ≤15:

```cron
# before (approx):  */15 * * * *  .../mentions-watch.sh
# after:
*/5 * * * * cd /home/jordan/captains-prediction-companion && bash scripts/mentions/mentions-watch.sh
```
The single-run lock (`acquireRunLock`) already makes overlapping fires exit 0, so
a fast cadence is safe even if a run occasionally exceeds 5 min.

### 2. Optionally widen the per-run cap 1 → 2 (drains clustered slates ~2× faster)
In `scripts/mentions/mentions-watch.sh`:
```sh
export MENTIONS_WATCH_MAX_NEW_PER_RUN="${MENTIONS_WATCH_MAX_NEW_PER_RUN:-2}"
```
Tradeoff: 2 events/run ≈ 6–14 min, which can exceed the 600s script timeout on
slow events. This is safe (the run lock + idempotent delivery ledger mean a
timeout mid-second-event just resumes next tick — no double-send), but keep it at
1 if your cron runner's timeout is tight. Ordering means even cap=1 sends the
most imminent event first.

### 3. Optionally start the daily scan earlier
If a fixed daily discovery/generation cron (`mentions-daily.sh`) gates the slate,
move its fire time earlier in the day so the batch is discovered with more runway.

## What this does NOT do
- It cannot create lead time for a market Kalshi lists only at start (data limit).
- It does not schedule against event start (mentions often have no confirmed start).
  The lever is *earlier/faster discovery* + *imminent-first ordering*, not a timer.
