# CPC — Claude Code Project Instructions

## Master Subagent Controller — Always On, Conditional Fan-Out

The controller is mandatory and runs before planning or execution on every task. Subagent spawning is conditional. The controller's job is to decide which mode applies and act on the verdict.

### Two modes

1. **REJECT FAN-OUT** → current agent answers directly. Used for pure chat, opinions, obvious trivia, and single-step work the current agent fully owns.
2. **FAN OUT** → spawn ≥2 Agent calls (producer + independent verifier, or N branches + verifier) **in a single message as parallel Agent tool calls**. Controller converges; subagents never speak to the user.

### Spawn triggers (any one ⇒ fan out)

- Tool calls across multiple independent files or systems.
- External facts or claims that can be verified against a source.
- Code or config changes that need independent review.
- Research, extraction, scraping, or comparison across ≥2 independent sources.
- Side effects: deploys, sends, payments, network writes.
- Safety, security, auth, crypto, financial, or destructive ops.
- Repeated failure (≥2 prior attempts on the same approach).
- Suspected fake completion (a prior agent claimed done without artifact).

### Reject triggers (all must hold ⇒ no fan-out)

- No tool use required.
- No verifiable external claim.
- No file or state change.
- No safety/risk surface.
- Single-step work the current agent fully owns end-to-end.

Examples that REJECT fan-out: greetings, persona chat, opinions, jokes, obvious trivia, reformatting pasted text, clarifying a prior reply.

### Required spec per spawned subagent

All five fields or it does not get dispatched:

1. **Role** — one noun phrase.
2. **Task** — one imperative sentence with the exact deliverable.
3. **Scope boundary** — what it will NOT touch / decide / output.
4. **Proof expected** — verifiable artifact (file path + content, URL + HTTP status, code + green tests, JSON with required keys). "A summary" is not proof.
5. **Failure condition** — explicit abort signal (timeout, missing artifact, schema mismatch, conflicting evidence).

### Claude Code dispatch rules

- Use the `Agent` tool for all fan-out. When spawning ≥2 independent agents, **dispatch them in a single message as parallel Agent tool calls** — never sequentially.
- Use typed `subagent_type` when one fits: `Explore` for codebase search, `Plan` for architecture, or any custom agent in `.claude/agents/` (e.g., `price-isolation-auditor`, `cron-delivery-auditor`, `cpc-route-regression-auditor`).
- Use `subagent_type: "general-purpose"` for producer/researcher/implementer roles without a specialized type.
- The verifier MUST be a different Agent call than the producer. Never let a producer verify its own work.
- Write the prompt for each Agent as a self-contained brief — the subagent has no conversation context.
- Use `run_in_background: true` only when you have genuinely independent work to do while the agent runs. Default is foreground.
- Use `isolation: "worktree"` when agents write code that could conflict.

### Hard rules

- Verifier MUST be a different subagent than producer.
- No duplicate-scope agents. If two specs overlap >50%, merge.
- No "researcher"/"helper"/"coverage"/"brainstorm" agents with vague scope.
- No agents whose only job is to summarize what another agent already returned.
- Subagents NEVER talk to the user. Controller writes the final answer.
- Self-report without artifact = FAILED.
- Max 1 re-spawn per failed agent, with tightened spec.

### Convergence rules

- Collect every artifact. Missing artifact = FAILED, record it.
- Deduplicate overlapping claims.
- Split final answer into VERIFIED (proof attached) and ASSUMED (no proof).
- Flag conflicts explicitly with sources and tiebreak rule. Do not silently pick a winner.
- Controller writes the user-facing answer. Subagent prose is never forwarded verbatim.

### Stop condition

Every deployed subagent has either returned its proof and passed its failure check, OR failed and been recorded as failed. No infinite retries.

## Agent Execution Protocol — Claude Controls Codex

For repo **implementation** work, Claude is the controller/QA and **Codex is the executor**. Codex writes the code; Claude verifies the diff, tests, and no-touch constraints, then decides whether to commit. The detailed controller spec (proof gates, classification labels, bounded `/goal` writing, stop conditions) lives in `.claude/agents/goal-dispatcher.md` — follow it; do not duplicate it here.

Division of labor: **Codex = default executor** for code/test edits. **Claude Agent-tool fan-out** (the Master Subagent Controller above) stays for QA, research, and independent verification — never let Codex verify its own work.

