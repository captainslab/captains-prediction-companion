# Contributing

Built this for myself. If you make it better, show me.

## Fork first

Fork the repo, run it locally, build your thing. You don't need permission to start. The setup is designed to be cloned and running in under 10 minutes — see the [README quickstart](./README.md#quick-start).

## What's worth contributing

- A new sport or market pipeline that follows the existing `scripts/` pattern
- A new exchange adapter (Polymarket, PredictIt, anything with a REST API)
- A new notification output (Telegram is already specced in `.skills/telegram-notifier.md`)
- A bug fix with a clear reproduction case
- Documentation that would have helped you get started

## How to send it

1. Fork, build, test locally — `npm run demo` and `npm test` should pass
2. Open a PR against `main` with a short description of what it does and why
3. Or just DM Captain on Discord or X — **@CaptainMentions** — if you want feedback before a PR

No formal review process. If it works and fits the project, it gets merged.

## What to include in a PR

- What the change does
- How to test it
- If it adds a new env var, update `.env.example`
- If it adds a new skill, add it to `.skills/SKILLS.md`

That's it.
