# Pilot Repo Map

- Repo path: `/home/jordan/captains-prediction-companion`
- Branch: `feat/mentions-cpc-renderer`
- Current HEAD: `14749cced36fce5cface59427cdf6d5089ca8754`
- Remote tracking: `origin/feat/mentions-cpc-renderer` at the same commit

## PMT Milestone Commits

- `f426a709a63a8ccddd2eb5043a85b05db681e6d9` - `docs: add PMT mentions playbook and transcript inventory`
- `14749cced36fce5cface59427cdf6d5089ca8754` - `feat: add PMT advisory context for Trump mention packets`

## PMT Files Changed

- `docs/mentions/pmt-trump-mentions-playbook.md`
- `docs/mentions/pmt-transcript-inventory.md`
- `docs/mentions/pmt-transcript-inventory.json`
- `scripts/mentions/pmt-advisory-context.mjs`
- `scripts/packets/generate-mentions-daily.mjs`
- `scripts/mentions/render-mention-packet.mjs`
- `test/mentions-pmt-advisory-context.test.mjs`

## Unrelated Dirty Files

- `scripts/cron/cpc-packet-janitor.mjs`
- `scripts/mlb/lib/article-render.mjs`
- `scripts/packets/generate-mention-event-proof.mjs`
- `test/mentions-cache-only-disclosure.test.mjs`
- `test/mentions-watch-lock-timeout.test.mjs`
- `docs/superpowers/`
- `scripts/packets/deploy-ingame-test-send.sh`
- `state/previews/`
- `state/research/`

## Proof Commands and Results

- Focused mention tests: `69/69` passed
- Branch pushed to origin: yes
- Telegram send: no
- Cron change: no
