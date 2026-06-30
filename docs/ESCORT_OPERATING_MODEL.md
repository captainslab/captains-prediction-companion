# CPC Fighter Escort — Operating Model

The cron-driven CPC packet escort is a single-subject worker that walks ONE
packet/slate from origin to the send boundary, repairs only safe local issues,
proves quality, and stops cold at the authorization line. It never sends, pushes,
deploys, or mutates credentials/providers/Kalshi/Hermes.

It wears four hats on every run:

1. **Fight escort** — locks onto one packet, walks it checkpoint by checkpoint,
   does not wander, stops at `PASS_READY_TO_SEND` or `BLOCKED`.
2. **Emergency mechanic** — diagnoses broken flow, repairs safe local issues,
   re-runs generation/render/audit, stops if a repair would touch a no-touch zone.
3. **Doc / procedure officer** — confirms the required procedure ran, checks
   evidence layers match the route, checks packet quality, writes a proof artifact
   every run.
4. **Self-improving Hermes worker** — records repeated blockers and successful
   repair patterns to safe local files only; proposes (never auto-applies) risky
   improvements.

---

## 1. Escort state machine

States are linear with bounded repair side-loops. One subject per machine.

```
INIT
 → RESEARCH_CHECK ──fail──> REPAIR(research) ──┐
 → RENDER         ──fail──> REPAIR(render)   ──┤
 → EVIDENCE_CHECK ──fail──> REPAIR(evidence) ──┤   each REPAIR re-enters the
 → AUDIT          ──fail──> REPAIR(audit)    ──┤   SAME checkpoint it came from
 → PRICE_ISOLATION──fail──> BLOCKED (never auto-repair a leak)
 → IDEMPOTENCY    ──dup──>  HELD_DUPLICATE
 → PROOF_WRITE
 → PASS_READY_TO_SEND   ← terminal "at the ropes"
```

Terminal states (machine halts, no further action):
- `PASS_READY_TO_SEND` — every checkpoint clean, proof written, held at send.
- `BLOCKED` — a hard fail or a repair that would cross a no-touch zone.
- `HELD_DUPLICATE` — idempotency says this subject was already delivered.

Transition contract:
- A checkpoint advances ONLY when clean.
- A failed checkpoint routes to its own `REPAIR(x)`, then re-enters the same
  checkpoint. Max 2 repair attempts per checkpoint (see anti-spin).
- `PRICE_ISOLATION` failure is never auto-repaired — straight to `BLOCKED`.
- The machine emits one proof artifact per run regardless of terminal state.

| State | Entry condition | Exit-clean | Exit-fail |
|---|---|---|---|
| INIT | loop fires for subject | always | — |
| RESEARCH_CHECK | INIT done | research exists OR explicit `unavailable` status | REPAIR(research) |
| RENDER | research resolved | render exists, non-empty, not fail-closed | REPAIR(render) |
| EVIDENCE_CHECK | render ok | evidence layers match the route | REPAIR(evidence) |
| AUDIT | evidence ok | presend audit: zero surviving blockers | REPAIR(audit) |
| PRICE_ISOLATION | audit ok | no price/odds/bid/ask/volume/OI in model path | **BLOCKED** |
| IDEMPOTENCY | isolation ok | not previously delivered | HELD_DUPLICATE |
| PROOF_WRITE | idempotency ok | proof artifact written to disk | BLOCKED (cannot write proof) |
| PASS_READY_TO_SEND | proof written | terminal | — |

---

## 2. Emergency mechanic — repair table

Only **safe local** repairs. Any repair whose fix would touch a no-touch zone →
`BLOCKED`, hand up.

