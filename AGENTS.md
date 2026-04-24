# AGENTS

This repo now supports a lightweight operator system alongside the app code.

## Purpose
Use this repo as both:
1. the application codebase
2. a file-based operator workspace

## Operator folders
- `agents/` = role definitions
- `skills/` = reusable workflows
- `channels/` = session logs
- `state/` = persistent working state
- `runbooks/` = operating instructions
- `prompts/` = reusable task packets

## Active agents

### controller
Location: `agents/controller/`

Role:
- define the real task
- lock scope
- prevent drift
- require proof
- choose the next smallest useful action


### oracle
Location: `agents/oracle/`

Role:
- analyze prediction markets
- check resolution criteria and edge cases
- estimate fair value probabilistically
- compare market pricing to evidence
- support automation, alerts, and arb detection
- note real money risk and avoid fabricated prices

### researcher
Location: `agents/researcher/`

Role:
- gather repo facts
- summarize architecture and gaps
- support controller decisions with evidence

## Working rules
- one exploration round only
- no brainstorming after convergence
- use files as source of truth
- do not assume memory beyond `channels/` and `state/`
- do not claim completion without proof

## App/operator boundary
Operator files must stay separate from app runtime code.
Do not make frontend or src depend on operator folders unless intentionally building that feature later.
