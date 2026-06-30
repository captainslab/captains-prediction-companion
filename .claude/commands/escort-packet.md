# /escort-packet — Fighter Escort Loop (CPC packet)

Escort ONE CPC packet to send-ready, clearing each checkpoint, then STOP at the
send boundary. Run as a self-paced loop: `/loop /escort-packet <EVENT>`.

Usage: `/escort-packet <EVENT>` (e.g. an event slug, MLB game, or WC match).
One subject per loop. If no `<EVENT>` is given, ask which one — never escort more
than one fighter at a time.

## Escort rule

Bonded to one subject. Each iteration: find where the fighter is on the walk,
clear the next checkpoint, keep moving. Do not advance until the current
checkpoint is clean. Do not wander to another packet.

## Checkpoints (in order)

1. **Fresh research** present for this run? If not, run it. Never render from cache.
2. **Render.** If empty or fail-closed, fix the upstream cause and re-render.
3. **Presend audit.** Run `/mentions-presend-audit`. Surviving blocker → repair if
   safe, else hold.
4. **Price isolation.** No price/odds/bid/ask/volume/OI in scoring, posture, rank.
5. **Timezone.** All date/slate logic anchored to America/Chicago.

Repair each blocker at most twice. Third strike or a hard fail → stop and hand up
the concrete blocker.

## Hard boundary — STOP, never cross

Telegram send · `.env`/credentials · Kalshi auth/session · Hermes profile/cron ·
providers config · `deploy/` · `git push` · `git add -A`. Escort to the ropes;
release. The send is the human's punch, not the loop's.

## Proof required before "at the ropes" (no proof = not ready)

- Rendered-packet path + confirmed non-empty / not fail-closed.
- Fresh-research artifact path for this run (proves no cache render).
- `/mentions-presend-audit`: zero surviving blockers.
- Price-isolation: clean.
- Stated boundary: "held at SEND, not sent."

Missing any artifact ⇒ report the gap and HOLD.

## Report (concise only)

```text
FIGHTER: <event>
AT: <checkpoint N or AT THE ROPES>
CLEARED: <checkpoints passed>
BLOCKER: <none | concrete blocker, held>
PROOF: <paths + audit result>
STATE: ESCORTING | AT THE ROPES (HELD, NOT SENT) | HANDED UP
```
