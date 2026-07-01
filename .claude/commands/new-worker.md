# /new-worker - Controller Spine → Fresh Worker Packet

Use this when the current chat has accumulated context (the controller spine) and you
need to hand ONE clean, disposable task to a fresh `/new` worker without leaking stale
goals, dead ends, or superseded facts into its context.

Usage: `/new-worker` for the active goal, or `/new-worker <objective>` to override it.

## Intent

Treat the current long-lived chat as the **controller spine**. It holds history, prior
attempts, and evolving state. A worker should NOT inherit that history — it should
receive only what is true and required for one bounded task, right now.

`/new-worker` produces a single self-contained packet that a fresh `/new` session can
execute with zero prior context. The controller does NOT execute the task; it authors
the packet, hands it off, and later grades the worker's `PASS / NEEDS_PATCH / BLOCKED`
return.

## Hard Rules

- The controller **authors** the packet only. It does NOT execute the task in this chat.
- Emit exactly **one** worker packet per invocation. One subject, one deliverable.
- Include only **currently valid** facts. Explicitly list stale/superseded context under
  "Ignore" so the worker cannot silently re-inherit it.
- Every packet must demand a `PASS / NEEDS_PATCH / BLOCKED` return with proof.
- No-touch zones are hard boundaries, not judgment calls (see below).

## Start Gate

Before authoring, capture the ground truth the worker will start from:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

Stop and report BLOCKED if:
- the branch or HEAD is not what the objective assumes
- the working tree is dirty in a way that makes the worker's scope ambiguous
- the objective is unclear or would require touching a no-touch zone

## Distill The Spine

Before writing the packet, separate signal from history:

1. **Keep** — facts, constraints, and decisions that are true *right now* and required
   for this one task.
2. **Ignore** — earlier goals, abandoned approaches, superseded facts, and resolved
   sub-threads. Name them explicitly so the worker discards them on sight.
3. **Drop entirely** — anything unrelated to the objective. Do not mention it at all.

If a fact from the spine cannot be verified as still true, either re-verify it or move it
to "Ignore." Never forward an unverified assumption as a current fact.

## Worker Packet Template

Emit the packet in a single fenced block so it can be pasted verbatim into a `/new`
session. Fill every field; leave none implicit.

```text
# WORKER PACKET

## Objective
<one imperative sentence: the exact deliverable>

## Current valid facts
- <fact true right now, required for this task>
- ...

## Ignore (stale / superseded — do NOT re-inherit)
- <old goal, dead end, or replaced fact from the spine>
- ...

## Repo / worktree / branch
- repo: <path>
- worktree: <path if applicable>
- branch: <branch>
- HEAD: <sha>

## Allowed scope
- <files / surfaces the worker MAY touch>

## No-touch zones
- .env, credentials, provider auth, Kalshi auth
- Telegram tokens, chat IDs, send operations
- Hermes profile configs, cron jobs, session state
- billing / payment settings
- deploy/, logs/, node_modules/
- provider config files (unless the objective explicitly scopes them in)
- ledger, seen-events, blocker state
- unrelated dirty or untracked files
- also off-limits: push, merge, send, trade, enable jobs, `git add -A`

## Exact process
1. <ordered step>
2. ...

## Tests
- <exact command(s) to run>

## Proof required
- <verifiable artifact: file path + content, command + output, green tests, JSON keys>

## Stop conditions
- <explicit abort signal: no-touch touched, ambiguous scope, missing artifact, ≥2 failed passes>

## Return format
Reply with exactly one verdict and its evidence:
- PASS — deliverable met + proof attached
- NEEDS_PATCH — concrete failure + what a bounded repair pass would fix
- BLOCKED — hard stop hit + which condition + what is needed to unblock
Do not execute anything outside Allowed scope. Do not touch no-touch zones.
```

## Handoff

After emitting the packet:
- Instruct the operator to paste it into a fresh `/new` worker session.
- The controller stays here and waits for the worker's `PASS / NEEDS_PATCH / BLOCKED`
  return, then grades it against Proof required.
- On `NEEDS_PATCH`, author a tightened follow-up packet (one bounded repair) rather than
  re-sending the original.

## Report Format

```text
WORKER PACKET EMITTED | BLOCKED
OBJECTIVE: <one-line>
BRANCH/HEAD: <branch> @ <sha>
KEPT FACTS: <n>
IGNORED (stale): <n>
NO-TOUCH CONFIRMATION: <clean | violation + what>
NEXT: paste packet into a fresh /new worker; await PASS/NEEDS_PATCH/BLOCKED
```

## Rules

- One packet, one subject, one deliverable per invocation.
- The controller authors; it never executes the worker's task in this chat.
- Stale goals and dead ends go under "Ignore," never forwarded as current facts.
- Every packet ends with a `PASS / NEEDS_PATCH / BLOCKED` + proof contract.
- No-touch zones and off-limits actions are hard stops.
- If the objective is unclear or a no-touch zone would be touched, stop and report BLOCKED.
- This command does not replace `/fanout`, `/compress`, or `/fanout-compress`; it hands a
  clean single task to a fresh worker instead of splitting or tightening the active goal.
