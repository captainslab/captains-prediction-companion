# Packet Janitor

The CPC Packet Janitor is the deterministic delivery gate that runs before a
packet is sent to Telegram. It checks packet artifacts for structural errors,
source-health problems, and obvious delivery hazards. It does not rewrite
evidence, picks, scores, source layers, or rationale.

## Purpose

The janitor exists to keep bad packets out of Telegram and to make the
decision path auditable. Its job is delivery QC, not modeling.

## Flow

```
DETECT -> SAFE_REPAIR -> VALIDATE -> SEND_ALLOWED or BLOCK -> REPORT
```

The janitor inspects a packet, applies at most one deterministic safe repair,
validates the repaired or original text, then reports a verdict.

## Safe repairs

Allowed repairs are deterministic formatting or packaging fixes only:

- Strip wrapper text such as `Cronjob Response:`.
- Remove raw dry-run / send-plan chatter when a valid packet body remains.
- Normalize title or header formatting.
- Restore the `NOT IN SCORE` label when the market-context section exists.
- Fix section order only when the required sections already exist.
- Split an oversized but valid packet into clean `.txt` chunks.
- Rebuild missing sidecar/meta data when the answer is deterministic from the
  packet text.
- Rerun the generator once when the artifact is missing but the source/cache
  inputs already exist and the command is known.

If the packet still fails after one safe repair attempt, the janitor blocks
delivery.

## Hard blocks

The janitor blocks packets when the problem cannot be fixed without inventing
evidence or changing the customer text. Common hard-block cases include:

- Empty or missing packet.
- Model scaffold leakage.
- Dry-run-only output with no valid packet body.
- Market values leaking into scoring or rationale sections.
- Missing source layers without an explicit blocker explanation.
- High `NO_CLEAR_PICK` ratio without a source-backed cancellation explanation.
- Contradictory score and posture.
- Missing idempotency ledger or duplicate-send uncertainty.
- Any packet that would require a model rewrite of the final customer text.

## Source-health checks

When source-health is required, the janitor checks for:

- `FETCH_SOURCE_MISSING` - no source/cache health artifact found.
- `FETCH_SOURCE_EMPTY` - source artifact exists but has no usable records.
- `FETCH_SOURCE_STALE` - artifact is older than the freshness window.
- `FETCH_SOURCE_SCHEMA_INVALID` - artifact cannot be parsed or has invalid
  shape.
- `FETCH_AUTH_BLOCKED` - 401 / 403 style auth failure in HTTP-shaped fields.
- `FETCH_RATE_LIMITED` - 429 / rate-limit style failure.
- `FETCH_JOIN_KEY_MISSING` - required join key absent for per-record sources.
- `FETCH_PARTIAL_COVERAGE` - source coverage is incomplete.
- `FETCH_REAL_LAYER_ZERO` - source artifact reports zero populated layers.
- `FETCH_CACHE_ONLY` - cache-only or stale-source mode was detected.

Cache-only / stale-source packets are treated as warnings only when the packet
itself clearly discloses that state. If the packet does not disclose it, the
janitor blocks.

`FETCH_CACHE_ONLY` fires on explicit cache signals (`from_cache: true`,
`cache_only: true`, `stale_cache`, `live: false`) or when a source artifact
carries no live-fetch key **and** no recognized freshness timestamp at all. A
fresh `generated_utc` (or `updated_utc` / `checked_at` / `fetched_utc`) field is
treated as live enough on its own and does not make an artifact cache-only;
its age is judged separately by `FETCH_SOURCE_STALE`.

## Join keys

The janitor accepts the join keys used by the current CPC source artifacts,
including:

- MLB: `gamePk`, `game_pk`, `matched_game_pk`, `game_id`
- UFC: `fight_id`, `match_id`
- World Cup: `match_id`, `game_id`
- Mentions: `event_ticker`, `market_ticker`, `espn_event_id`

Reference manifests and non-per-record source manifests are not required to
carry a per-game join key.

## NO_CLEAR_PICK policy

`NO_CLEAR_PICK` is only legitimate when evidence truly cancels out.

- MLB: a high `NO_CLEAR_PICK` ratio needs explicit source coverage, cancellation
  evidence, and a missing-layer explanation.
- UFC: a no-clear row must have source-coverage support plus a closeness signal,
  validated per row or per fight, not just at the packet level. The closeness
  signal is satisfied by explicit close-margin phrasing, a tight numeric score
  pair such as `53-52` (abs diff <= 3), or cancellation/separation language like
  "edge did not separate", "fully scored", or "no clear dominant path". Rows with
  neither coverage nor any closeness signal are still blocked.
