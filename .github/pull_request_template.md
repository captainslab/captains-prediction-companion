<!-- CPC pull request template -->

## Summary

<!-- One or two sentences: what this PR does and why. -->

## Changes

<!-- Bullet list of files changed with a one-line summary each. -->
-

## Type of change

- [ ] Docs / presentation only
- [ ] Tooling (scripts, CI, dev workflow)
- [ ] Pipeline / scoring logic
- [ ] Bug fix
- [ ] Other:

## Proof

<!-- Required. Paste actual output, not paraphrased. -->

**Commands run:**
```
npm run docs:check
npm test
git diff --stat
git status --short
```

**Output:**
```
<paste tallies + status here>
```

## Security & privacy screen

- [ ] No `.env` / `.env.local` / `.runtime` / `*.pem` staged
- [ ] No token / webhook / API-key literals in tracked source
- [ ] No new `state/` `data/` `.runtime/` `scratch/` content committed
- [ ] No no-touch zone modified (or explicitly justified below)

## Behavior

- [ ] Runtime behavior unchanged
- [ ] Behavior changed — documented here:

## Notes

<!-- Anything reviewers should know. Do NOT include secrets or live URLs. -->
