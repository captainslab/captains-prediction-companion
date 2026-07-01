# /compress - Scope Tightening

Use this only when a goal is bloated, repetitive, or mixes multiple objectives. This is not about a model character limit.

Usage: `/compress` for the active goal, or `/compress <text>` to override it.

## Intent

Reduce a noisy goal to the smallest complete version that preserves:
- the measurable objective
- no-touch zones
- required proof
- stop conditions
- the PASS / NEEDS PATCH / BLOCKED contract

## Tightening Order

Cut in this order:
1. narrative or preamble
2. examples that are not required for execution
3. repeated phrasing
4. restated context
5. bundled side quests that should become separate goals

Never cut:
- the actual task
- hard boundaries
- required proof
- stop conditions

## Execute

Once the goal is tight enough to be unambiguous, execute it immediately or hand it to `/fanout` if it clearly needs specialist agents.

## Report

```text
GOAL: <tightened one-line summary>
STATE: TIGHTENED AND EXECUTING | BLOCKED
```

## Rules

- Do not use `/compress` as a default preprocessing step.
- If the goal is already clear, skip this command.
- If tightening would remove a required boundary or proof condition, stop and report BLOCKED.
