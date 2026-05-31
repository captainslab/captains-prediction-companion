# Security & Privacy

CPC is built **secrets-out** and **read-only**. This document is the privacy /
security screen: what is protected, how, and the preflight checklist any human or
agent must clear before touching the repo.

## TL;DR posture

| Area | Posture |
|---|---|
| Secrets | Never read, printed, logged, or committed. Report *presence* only. |
| Trading | Read-only — no orders, no bankroll automation, no execution. |
| Discord/webhooks | Dry-run formatter is offline; live send is authorized-only, env-only URL. |
| Data/artifacts | `state/` `data/` `.runtime/` `scratch/` are runtime, not source-of-truth. |
| Agents | Check `git status` first, no broad refactors, run tests, show proof, no push without approval. |

## 1. Secrets

- **Never read, print, log, or commit** `.env`, `.env.local`, `.runtime/`,
  webhook URLs, bot tokens, API keys, or private keys.
- Tooling may report **presence only** — e.g. "`GEMINI_API_KEY` is set" — never
  the value.
- If a file unexpectedly contains a credential, **stop and report.** Do not
  proceed, do not paste it into output.
- `.env`, `.env*.local`, `*.pem`, and `.runtime/` are gitignored. Keep it that
  way.
- `CONNECT_CHATGPT.md` must not contain a live tunnel URL before sharing — use a
  `YOUR_DEPLOYMENT_URL` placeholder.

### Secret grep (human + agent self-check)

These read patterns, never values. Run before any commit:

```bash
# Nothing secret staged?
git diff --cached --name-only | grep -E '\.env($|\.|local)|\.runtime|\.pem$' && echo "STOP: secret-ish file staged" || echo "ok"

# No token/webhook/key literals in tracked source?
git grep -nE 'discord(app)?\.com/api/webhooks/|mfa\.[A-Za-z0-9_-]{20,}|[0-9]{6,}:[A-Za-z0-9_-]{30,}' -- ':!*.md' || echo "ok: no token/webhook literals"

# No obvious assignment of a secret value?
git grep -nE '(bot_token|api_key|client_secret|webhook_url|bearer)\s*[:=]\s*[A-Za-z0-9_-]{12,}' -- ':!*.md' ':!.env.example' || echo "ok: no secret assignments"
```

If any of these print a match (other than `ok:` / placeholders in `.env.example`),
**stop and remediate before committing.**

## 2. Discord & webhooks

- The Discord formatter (`scripts/shared/discord-format.mjs`) is **offline**:
  no network, no token reads, no sends.
- Live send requires **explicit authorization** and must read the webhook URL
  from an **env var only** — never hard-coded, never logged.
- `scrubSecrets()` redacts token/webhook/key shapes defensively. A non-zero
  redaction count on a packet body means a generator leaked something — treat it
  as a bug.
- The formatter refuses to post raw inventory dumps to a channel.

## 3. Data & artifacts

- `state/`, `data/`, `.runtime/`, and `scratch/` are **runtime / working areas**.
  They are **not** documentation or source-of-truth unless a doc says so
  explicitly.
- New date-scoped runs under `state/packets/`, `state/mlb/`, `state/nascar/`,
  `state/mentions/`, `state/ufc/` are gitignored. Do **not** commit new
  date-scoped runs.
- Raw per-contract inventory belongs in **audit artifacts** (`*.inventory.txt`),
  never in the main packet body.

## 4. Trading boundary (hard)

- **No live orders.** No script in this repo places a trade.
- **No bankroll automation.** No sizing-to-execution path.
- **No execution without explicit future approval.** Even when EV/Kelly math is
  computed, the output is a *posture*, not an order.
- Every generator carries a `No trades placed by this workflow.` footer.

## 5. No-touch zones

Do not modify these without explicit instruction and a stated reason:

| Path | Why |
|---|---|
| `.env`, `.env.local`, `.runtime/` | Real secrets / prod overrides |
| `src/server.js` | Core MCP server — changes require tests to pass |
| `deploy/` | Production deploy templates — do not change paths/service names |
| `data/`, `state/`, `scratch/` | Runtime state — never commit new contents |
| Billing / API keys / payment flows | Refuse all changes |

## 6. Agent preflight checklist

Before any change, an agent (or human) must clear all of these:

- [ ] `git status --short` and `git branch --show-current` inspected; working
      tree understood (clean vs. uncommitted work).
- [ ] Confirmed whether local is ahead of origin (`git log --oneline
      origin/<branch>..HEAD`).
- [ ] Change is the **smallest safe** edit; no unrelated refactor.
- [ ] No no-touch zone touched (or explicitly authorized with a reason).
- [ ] Secret grep above is clean.
- [ ] Tests run (`npm test` or targeted) and pass.
- [ ] `npm run docs:check` is green (or `docs:update` run + reviewed).
- [ ] Proof prepared: files changed + commands run + actual output.
- [ ] **No `git push` without explicit approval.**

## 7. Security check command

There is no script that reads secret values — by design. The check is the grep
block in §1 plus the preflight checklist in §6. To run the full screen quickly:

```bash
npm run docs:check          # docs integrity
npm test                    # behavior unchanged
# then the §1 secret greps
git status --short          # nothing unexpected staged
git diff --check            # no trailing-whitespace / conflict markers
```

If you add an automated security script later, it **must not read or print secret
values** — only their presence and file-name shape.
