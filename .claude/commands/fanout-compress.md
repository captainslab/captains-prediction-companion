# /fanout-compress - Tighten, Then Fan Out

Use this only when a goal is both noisy and genuinely benefits from multiple specialist agents.

Usage: `/fanout-compress` for the active goal, or `/fanout-compress <text>` to override it.

## Flow

1. Apply `/compress` only to remove noise, repetition, or bundled side quests.
2. If `/compress` reports `BLOCKED`, stop there.
3. If the goal is now clean and still needs multiple specialists, apply `/fanout`.

## Report

```text
GOAL: <tightened one-line summary>
PASS | NEEDS PATCH | BLOCKED
SUBAGENTS: <n> deployed - <specialists> (<x> created, <y> reused)
NO-TOUCH CONFIRMATION: <clean | violation + what>
NEXT: <exact next action>
```

## Rules

- Do not use this command just because the goal is long.
- If the work does not need specialists, stop after `/compress` or execute directly.
- Prefer goal-specific specialist agents over general catch-all reviewers.