| Blocker | Safe repair (allowed) | Re-enter | Hard stop if |
|---|---|---|---|
| Missing research | Run research generator for this run; if source down, set explicit `unavailable` status | RESEARCH_CHECK | repair needs a provider key/config change |
| Stale/cache render | Invalidate local render, regenerate from fresh research | RENDER | cache is in a no-touch store |
| Empty / fail-closed render | Re-run generator; trace the upstream null and fix local data assembly | RENDER | upstream is a provider/Kalshi/Hermes call |
| Evidence layer missing for route | Re-run the missing layer (e.g. settled-history, lexical gate) | EVIDENCE_CHECK | layer requires a provider mutation |
| Audit blocker (fixable) | Apply the audit's safe fix, re-render, re-audit | AUDIT | fix changes scoring semantics or send behavior |
| Timezone drift (UTC leak) | Re-anchor local date/slate logic to America/Chicago | RENDER | drift is in a cron schedule (no-touch) |
| Duplicate delivery state | Respect idempotency, mark HELD_DUPLICATE | — (terminal) | — |
| Price/market data in model path | **none** | — | always → BLOCKED |

Mechanic rule: a repair must be **local, reversible, and behavior-preserving for
send**. Re-running generation/render/audit is the mechanic's main tool. If the
diagnosis points at a no-touch system, the mechanic reports the diagnosis and
stops — it does not "reach in."

---

## 3. Procedure / quality checklist (officer gate)

A packet is **not ready** unless ALL hold:

- [ ] research exists, OR an explicit `unavailable` status is recorded
- [ ] render exists and is non-empty
- [ ] evidence layers match the route (right layers for political/earnings/MLB/WC)
- [ ] presend audit passes (zero surviving blockers)
- [ ] no price/market data entered model input, scoring, posture, or ranking
- [ ] delivery artifact is deterministic (same inputs → same bytes)
- [ ] duplicate / idempotency state respected
- [ ] final status is `PASS_READY_TO_SEND`
- [ ] proof artifact exists on disk

The officer writes the proof artifact every run:
`state/escort/runs/<run_id>.json` containing the checklist result, paths, terminal
state, and any blocker fingerprint. Self-report without this artifact = NOT ready.

---

## 4. Self-improvement memory files

Append-only, safe-local only. The worker learns; it does not auto-mutate behavior.

| File | Purpose | Mutable by escort |
|---|---|---|
| `state/escort/lessons.jsonl` | successful repair patterns + reuse safety | yes (append) |
| `state/escort/blockers.jsonl` | every blocker seen, fingerprinted | yes (append) |
| `state/escort/runs/<run_id>.json` | per-run proof artifact | yes (write) |
| `docs/ESCORT_RUNBOOK.md` | human runbook, schemas, conventions | yes (safe notes) |
| `docs/ESCORT_REPAIR_PATTERNS.md` | curated repair playbook | yes (safe notes) |

**Every learned rule (lessons.jsonl) MUST include:**
```json
{
  "source_run_id": "esc_2026-06-30_<event>_001",
  "blocker_fingerprint": "render.empty:route=mentions:cause=null_research_block",
  "repair_attempted": "regenerate render from fresh research",
  "outcome": "cleared | failed | partial",
  "safe_to_automate_next_time": false,
  "required_proof_before_reuse": "fresh-research artifact path + non-empty render"
}
```

`blockers.jsonl` entry:
```json
{
  "run_id": "esc_...",
  "checkpoint": "AUDIT",
  "fingerprint": "audit.price_leak:field=ask",
  "terminal_state": "BLOCKED",
  "handed_up": true
}
```

Self-improvement rules:
- Learn from repeated failures; do NOT mutate production behavior automatically.
- May write lessons to the safe files above only.
- May **propose** code/process improvements (as a written goal), not apply them.
- May not apply risky improvements without a separate reviewed implementation goal.
- A lesson may only be auto-reused when `safe_to_automate_next_time: true` AND its
  `required_proof_before_reuse` is satisfied that run.

---

## 5. Hard no-touch boundaries

The escort STOPS at these; crossing requires explicit per-action human approval:

- Telegram send / bot tokens / chat IDs / any send operation
- `git push`, merge, `git add -A`
- production deploy / `deploy/` / `logs/`
- `.env`, `.env.local`, `.env.example`, any credential
- Kalshi auth tokens / session data
- Hermes profile configs, cron jobs, session state
- provider config files
- live send behavior or scoring semantics

Authority ends exactly where the no-touch zones begin. Escort to the ropes; release.

---

## 6. Anti-spin rules

