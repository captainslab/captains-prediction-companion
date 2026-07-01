# /fanout - Goal-Specific Specialist Fan-Out

Use this when the current goal benefits from multiple narrow specialists instead of one catch-all reviewer.

Usage: `/fanout` for the active goal, or `/fanout <task>` to override it.

## Intent

Fan out only when specialized, goal-specific agents will produce clearer proof faster than a single broad agent. Prefer narrow roles with explicit boundaries over generic "analyze everything" agents.

## Start Gate

Before dispatch:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --cached --name-only
```

Stop if:
- the branch or HEAD is not what the operator expects
- staged files appear unexpectedly
- unrelated dirty or untracked work would make attribution unclear
- the requested work touches a no-touch zone

## When To Fan Out

Fan out only when all of these are true:
- the work naturally splits into independent tracks
- each track has a clear proof artifact
- each track can be evaluated PASS / NEEDS PATCH / BLOCKED on its own
- a specialist role is materially better than a general-purpose reviewer

Do not fan out when the task is atomic, already proven, or can be resolved in one direct pass.

## Author Specialist Agents

Check `.claude/agents/` first for an existing specialist that already matches the job. Reuse it when possible.

If no match exists, create a new narrow agent in `.claude/agents/<name>.md` with:
- one job
- minimal allowed tools
- explicit scope boundaries
- explicit proof expectations
- explicit stop conditions

Bad pattern: one "general auditor" that inspects everything.

Good pattern: separate agents such as route-contract auditor, regression QA auditor, cron delivery auditor, price-isolation auditor, or a one-off specialist tied to the current goal.

## Deploy

Each specialist agent should receive:
- role
- exact task
- bounded file or surface scope
- no-touch zones
- expected proof
- failure condition

Default no-touch zones unless the active goal explicitly scopes them in:
- `.env`, credentials, provider auth, Kalshi auth
- Telegram tokens or send operations
- billing settings
- cron or Hermes runtime
- deploy or production config
- ledger, seen-events, blocker state
- unrelated dirty or untracked files

Also off-limits unless explicitly authorized:
- push
- merge
- send
- trade
- enable jobs
- `git add -A`

Run independent specialists in parallel. Sequence them only when one depends on another's output.

## Collect And Synthesize

Each specialist must return:
- PASS / NEEDS PATCH / BLOCKED
- exact evidence: paths, lines, commands, artifacts
- risk classification
- next action if it failed

Default to one focused repair pass per failed specialist. Do not loop without a concrete new failure signal.

## Report Format

```text
PASS | NEEDS PATCH | BLOCKED
CHANGED FILES: <list>
TESTS: <run, pass/fail counts>
ARTIFACT PROOF: <paths>
SUBAGENTS: <n> deployed - <specialists> (<x> created, <y> reused)
COMMIT HASH: <if committed>
FINAL GIT STATUS: <output>
NO-TOUCH CONFIRMATION: <clean | violation + what>
NEXT: <exact next action>
```

## Rules

- Prefer specialist agents that are specific to the current goal.
- Reuse an existing narrow agent before creating a new one.
- Do not spawn a subagent for work that can be completed directly in one pass.
- Do not use subagents for brainstorming or duplicate opinions.
- If specialist agents are needed, fan them out instead of serializing unrelated review work.
- No-touch zones are hard stops, not judgment calls.
