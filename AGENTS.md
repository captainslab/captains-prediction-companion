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

### mentions-researcher
Location: `agents/mentions-researcher/`

Role:
- research mention markets as exact-string future-language proof markets
- use Firecrawl for official-source discovery and transcript/source extraction
- produce rules-first evidence packets without making picks
- separate historical word-match evidence, current context, prompt-force paths, and unresolved gaps

### mentions-mcp-forecaster
Location: `agents/mentions-mcp-forecaster/`

Role:
- treat market price as prior
- update with transcript/context evidence
- apply MixMCP damping
- calculate TV, edge, LSP, max entry, and trade gate

### captain-x-writer
Location: `agents/captain-x-writer/`

Role:
- convert completed internal research and trade-gate packets into Captain X guide drafts
- preserve required public guide sections and code-box tables
- avoid source dumps, fabricated picks, and publishing side effects

### captainmentions-article-formatter
Location: `agents/captainmentions-article-formatter/`

Role:
- convert completed mention-market research packets into CaptainMentions-style X Article drafts
- preserve the observed Section A-G structure, proof-market voice, board tables, live playbook, groups, sneaky NOs, coffee CTA, and signoff
- refuse to invent picks, prices, or TV/edge math when inputs are incomplete

## Working rules
- one exploration round only
- no brainstorming after convergence
- use files as source of truth
- do not assume memory beyond `channels/` and `state/`
- do not claim completion without proof

## App/operator boundary
Operator files must stay separate from app runtime code.
Do not make frontend or src depend on operator folders unless intentionally building that feature later.
