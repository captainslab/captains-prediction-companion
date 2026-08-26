# MLB Wikipedia Historical Source

Purpose: standardize public Wikipedia team-season URLs and use them as a historical schedule/final-score cross-check keyed back to MLB `gamePk`.

This adapter is historical-only. It does not enter model features, market pricing, calibration, or live publication decisions.

## Canonical identity

`game_pk` remains the canonical game identifier whenever available.

Wikipedia fields are source metadata:

```text
game_pk
game_date
game_number
away_team
home_team
canonical_url
alternate_url
source_urls
source_key
```

Do not use a Wikipedia URL as the game primary key.

## Canonical URL form

```text
https://en.wikipedia.org/wiki/{YEAR}_{TEAM_NAME}_season
```

Examples:

```text
https://en.wikipedia.org/wiki/2025_New_York_Yankees_season
https://en.wikipedia.org/wiki/2024_Oakland_Athletics_season
https://en.wikipedia.org/wiki/2025_Athletics_season
https://en.wikipedia.org/wiki/2021_Cleveland_Indians_season
https://en.wikipedia.org/wiki/2025_Cleveland_Guardians_season
```

The adapter owns historical franchise naming so callers do not hand-build page names.

## Read-only API form

Use MediaWiki `action=parse` for repeatable machine reads:

```text
https://en.wikipedia.org/w/api.php?action=parse&page={PAGE_TITLE}&prop=wikitext&redirects=1&format=json&formatversion=2
```

Store the page title, page ID, revision ID, content SHA-256, fetch timestamp, and source URLs with each cached response.

## What this source may certify

The standard team-season game log is suitable for:

- game date cross-check
- opponent/home-away cross-check
- final team score
- final opponent score
- winner
- extra-inning count when the score row states it

Use both teams' season pages when useful for reconciliation. A mismatch is a source conflict, not permission to guess.

## What this source must not certify

Do not infer any of the following from a standard team-season row unless an explicitly fetched Wikipedia source actually exposes the needed fields:

- first-inning runs
- YRFI/NRFI truth
- inning-by-inning line score
- starting pitcher identity at a historical prediction cutoff
- historical lineup availability at a prediction cutoff
- sportsbook price or line
- prediction-time information state

For those fields, retain the existing official MLB/Retrosheet/point-in-time source contract. Missing data stays missing.

## Doubleheaders

Match on all available identity fields:

```text
game_pk
game_date
away_team
home_team
game_number
```

If a date/opponent lookup returns more than one candidate and `game_number` cannot disambiguate it, return no match.

## Code

Adapter:

```text
scripts/mlb/source-adapters/wikipedia-historical-readonly.mjs
```

Tests:

```text
test/wikipedia-historical-source.test.js
```

The adapter is optional and fail-closed. It may supplement historical truth reconciliation but must never make the broader MLB pipeline depend on Wikipedia availability.