- **One subject per loop.** No wandering; finish or hand up before any other.
- **Max 2 repair attempts per checkpoint.** Third → `BLOCKED`, hand up.
- **Max 1 full re-walk per run.** No infinite RESEARCH→RENDER cycles.
- **Same-fingerprint guard.** If a blocker with the same fingerprint recurs after
  a repair, do not retry the same repair — record it and `BLOCKED`.
- **Idempotency first at the boundary.** Already-delivered subject → `HELD_DUPLICATE`,
  never re-walk to a second send.
- **Self-paced backoff.** Near a delivery window, poll tighter; otherwise loose.
  No fixed sub-minute hammering.
- **Every terminal state writes proof and halts.** No silent continuation.

---

## 7. Tests

Contract tests (pure state-machine logic, no network) live in
`test/escort-state-machine.test.mjs`:

- clean walk INIT→…→PASS_READY_TO_SEND when every checkpoint reports clean
- research unavailable with explicit status → advances (not blocked)
- empty render → REPAIR(render) → clean on retry → advances
- empty render fails twice → BLOCKED (anti-spin: max 2 repairs)
- price-isolation failure → BLOCKED with NO repair attempt
- duplicate idempotency state → HELD_DUPLICATE, no send path reached
- every terminal state produces a proof artifact object
- repair that would touch a no-touch zone → BLOCKED, handed_up=true
- same-fingerprint recurrence after repair → BLOCKED (no re-retry)
- lesson written only with all required fields present (schema guard)

Test runner: `node --test test/escort-state-machine.test.mjs`.
Tests are written first (TDD-red) and drive the implementation in §8.

---

## 8. First implementation Codex /goal

Shape per `scripts/agent/goal-template.md`.

```
OBJECTIVE
Implement the CPC fighter-escort state machine as a pure, testable module that
drives one packet/slate from INIT to a terminal state (PASS_READY_TO_SEND |
BLOCKED | HELD_DUPLICATE), writes a proof artifact every run, and appends learned
lessons/blockers — with NO send, push, deploy, or no-touch mutation.

BRANCH / HEAD
Work on a fresh feature branch off current HEAD. Do not push.

NO-TOUCH (abort if a change would require any of these)
.env*, credentials, Kalshi auth, Telegram tokens/send, Hermes profile/cron,
deploy/, logs/, provider config, git push, git add -A, live scoring semantics.

INSPECT FIRST
Read docs/ESCORT_OPERATING_MODEL.md (this file), test/escort-state-machine.test.mjs,
and the existing mentions render/audit entry points referenced by the route.

BEHAVIOR
- Create scripts/escort/escort-state-machine.mjs exporting a pure reducer:
  step(state, checkpointResult) -> nextState, and runEscort(subject, adapters)
  that walks the machine using injected adapters (research/render/evidence/audit/
  idempotency) — adapters are passed in, NEVER imported live, so tests stay offline.
- Enforce anti-spin: max 2 repairs/checkpoint, max 1 re-walk, same-fingerprint guard.
- PRICE_ISOLATION failure routes straight to BLOCKED, no repair.
- Write proof artifact to state/escort/runs/<run_id>.json every terminal state.
- Append blockers to state/escort/blockers.jsonl; append lessons to
  state/escort/lessons.jsonl ONLY when the full required-field schema is present.
- Provide a thin CLI wrapper scripts/escort/run-escort.mjs that wires real adapters
  but STILL stops at PASS_READY_TO_SEND (it must not contain any send call).

TESTS
- Make test/escort-state-machine.test.mjs pass (it is currently TDD-red/guarded).
- All adapters in tests are fakes; no network, no provider calls.
- Run: node --test test/escort-state-machine.test.mjs

PROOF
- Green test output (counts) for the escort test file.
- git diff --check clean; only new files under scripts/escort/ + the test changed.
- A sample proof artifact path printed from a dry CLI run with fake adapters.

STOP CONDITIONS
- Any required change hits a no-touch zone → stop, report BLOCKED.
- Tests not green after one bounded repair pass → stop, hand up the concrete failure.
- Do NOT add a send/push/deploy path under any circumstance.
```
