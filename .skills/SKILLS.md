# CPC Skills Index

Repo-local skill guidance for Claude Code operating in this repo.
Read AGENTS.md first — it defines identity, mission, no-touch zones, and proof requirements.

## Default Skills (always active)

These three skills are active in every CPC session:

| Skill | File | Purpose |
|---|---|---|
| `repo-safety` | `.skills/repo-safety.md` | Protects baseline, blocks secret exposure, enforces commit hygiene |
| `public-alpha-readiness` | `.skills/public-alpha-readiness.md` | Tracks launch criteria and fresh-clone checklist |
| `prediction-card-pipeline` | `.skills/prediction-card-pipeline.md` | Context for src/ and scripts/ work — how cards flow from URL to output |

## Conditional Skills (inactive by default)

Activate only when explicitly working on that feature. Do not apply these rules to unrelated tasks.

| Skill | File | Activate when |
|---|---|---|
| `telegram-notifier` | `.skills/telegram-notifier.md` | Explicitly building Telegram output integration |
| `community-intake` | *(not yet written)* | Explicitly building Discord/GitHub/community input |
| `contributor-docs` | *(not yet written)* | Explicitly writing CONTRIBUTING.md, CHANGELOG, or contributor guides |

## How Default vs Conditional Skills Are Controlled

**Default skills** apply automatically because they protect the repo state that all work depends on.
- `repo-safety` prevents any task from accidentally breaking the baseline or leaking secrets.
- `public-alpha-readiness` prevents tasks from claiming completion before launch criteria are met.
- `prediction-card-pipeline` prevents changes to the pipeline that break the card contract.

**Conditional skills** are scoped to a feature domain. They are not loaded unless the task explicitly names that domain. This keeps the default operating context lean and prevents cross-domain rules from interfering with unrelated work.

A task that says "add Telegram output" activates `telegram-notifier`.
A task that says "fix doctor script" does not activate `telegram-notifier`, even if Telegram was mentioned earlier in the session.

## Current Phase

**public-alpha baseline** — See `AGENTS.md` for the baseline protection rule.
No conditional skills should be activated until the baseline is committed and tagged.
