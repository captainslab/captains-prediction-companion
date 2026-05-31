---
name: Repo upgrade / polish
about: Request a documentation or presentation upgrade handled by the cpc-repo-upgrader operator
title: "[repo-upgrade] "
labels: documentation
---

## Goal

<!-- What should the repo look/read like after this? -->

## Scope

- [ ] README presentation
- [ ] docs/ (ARCHITECTURE / USAGE / PACKETS / DISCORD / SECURITY_PRIVACY / AGENT_GUIDE)
- [ ] CHANGELOG entry
- [ ] Auto-update blocks (CPC:UPDATES / CPC:STATUS)
- [ ] Security / privacy screen
- [ ] Other:

## Operator

Use the `cpc-repo-upgrader` operator: `docs/operators/cpc-repo-upgrader/SKILL.md`.

## Constraints

- Smallest safe change; no unrelated refactors.
- No secrets read/printed/committed.
- `npm run docs:check` and `npm test` must pass.
- Do not push without explicit approval.

## Proof expected

Files changed + commands run + actual output (`docs:check`, `npm test`,
`git diff --stat`, `git status --short`) + behavior-unchanged note.
