# Escort Runbook

Operational notes for the CPC fighter-escort worker. Full design:
[ESCORT_OPERATING_MODEL.md](./ESCORT_OPERATING_MODEL.md). Repair playbook:
[ESCORT_REPAIR_PATTERNS.md](./ESCORT_REPAIR_PATTERNS.md).

## Run identity
- `run_id`: `esc_<YYYY-MM-DD>_<event-slug>_<NNN>` (America/Chicago date).
- One run = one subject (packet/slate). Never multi-subject.

## Memory files (safe-local only)
- `state/escort/lessons.jsonl` — append-only successful repair patterns.
- `state/escort/blockers.jsonl` — append-only blocker fingerprints.
- `state/escort/runs/<run_id>.json` — per-run proof artifact.

The two `.jsonl` logs are git-ignored (local learning, not committed behavior).
The schemas are the contract — see ESCORT_OPERATING_MODEL.md §4.

## Lesson reuse gate
A lesson is auto-reusable only when BOTH:
- `safe_to_automate_next_time: true`, and
- its `required_proof_before_reuse` is satisfied during the current run.

Otherwise the lesson is advisory only — surface it, do not act on it.

## What the worker may change on its own
Safe notes in this file, ESCORT_REPAIR_PATTERNS.md, and the two memory logs.
Nothing else. Risky/code/process improvements are written as a *proposed* goal and
require a separate reviewed implementation pass.

## Terminal states
- `PASS_READY_TO_SEND` — at the ropes, held, NOT sent.
- `BLOCKED` — hard fail or a repair that would cross a no-touch zone.
- `HELD_DUPLICATE` — idempotency says already delivered.

## Human handoff
On `PASS_READY_TO_SEND` the human throws the punch (authorizes the send). On
`BLOCKED` the worker hands up the blocker fingerprint + diagnosis. The worker
never sends, pushes, or deploys.