- Mentions: no packet is valid only when blocker artifacts explain the
  fail-closed reason.

## Verdicts

- `SEND_ALLOWED` - the packet passed validation and can move to Telegram.
- `SEND_ALLOWED_AFTER_REPAIR` - the packet was repaired deterministically and
  then passed validation.
- `JANITOR_WARNING` - the packet is deliverable, but the artifact records a
  known issue that was disclosed and is not fatal.
- `JANITOR_BLOCKED` - the packet must not reach Telegram.

Operator response:

- `SEND_ALLOWED` - send normally.
- `SEND_ALLOWED_AFTER_REPAIR` - inspect the repaired copy, then send that copy.
- `JANITOR_WARNING` - deliver only if the warning is expected and acceptable.
- `JANITOR_BLOCKED` - do not send the packet body. Inspect the debug artifact
  and fix the source artifact or packet generator first.

## CLI

Use `scripts/cron/cpc-packet-janitor.mjs` directly:

```bash
node scripts/cron/cpc-packet-janitor.mjs preflight --date 2026-06-16 --type mentions-daily --state-root state
node scripts/cron/cpc-packet-janitor.mjs validate-file --file state/packets/2026-06-16/worldcup-matchday/worldcup.txt --date 2026-06-16 --type worldcup-matchday
node scripts/cron/cpc-packet-janitor.mjs validate-dir --dir state/packets/2026-06-14/ufc-weekly --state-root state --type ufc-weekly
node scripts/cron/cpc-packet-janitor.mjs repair-file --file state/packets/2026-06-15/mlb-daily/board.txt --date 2026-06-15 --type mlb-daily
node scripts/cron/cpc-packet-janitor.mjs postflight --date 2026-06-15 --type mlb-daily --state-root state
```

## Artifacts

Per-run janitor outputs land under:

- `state/janitor/<date>/delivery-manifest.json`
- `state/janitor/<date>/*.janitor.json`
- `state/janitor/<date>/*.debug.txt` for blocked packets
- repaired packet copies or chunk files when repair succeeds

The manifest records the pass/warn/block mix for the whole packet set. The
sidecar records the per-file verdict, repair info, source-health findings, and
output paths. The debug file is only written for blocked packets and contains a
short operator-facing explanation.

## Current proof-run results

Based on the recent proof run:

- MLB `2026-06-15`: overall `JANITOR_BLOCKED`; 8 `SEND_ALLOWED`, 3 blocked.
  The remaining blockers are real packet issues — ranked `[PICK]/[LEAN]/[WATCH]`
  rows with `score=MISSING` — that come from the generator, not from the
  janitor. These blocks are correct and intentionally unchanged.
- UFC `2026-06-14`: the composite's single no-clear (O'Malley vs Zahabi, 53-52,
  full layer coverage, "edge did not separate the matchup") is now correctly
  recognized as justified and is no longer blocked for that reason. The earlier
  `JANITOR_BLOCKED` here was a detector gap — the close-margin check did not
  understand the generator's numeric score-pair / separation format — not a real
  modeling failure. Legacy per-fight `KXUFCFIGHT-*` reference boards still block
  because they are not v2 CPC packets (missing `CPC Packet:` / `NOT IN SCORE`).
- World Cup `2026-06-16`: `SEND_ALLOWED`.
- Mentions `2026-06-16`: `JANITOR_WARNING`; fail-closed behavior is explained
  by blocker artifacts.

## Test status

- `test/cpc-packet-janitor.test.mjs` passes `28/28` (added cache-only freshness
  and real-format UFC no-clear coverage).
- The combined bundle
  `test/cpc-packet-janitor.test.mjs test/cron-script-only-guard.test.mjs test/mlb-send-due-guard.test.mjs`
  passes `55/55`. The sender guard test that previously failed (`52/53`) failed
  because a fresh `generated_utc`-only source artifact was wrongly flagged
  cache-only; that over-block is fixed.

## Readiness

The current janitor state is best described as `JANITOR_READY_WITH_WARNINGS`.
The two known over-blocks (cache-only false positive on `generated_utc`
artifacts, and UFC no-clear close-margin format gap) are fixed and covered by
tests. The remaining MLB `2026-06-15` blocks are real generator/contract issues
(`score=MISSING` ranked rows), not janitor defects, and are left untouched.