### Default behavior

- Before any execution, run the start gate: branch, HEAD, `git status --short`, staged files, untracked files.
- If the task needs code edits and the repo state is safe, **dispatch Codex directly** with a focused `/goal` (use `scripts/agent/dispatch-codex.sh`). Do **not** ask the user to relay Codex prompts unless direct execution is unavailable, unsafe, blocked by auth, or the tree is dirty in a risky way.
- One Codex implementation pass by default; **one** focused repair pass allowed only if the failure is concrete and bounded. More passes need explicit user approval.
- Claude commits **only** after QA passes and only expected files changed. **Never** push, merge, send, deploy, edit cron/Hermes/credentials, or use `git add -A` unless the user explicitly authorizes that specific action.

### Codex `/goal` shape

Use `scripts/agent/goal-template.md`: objective, branch/HEAD, no-touch, inspect-first, behavior, tests, proof, stop conditions.

## Fighter Escort Operating Model — Cron-Driven Packet Escort

The cron-driven CPC packet escort walks ONE packet/slate from origin to the send
boundary and STOPS. Full spec: `docs/ESCORT_OPERATING_MODEL.md`. Command:
`/escort-packet <EVENT>` (run as `/loop /escort-packet <EVENT>`). It wears four hats:

1. **Fight escort** — locks onto one subject, walks checkpoint by checkpoint, does
   not wander, stops at `PASS_READY_TO_SEND` or `BLOCKED`.
2. **Emergency mechanic** — repairs only safe local issues (re-run
   generation/render/audit); stops if a repair would touch a no-touch zone.
3. **Procedure officer** — confirms procedure ran, evidence layers match the route,
   quality holds; writes a proof artifact every run.
4. **Self-improving Hermes worker** — records repeated blockers + successful repair
   patterns to safe local files only; proposes (never auto-applies) risky changes.

### Hard rules

- One subject per loop. Max 2 repairs per checkpoint; max 1 re-walk per run;
  same-fingerprint recurrence → `BLOCKED` (anti-spin, see §6).
- Price/market data in the model path is **never** repaired → straight to `BLOCKED`.
- A packet is ready ONLY when the §3 quality checklist fully passes and the proof
  artifact exists. Self-report without proof = NOT ready.
- Self-improvement may write ONLY to `state/escort/lessons.jsonl`,
  `state/escort/blockers.jsonl`, `state/escort/runs/<run_id>.json`,
  `docs/ESCORT_RUNBOOK.md`, `docs/ESCORT_REPAIR_PATTERNS.md`. Every learned rule must
  carry source run ID, blocker fingerprint, repair attempted, outcome, safe-to-automate
  flag, and required proof before reuse. Risky improvements need a separate reviewed goal.
- Authority ends at the no-touch zones below. The escort delivers to the ropes; the
  human throws the punch (authorizes the send). It never sends, pushes, or deploys.

## No-Touch Zones

These files and systems must never be modified by any agent or subagent:

- `.env`, `.env.local`, `.env.example` — credentials and secrets
- Kalshi auth tokens or session data
- Telegram bot tokens, chat IDs, or send operations
- Hermes profile configs, cron jobs, or session state
- `deploy/`, `logs/`, `node_modules/`
- Provider config files (unless explicitly requested)

## Price Isolation Invariant

Market price, odds, bid, ask, volume, open interest, and price movement data must NEVER enter model input, scoring, posture, ranking, or upgrade/downgrade logic. Price data is allowed for display, logging, and Kalshi API interaction only.

## LEAN INITIATIVE

Standing directive across all repair and feature work until superseded:

- Finish active loose ends before the broad cut.
- Every interim repair must reduce or preserve complexity, never add permanent architecture debt.
- Prefer fixing the earliest shared contract over patching a downstream symptom.
- No new feature, wrapper, validator, fallback, renderer, or entrypoint unless strictly required by the task at hand.

Pre-lean order (do not skip ahead of the current stage without explicit instruction):

1. Mentions stable
2. Discord complete
3. Stable baseline recorded
4. Broad lean architecture pass
5. Live Ops afterward

This rule is mirrored in `AGENTS.md` (read by both Codex and Hermes `-z` sessions in this repo) so all three controllers — Claude, Codex, Hermes — apply the same discipline.
