# Skill: public-alpha-readiness

**Default: active in every session.**

## Purpose

Track what must be true before CPC can be shared with community testers. Block completion claims until criteria are met.

## Launch Criteria (must all be true before tagging v1.0.0-alpha)

- [ ] All public-alpha working tree changes are committed (README, .env.example, package.json, setup/doctor/demo scripts, identity cleanup)
- [ ] NASCAR cc600 changes committed separately from public-alpha docs
- [ ] `CONNECT_CHATGPT.md` contains no live tunnel URLs
- [ ] `npm run demo` passes on the committed state
- [ ] `npm test` passes or known-failing tests are documented
- [ ] `CONTRIBUTING.md` exists (minimum: setup, test, PR instructions)
- [ ] README has a community/support link (Discord or GitHub Issues)
- [ ] Hermes CLI install path is documented or a no-Hermes fallback is explained

## Current Status (as of 2026-05-25)

**Not yet committed:**
- README.md rewrite
- .env.example expansion
- package.json (setup/doctor/demo scripts)
- scripts/setup.mjs, scripts/doctor.mjs, scripts/demo.mjs
- src/captainLabsStore.js (identity cleanup)
- channels/20260422-051818-session.md
- runbooks/mlb-cron-workflow-spec.md
- test/ufc-cron-packet.test.mjs

**Still needed:**
- Fix CONNECT_CHATGPT.md (live tunnel URL on lines 7-8)
- CONTRIBUTING.md
- Community link in README

## Fresh-Clone Test Checklist

A tester on a clean machine runs these steps in order:

```
1.  git clone https://github.com/captainslab/captains-prediction-companion.git
2.  node --version             → must be 18+
3.  npm run setup              → .env created, data/ created, no errors
4.  Edit .env: set GEMINI_API_KEY
5.  npm install
6.  npm run doctor             → ≥4 passed, 0 failed (advisories OK)
7.  npm run demo               → "Demo passed. Server starts and all endpoints respond."
8.  npm start                  → "listening on http://localhost:3000"
9.  curl http://localhost:3000/health  → {"ok":true,...}
10. npm test                   → all tests pass or failures documented
```

## Missing Docs Checklist

| Doc | Status | Priority |
|---|---|---|
| `CONNECT_CHATGPT.md` (remove live URL) | Needs fix | MUST before public share |
| `CONTRIBUTING.md` | Missing | MUST before public share |
| Community/Discord link in README | Missing | MUST before public share |
| Hermes CLI install instructions | Incomplete | MUST before public share |
| `CHANGELOG.md` | Missing | Should add |
| `SECURITY.md` | Missing | Should add |

## Completion Gate

Do not mark any public-alpha task complete unless:
1. The fresh-clone checklist would pass on a machine with only GEMINI_API_KEY configured.
2. The launch criteria list above has no unchecked MUST items.
3. Proof (files changed + commands + output) is provided.
