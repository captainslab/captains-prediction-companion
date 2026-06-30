# World Cup Advances Backtest — Data Sources

## Source 1: eloratings 2022 Results

**URL:** `https://www.eloratings.net/2022_results.tsv`

**HTTP Status:** 200 ✓

**Format:** Tab-separated values (TSV)

**Column Legend** (0-indexed, tab-delimited):

| Index | Column      | Description |
|-------|-------------|-------------|
| 0     | year        | Year |
| 1     | month       | Month |
| 2     | day         | Day |
| 3     | homeCode    | Home team ISO code |
| 4     | awayCode    | Away team ISO code |
| 5     | homeGoals   | Goals scored by home team |
| 6     | awayGoals   | Goals scored by away team |
| 7     | typeCode    | Competition type (e.g., WC for World Cup, NOT round) |
| 8     | venueCode   | Venue code |
| 9     | eloChange   | Change in Elo rating |
| 10    | homeElo     | Home team Elo rating after match |
| 11    | awayElo     | Away team Elo rating after match |

**Known Facts:**
- The `typeCode` column represents the COMPETITION, not the round. All 2022 World Cup matches have `typeCode = "WC"`.
- Penalty shootouts are recorded as draws with no winner — the separate shootouts source is required to identify the true winner of knockout matches decided on penalties.

---

## Source 2: Penalty Shootouts

**URL:** `https://raw.githubusercontent.com/martj42/international_results/master/shootouts.csv`

**HTTP Status:** 200 ✓

**Format:** Comma-separated values (CSV)

**Column Headers:**

```
date,home_team,away_team,winner,first_shooter
```

**License:** CC0 1.0 Universal (public domain)

**Repository:** martj42/international_results (public dataset)

---

## Notes for Task 9 and Beyond

- The eloratings source provides the base match records for all 2022 World Cup matches.
- The shootouts source enables penalty layer calibration for knockout matches that required shootouts.
- Both sources are publicly accessible and have stable HTTP endpoints as of 2026-06-30.
