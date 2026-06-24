# Codex /goal — <short title>

## Objective
<one sentence: the single outcome this pass must produce>

## Branch / HEAD
- Branch: <expected branch, e.g. feat/...>
- Expected HEAD: <short SHA before this pass>

## No-touch
- `.env*`, Kalshi/Telegram tokens, Hermes profiles, cron, `deploy/`, `logs/`, `node_modules/`, provider configs.
- Price/odds/bid/ask/volume/OI must NOT enter model input, scoring, posture, ranking, or upgrade/downgrade logic.
- Do not push, merge, send, deploy, or `git add -A`. Do not touch files outside the scope below.

## Inspect first
- `git status --short` && `git log --oneline -5`
- <files/dirs Codex must read before editing>

## Behavior (required change)
- <bounded list of edits; name the files/areas in scope>

## Tests
- <exact command(s) to run, e.g. `npm test -- <pattern>`>

## Proof to return
- Changed files (`git status --short`) — only the expected set.
- Relevant diff (`git diff -- <path>`).
- Test command + green output.
- Confirm `git diff --cached --name-only` is empty (no surprise staging).

## Stop conditions
- Any no-touch zone touched, unrelated dirty work, or scope creep → STOP.
- Tests fail or cannot run, or required proof can't be produced → STOP and report.
- Objective ambiguous or exceeds scope → STOP, hand back to controller.
