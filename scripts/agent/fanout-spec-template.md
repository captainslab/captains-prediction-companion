# Agent Fan-Out Brief — <role noun phrase>

> One self-contained brief per spawned subagent. The subagent has **no conversation
> context** — everything it needs must be in this brief. Producer and verifier get
> SEPARATE briefs; a producer never verifies its own work.

## 1. Role
<one noun phrase — e.g. "cache-date auditor", "lexical-gate verifier">

## 2. Task
<one imperative sentence naming the exact deliverable>
<!-- ❌ "look into the mentions cache"
     ✅ "Confirm every packet under state/mentions/<today>/ was rendered from fresh
        research this run, not a prior-day cache, and list any that weren't." -->

## 3. Scope boundary (what it must NOT touch / decide / output)
- No-touch zones: `.env*`, Kalshi/Telegram tokens, Hermes profiles, cron, `deploy/`,
  `logs/`, `node_modules/`, provider configs.
- Price/odds/bid/ask/volume/OI must NEVER enter model input, scoring, posture,
  ranking, or upgrade/downgrade logic (display/logging/Kalshi-API only).
- All date/slate/matchday logic anchors to **America/Chicago**, not UTC.
- <anything else out of scope for THIS agent>

## 4. Proof expected (verifiable artifact — "a summary" is NOT proof)
Pick the concrete form that fits:
- File path + the exact content/lines that prove the claim.
- Command + green test output (`npm test -- <pattern>`).
- JSON object with required keys: `{ event_id, verdict, evidence_path, ... }`.
- URL + HTTP status.

## 5. Failure condition (explicit abort signal)
- <timeout / missing artifact / schema mismatch / conflicting evidence>
- If the deliverable can't be produced with proof → STOP and report what's missing.
- Default to the safe/skeptical verdict when evidence is ambiguous.

---
### Cold-start context to paste in (the agent can't see our chat)
- Branch: <branch>   Expected HEAD: <short SHA>
- Files in scope: <paths>
- Relevant invariants: price isolation · America/Chicago · fresh-research-not-cache · n<2 → NO_TRADE
