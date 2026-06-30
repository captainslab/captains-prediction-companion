# Escort Repair Patterns

Curated, safe-local repair playbook for the emergency-mechanic hat. Append new
patterns here only when they are local, reversible, and behavior-preserving for
send. Anything that would touch a no-touch zone is NOT a repair pattern — it is a
`BLOCKED` hand-up.

Source of truth for the live table: ESCORT_OPERATING_MODEL.md §2. This file is the
growing, evidence-backed playbook the worker appends to.

## Pattern entry shape
```
### <fingerprint>
- route: <political|earnings|mlb|worldcup|mentions>
- diagnosis: <what the mechanic observed>
- safe repair: <local, reversible action>
- re-enter: <checkpoint>
- proof before reuse: <artifact that must exist>
- safe_to_automate: <true|false>
- source_run_id: <esc_...>
```

## Seed patterns

### render.empty:cause=null_research_block
- route: mentions
- diagnosis: render came back empty because the research block was null/missing.
- safe repair: re-run research generator for this run, then regenerate render.
- re-enter: RENDER
- proof before reuse: fresh-research artifact path + non-empty render.
- safe_to_automate: false (confirm fresh-research bridge ran, never cache).
- source_run_id: (seed)

### date.utc_drift:cause=toISOString_unanchored
- route: any
- diagnosis: slate/date computed in UTC instead of America/Chicago.
- safe repair: re-anchor the local date/slate computation to America/Chicago.
- re-enter: RENDER
- proof before reuse: rendered slate date matches Chicago calendar day.
- safe_to_automate: false (cron-schedule drift is no-touch; only fix local logic).
- source_run_id: (seed)

> Never add a pattern for price/market-data-in-model — that is always BLOCKED.
