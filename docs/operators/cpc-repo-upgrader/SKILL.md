---
name: cpc-repo-upgrader
description: Reusable operator for polishing the Captains Prediction Companion repo — upgrade docs/README presentation, keep auto-update blocks in sync, run the privacy/security screen, run tests, and prepare a PR summary. Read-only on secrets; never pushes without approval.
when_to_use: When asked to improve CPC repo presentation, refresh docs, update the changelog/README blocks, add a doc, or prepare a polished PR — and any time the README auto-blocks may be stale.
version: 1.0.0
---

# CPC Repo Upgrader

A repeatable workflow for making the Captains Prediction Companion repo
professional, easy to use, and self-documenting — without breaking the baseline
or leaking secrets.

> This is the **repo-local draft** of the operator (travels with the repo). To
> promote it to a Hermes skill, see "Install as a Hermes skill" at the bottom.

## Trigger conditions

Use this operator when the task is any of:

- "Upgrade / polish / clean up the repo presentation."
- "Refresh the docs / README / changelog."
- "The Latest Updates / Project Status block looks stale."
- "Document the packet pipeline / Discord formatter / security posture."
- "Prepare a PR that makes the repo look serious."

## Inputs expected

- The repo at `/home/jordan/captains-prediction-companion` (or a clone).
- A clean or understood working tree (inspect first).
- Optionally: a specific doc/section to add or a changelog entry to write.

## Outputs expected

- Updated docs under `docs/` and/or `README.md`.
- Regenerated `CPC:UPDATES` / `CPC:STATUS` README blocks.
- A new `CHANGELOG.md` entry when behavior/docs changed.
- Green `npm run docs:check` and `npm test`.
- A PR summary with files + commands + output.

## No-touch zones

Never modify without explicit instruction + a stated reason:
`.env`, `.env.local`, `.runtime/`, `src/server.js`, `deploy/`, `data/`,
`state/`, `scratch/`, billing / API keys / payment flows.

## Workflow

### 1. Inspect repo state
```bash
git branch --show-current
git log --oneline -5
git status --short
git status -sb
git log --oneline origin/$(git branch --show-current)..HEAD || true   # ahead of remote?
```
Confirm whether local is ahead of origin before editing. Treat working tree and
committed state as separate.

### 2. Inspect docs & structure
Read: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `package.json` scripts, `docs/`,
`.github/`, and the relevant `scripts/` you are documenting. Document what the
code actually does — read it, don't guess.

### 3. Update docs / changelog / README
- Edit docs under `docs/` with the smallest changes that achieve the goal.
- Add a `CHANGELOG.md` entry (Keep-a-Changelog format, newest at the top under
  the intro) when anything user-facing changed.
- Only ever hand-edit README text **outside** the `CPC:UPDATES` / `CPC:STATUS`
  markers — the marked blocks are generated.

### 4. Sync the auto-blocks
```bash
npm run docs:update     # rewrite ONLY the marked README blocks
npm run docs:check      # must exit 0
```
`docs:update` is deterministic — sourced from `CHANGELOG.md` + `package.json`,
no git hash, no timestamps in the committed output. Run it whenever the changelog
or package version changes.

### 5. Run tests
```bash
npm test                                          # full suite
# or targeted when scope is narrow:
node --test test/decision-packet-shape.test.mjs
node --test test/discord-format.test.mjs
```

### 6. Privacy / security screen
Run the secret greps from `docs/SECURITY_PRIVACY.md` §1 and the preflight
checklist §6. Confirm:
- no `.env` / `.runtime` / `*.pem` staged,
- no token/webhook/key literals in tracked source,
- no new `state/` `data/` `.runtime/` `scratch/` content committed.

### 7. Prepare PR summary
Use `.github/pull_request_template.md`. Include files changed, commands run,
actual output, and a behavior-unchanged note.

## Proof requirements

Every run must produce:
1. Files changed (list + one-line summary each).
2. Commands run (exact, in order).
3. Output (actual, not paraphrased): `docs:check`, `npm test` tallies,
   `git diff --stat`, `git status --short`.
4. Behavior note: runtime unchanged, or what changed and why.

## Example prompt

> "Polish the CPC repo: refresh the README, add a docs/USAGE.md, write a
> changelog entry for the decision-packet refactor, keep the README update
> blocks in sync, run the security screen and tests, and prepare a PR summary.
> Do not push."

## Example final report (shape)

```
Files changed:
  - README.md            rewrite + auto-blocks regenerated
  - CHANGELOG.md         new entry: decision-packet refactor + docs system
  - docs/USAGE.md        new: every command, copy-paste ready
  ...
Commands run:
  npm run docs:update    -> ✓ blocks updated
  npm run docs:check     -> ✓ up to date
  npm test               -> # pass 507  # fail 0
Security screen:
  secret greps           -> ok (no matches)
  staged sensitive files -> none
git diff --stat          -> N files changed
git status --short       -> only intended files
Behavior: docs/tooling only; no runtime code path changed.
NOT pushed (awaiting approval).
```

## Install as a Hermes skill (optional, approval required)

This draft lives in the repo so it travels with the code. To promote it to a
reusable Hermes skill for the captain profile:

```bash
# Review first, then create under the active profile's skills dir:
mkdir -p ~/.hermes/profiles/captain/skills/software-development/cpc-repo-upgrader
cp docs/operators/cpc-repo-upgrader/SKILL.md \
   ~/.hermes/profiles/captain/skills/software-development/cpc-repo-upgrader/SKILL.md
```

Do not install globally without explicit approval. Keep the repo-local copy as
the source of truth; the installed copy is a convenience mirror.
