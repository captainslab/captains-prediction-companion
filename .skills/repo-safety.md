# Skill: repo-safety

**Default: active in every session.**

## Purpose

Prevent working baseline loss, secret exposure, and destructive changes during CPC development.

## Rules

### Baseline protection

- Before adding any integration or new feature, confirm the public-alpha working tree changes are committed.
- Never build on uncommitted changes. If `git status` shows modified or untracked files that represent completed work, commit them first.
- Do not amend published commits. Create new commits instead.
- Tag stable checkpoints: `v1.0.0-alpha` = first externally-testable baseline.

### Secret hygiene

- Never read, log, print, or commit `.env`.
- Never include API keys, tokens, or passwords in file contents, commit messages, or proof output.
- If a file unexpectedly contains a credential, stop and report — do not proceed.
- `CONNECT_CHATGPT.md` must not contain live tunnel URLs before public share. Replace with `YOUR_DEPLOYMENT_URL` placeholder.

### Commit hygiene

- Stage files explicitly by name. Never `git add -A` or `git add .` without reviewing what's included.
- Separate concerns into distinct commits: public-alpha docs/tooling in one commit, NASCAR/pipeline work in another.
- Run `git diff --check` before committing — no trailing whitespace in committed files.
- Confirm `npm run demo` passes before tagging a release.

### No-touch zones (enforced by this skill)

| Path | Rule |
|---|---|
| `.env` | Never read, log, or commit |
| `data/` | Never commit runtime contents |
| `state/` | Never commit new date-scoped run artifacts |
| `.runtime/` | Gitignored; do not modify or expose |
| `deploy/` | Do not change example file names or service unit names |
| `src/server.js` | Changes require passing tests |

### What to do when a rule is triggered

Stop the current task. Report: which rule was triggered, what action was blocked, and what the safe path forward is. Do not attempt to work around the rule.
