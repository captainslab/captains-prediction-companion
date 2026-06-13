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
