# Agent Guide

How an AI agent (or a careful human) should operate this repo. This is the
condensed operating contract; the full rules live in
[SECURITY_PRIVACY.md](./SECURITY_PRIVACY.md) and `AGENTS.md`.

## Operating principles

1. **Read state before acting.** Never assume local matches last session. Start
   with `git status --short`, `git branch --show-current`, and
   `git log --oneline -5`.
2. **Working tree ≠ committed state.** Treat them separately. Don't build a new
   integration on an uncommitted baseline.
3. **Smallest safe change.** No refactors, no feature creep, no unrelated
   cleanup unless asked.
4. **Proof or it didn't happen.** Every completed task = files changed +
   commands run + actual output.
5. **Stop at no-touch zones.** Report instead of proceeding.
6. **Never push without explicit approval.**

## The standard loop

```
1. inspect repo state      git status / branch / log
2. inspect docs            README, CHANGELOG, docs/, package.json scripts
3. make the smallest edit  (docs / code / changelog)
4. sync docs               npm run docs:update  &&  npm run docs:check
5. run tests               npm test  (or targeted node --test)
6. security/privacy screen secret greps + preflight checklist
7. prepare PR summary      files + commands + output + behavior note
```

## When to run what

| Situation | Command |
|---|---|
| Changed `CHANGELOG.md` or `package.json` | `npm run docs:update` |
| About to commit / open PR | `npm run docs:check` then `npm test` |
| Touched `scripts/shared/` or a generator | `node --test test/decision-packet-shape.test.mjs` + the relevant board test |
| Touched `src/server.js` | full `npm test` (no exceptions) |
| Any commit | the secret greps in SECURITY_PRIVACY.md §1 |

## No-touch zones (refuse without explicit reason)

`.env` · `.env.local` · `.runtime/` · `src/server.js` · `deploy/` · `data/` ·
`state/` · `scratch/` · billing / API keys / payment flows.

## Proof format

Every task report must include:

1. **Files changed** — list with a one-line summary each.
2. **Commands run** — exact, in order.
3. **Output** — actual terminal output, not paraphrased.
4. **Behavior note** — confirm runtime behavior unchanged, or document what
   changed and why.

A claim of completion without proof is rejected.

## Reusable repo-upgrade operator

For repo-presentation/polish work, use the **`cpc-repo-upgrader`** operator at
[operators/cpc-repo-upgrader/SKILL.md](./operators/cpc-repo-upgrader/SKILL.md).
It encodes the full inspect → update → check → test → screen → PR workflow.

## Stop conditions

Stop and report (do not proceed) if:

- A task requires touching a no-touch zone.
- A secret would be logged, committed, or exposed.
- Uncommitted work would be overwritten.
- A new integration is requested but the baseline is not committed.
- Repo access fails or required files are missing.
