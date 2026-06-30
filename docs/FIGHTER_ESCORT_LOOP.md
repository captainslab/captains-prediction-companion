# Fighter Escort Loop — CPC default `/loop` pattern

One loop escorts **one subject** through fixed checkpoints to the authorization
boundary ("the ropes"), actively repairing safe blockers along the way, and
**stops** before any side effect. The loop clears the path; the human throws the
punch.

## Invariants (every escort loop)
- One subject per loop. No wandering to the next fighter until this one is
  delivered or formally handed up.
- Clear, ordered checkpoints. Advance only when the current one is clean.
- Actively repair **safe** blockers (re-run research, re-render, fix upstream).
- Never send Telegram. Never push. Never deploy.
- Never touch credentials / providers / Kalshi / Hermes / cron / `.env` / `deploy/`.
- Stop at the authorization boundary. Output is concise only.

---

## 1. CPC packet escort

```
/loop Escort the <EVENT> packet to send-ready. One subject only.
Checkpoints, in order:
  1. Fresh research present for this run? If not, run it. Never render from cache.
  2. Render. If empty or fail-closed, fix the upstream cause and re-render.
  3. Run /mentions-presend-audit. If a blocker survives, repair if safe, else hold.
  4. Price-isolation clean (no price/odds/bid/ask/volume/OI in scoring/posture/rank).
  5. Timezone: all date/slate logic anchored to America/Chicago.
Repair each blocker at most twice; on a third or a hard fail, stop and hand up.
Deliver standing at the SEND boundary. Do NOT send. Hold until I authorize.
Concise output only.
```

## 2. Repo PR / feature escort

```
/loop Escort this PR/feature to merge-ready. One subject only.
Checkpoints, in order:
  1. Run the relevant test suite. On failure, make ONE bounded repair, re-run.
  2. git diff --check clean; only expected files changed (no git add -A).
  3. Run /code-review. Resolve safe findings; hold unsafe/ambiguous ones for me.
Re-fight a failure at most twice; on a third, stop and hand up the concrete blocker.
Deliver standing at the MERGE/PUSH boundary. Do NOT push. Hold until I authorize.
Concise output only.
```

---

## 3. Hard boundary — the loop MUST stop, never cross

| Boundary | Loop stops at |
|---|---|
| Telegram send | renders + audits, hands a send-ready packet |
| `git push` / merge | commits locally only (when QA passes), never pushes |
| Deploy | never runs deploy; `deploy/` is no-touch |
| Credentials / `.env*` | never reads to mutate, never writes |
| Kalshi auth/session | never touches |
| Hermes profile / cron | never edits |
| Providers config | never edits unless explicitly told this run |
| `git add -A` | never; stages only the expected files |

Authority ends exactly where the no-touch zones begin. Escort to the ropes; release.

---

## 4. Proof required before "at the ropes"

The loop may only declare the fighter ready by returning verifiable artifacts —
self-report without proof = NOT ready:

**CPC packet**
- Path to the rendered packet + confirmation it is non-empty / not fail-closed.
- Fresh-research artifact path for this run (proves no cache render).
- `/mentions-presend-audit` result: zero surviving blockers.
- Price-isolation: clean (auditor pass or explicit no-leak confirmation).
- Stated boundary: "held at SEND, not sent."

**Repo PR/feature**
- Test command + green output (counts), not "tests pass."
- `git diff --check` clean; list of exactly-changed files.
- `/code-review` result: safe findings resolved, unsafe ones listed for human.
- Local commit SHA (if committed); explicit "not pushed."
- Stated boundary: "held at MERGE/PUSH, not pushed."

Missing any artifact ⇒ fighter is NOT at the ropes; loop reports the gap and holds.
