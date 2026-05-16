# Execution Board - 2026-05-16

- Generated UTC: 2026-05-16T23:15:55.678Z
- Generated Chicago: 5/16/2026, 6:15:55 PM
- No trades placed.
- Automated trade execution: not called.

## Source Health

- MLB official: ok
- Kalshi API: ok
- Sportsbook reference: ok
- Lineup/injury/bullpen: ok
- Weather: ok
- Trade execution: not_called

## Summary Counts

- Total: 137
- CLEAR_PICK: 4
- PRE_LINEUP_PICK: 0
- LEAN: 0
- WATCH_FOR_LISTING: 0
- PASS: 28
- BLOCKED: 0
- NOT_TRADEABLE: 0
- CORRELATED_ALTERNATE: 14

## Clear Picks

| Market | Game | Contract | Strike | Ask | Fair | Edge | Max Entry | Start | Missing | Note |
|---|---|---|---:|---:|---:|---:|---:|---|---|---|
| KXMLBTOTAL-26MAY162140SFATH-8 | San Francisco Giants at Athletics | Over 7.5 runs scored | 7.5 | 0.69 | 0.7313 | 4.134pp | $83 | 2026-05-17T01:40:00Z | none | Discovery only — no trade placed. |
| KXMLBTOTAL-26MAY161915SDSEA-6 | San Diego Padres at Seattle Mariners | Over 5.5 runs scored | 5.5 | 0.67 | 0.6993 | 2.929pp | $59 | 2026-05-16T23:15:00Z | none | Discovery only — no trade placed. |
| KXMLBTOTAL-26MAY162138LADLAA-8 | Los Angeles Dodgers at Los Angeles Angels | Over 7.5 runs scored | 7.5 | 0.59 | 0.6144 | 2.44pp | $49 | 2026-05-17T01:38:00Z | none | Discovery only — no trade placed. |
| KXMLBTOTAL-26MAY161915NYYNYM-8 | New York Yankees at New York Mets | Over 7.5 runs scored | 7.5 | 0.59 | 0.6144 | 2.44pp | $49 | 2026-05-16T23:15:00Z | none | Discovery only — no trade placed. |

## Pre-Lineup Picks (Lineup Pending — Do Not Enter Yet)

- none

## Leans (Top 10 by Edge, one per group)

- none

## Watch For Price

| Market | Game | Lane | Side/Strike | Ask | Target | Edge | Reason | Recheck |
|---|---|---|---|---:|---:|---:|---|---|
| KXMLBTOTAL-26MAY161915SDSEA-2 | San Diego Padres at Seattle Mariners | game_total | over 1.5 | 0.98 | 0.96 | 1.27pp | stronger_edge, injury_activation_pending, bullpen_unknown | Enter at 0.96 or below |
| KXMLBTOTAL-26MAY162138LADLAA-3 | Los Angeles Dodgers at Los Angeles Angels | game_total | over 2.5 | 0.98 | 0.96 | 1.072pp | stronger_edge, injury_activation_pending, bullpen_unknown | Enter at 0.96 or below |
| KXMLBTOTAL-26MAY161915NYYNYM-3 | New York Yankees at New York Mets | game_total | over 2.5 | 0.98 | 0.96 | 1.072pp | stronger_edge, injury_activation_pending, bullpen_unknown | Enter at 0.96 or below |
| KXMLBTOTAL-26MAY161915SDSEA-3 | San Diego Padres at Seattle Mariners | game_total | over 2.5 | 0.96 | 0.941 | 1.036pp | stronger_edge, injury_activation_pending, bullpen_unknown | Enter at 0.941 or below |
| KXMLBTOTAL-26MAY162140SFATH-9 | San Francisco Giants at Athletics | game_total | over 8.5 | 0.6 | 0.588 | 0.818pp | stronger_edge, injury_activation_pending, bullpen_unknown | Enter at 0.588 or below |
| KXMLBGAME-26MAY161915NYYNYM-NYY | New York Yankees at New York Mets | moneyline | New York Y | 0.53 | 0.519 | 0.33pp | stronger_edge, injury_activation_pending, bullpen_unknown | Enter at 0.519 or below |

## Why mostly totals?

- Game totals account for 117 of 137 scored candidates.
- Moneyline is only 20 candidates, and most of those are PASS or WATCH_FOR_PRICE.
- Weather, lineup, and bullpen uncertainty push the board toward totals while the slate is still settling.
- Other lanes are effectively absent on this slate.

## Moneyline Edge Board

_Discovery view across all classifications. PASS and WATCH_FOR_PRICE rows are included for edge visibility, not action._

| market_ticker | game | Side | Status | Ask | Fair | Edge | Target | Why not |
|---|---|---|---|---:|---:|---:|---:|---|
| KXMLBGAME-26MAY161915NYYNYM-NYY | New York Yankees at New York Mets | New York Y | WATCH_FOR_PRICE | 0.53 | 0.5333 | 0.33pp | 0.519 | stronger_edge, injury_activation_pending, bullpen_unknown |

## Same-Game Combo Visibility

_Informational only. Same-game markets are shown together so shared exposure is visible before sizing._

| Game | Lane mix | Surfaced markets | Exposure note |
|---|---|---|---|
| San Francisco Giants at Athletics | moneyline, game_total | moneyline: KXMLBGAME-26MAY162140SFATH-ATH (PASS, -0.89pp); moneyline: KXMLBGAME-26MAY162140SFATH-SF (PASS, -1.11pp); game_total: KXMLBTOTAL-26MAY162140SFATH-8 (CLEAR_PICK, 4.134pp); game_total: KXMLBTOTAL-26MAY162140SFATH-9 (WATCH_FOR_PRICE, 0.818pp); game_total: KXMLBTOTAL-26MAY162140SFATH-10 (PASS, -1.183pp); game_total: KXMLBTOTAL-26MAY162140SFATH-11 (PASS, -6.533pp); game_total: KXMLBTOTAL-26MAY162140SFATH-12 (PASS, -8.199pp); game_total: KXMLBTOTAL-26MAY162140SFATH-13 (PASS, -9.643pp); game_total: KXMLBTOTAL-26MAY162140SFATH-14 (PASS, -9.814pp) | Informational only: review same-game markets together before sizing. |
| San Diego Padres at Seattle Mariners | moneyline, game_total | moneyline: KXMLBGAME-26MAY161915SDSEA-SEA (PASS, -0.17pp); moneyline: KXMLBGAME-26MAY161915SDSEA-SD (PASS, -1.83pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-6 (CLEAR_PICK, 2.929pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-2 (WATCH_FOR_PRICE, 1.27pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-3 (WATCH_FOR_PRICE, 1.036pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-7 (PASS, -3.971pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-8 (PASS, -5.871pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-9 (PASS, -10.909pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-10 (PASS, -11.05pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-12 (PASS, -11.665pp); game_total: KXMLBTOTAL-26MAY161915SDSEA-11 (PASS, -13.148pp) | Informational only: review same-game markets together before sizing. |
| Los Angeles Dodgers at Los Angeles Angels | moneyline, game_total | moneyline: KXMLBGAME-26MAY162138LADLAA-LAA (PASS, -0.11pp); moneyline: KXMLBGAME-26MAY162138LADLAA-LAD (PASS, -0.89pp); game_total: KXMLBTOTAL-26MAY162138LADLAA-8 (CLEAR_PICK, 2.44pp); game_total: KXMLBTOTAL-26MAY162138LADLAA-3 (WATCH_FOR_PRICE, 1.072pp); game_total: KXMLBTOTAL-26MAY162138LADLAA-9 (PASS, -3.311pp); game_total: KXMLBTOTAL-26MAY162138LADLAA-10 (PASS, -6.297pp); game_total: KXMLBTOTAL-26MAY162138LADLAA-11 (PASS, -9.336pp); game_total: KXMLBTOTAL-26MAY162138LADLAA-12 (PASS, -9.866pp); game_total: KXMLBTOTAL-26MAY162138LADLAA-13 (PASS, -10.908pp) | Informational only: review same-game markets together before sizing. |
| New York Yankees at New York Mets | moneyline, game_total | moneyline: KXMLBGAME-26MAY161915NYYNYM-NYY (WATCH_FOR_PRICE, 0.33pp); moneyline: KXMLBGAME-26MAY161915NYYNYM-NYM (PASS, -1.33pp); game_total: KXMLBTOTAL-26MAY161915NYYNYM-8 (CLEAR_PICK, 2.44pp); game_total: KXMLBTOTAL-26MAY161915NYYNYM-3 (WATCH_FOR_PRICE, 1.072pp); game_total: KXMLBTOTAL-26MAY161915NYYNYM-9 (PASS, -3.311pp); game_total: KXMLBTOTAL-26MAY161915NYYNYM-10 (PASS, -6.297pp); game_total: KXMLBTOTAL-26MAY161915NYYNYM-12 (PASS, -9.866pp); game_total: KXMLBTOTAL-26MAY161915NYYNYM-11 (PASS, -10.336pp); game_total: KXMLBTOTAL-26MAY161915NYYNYM-13 (PASS, -11.908pp) | Informational only: review same-game markets together before sizing. |

## Market-Lane Diagnostics

- Total candidates: 137
- Actionable same-game combo groups: 1
- Same-game visibility groups: 4
- Clear combo groups: 0
- Pre-lineup / lean combo groups: 0
- Watch combo groups: 1
- Pass combo groups: 0
- Moneyline candidates: 20
- Game total candidates: 117
- Unknown/other candidates: 0
- Moneyline-visible combo groups: 1

### Candidate Counts by Market Lane

| Market lane | Candidate count |
|---|---:|
| moneyline | 20 |
| run_line | 0 |
| game_total | 117 |
| yrfi_nrfi | 0 |
| home_run_hitter | 0 |
| pitcher_strikeouts | 0 |

### Actionable Counts by Market Lane

| Market lane | Actionable candidate count |
|---|---:|
| moneyline | 1 |
| run_line | 0 |
| game_total | 9 |
| yrfi_nrfi | 0 |
| home_run_hitter | 0 |
| pitcher_strikeouts | 0 |

| Lane | Total candidates | Visible candidates | Combo groups |
|---|---:|---:|---:|
| moneyline | 20 | 1 | 1 |
| run_line | 0 | 0 | 0 |
| game_total | 117 | 9 | 1 |
| yrfi_nrfi | 0 | 0 | 0 |
| home_run_hitter | 0 | 0 | 0 |
| pitcher_strikeouts | 0 | 0 | 0 |

## Correlated Alternates
- KXMLBTOTAL-26MAY162140SFATH-6 (strike 5.5, ask 0.83, edge 8.147pp)
- KXMLBTOTAL-26MAY162138LADLAA-6 (strike 5.5, ask 0.78, edge 7.04pp)
- KXMLBTOTAL-26MAY161915NYYNYM-6 (strike 5.5, ask 0.78, edge 7.04pp)
- KXMLBTOTAL-26MAY161915SDSEA-4 (strike 3.5, ask 0.86, edge 5.823pp)
- KXMLBTOTAL-26MAY162138LADLAA-5 (strike 4.5, ask 0.87, edge 5.564pp)
- KXMLBTOTAL-26MAY162140SFATH-7 (strike 6.5, ask 0.78, edge 5.505pp)
- KXMLBTOTAL-26MAY162138LADLAA-4 (strike 3.5, ask 0.92, edge 4.989pp)
- KXMLBTOTAL-26MAY162140SFATH-5 (strike 4.5, ask 0.91, edge 4.974pp)
- KXMLBTOTAL-26MAY161915NYYNYM-5 (strike 4.5, ask 0.88, edge 4.564pp)
- KXMLBTOTAL-26MAY162138LADLAA-7 (strike 6.5, ask 0.7, edge 4.382pp)
- KXMLBTOTAL-26MAY161915NYYNYM-7 (strike 6.5, ask 0.7, edge 4.382pp)
- KXMLBTOTAL-26MAY161915NYYNYM-4 (strike 3.5, ask 0.93, edge 3.989pp)
- KXMLBTOTAL-26MAY161915SDSEA-5 (strike 4.5, ask 0.79, edge 3.701pp)
- KXMLBTOTAL-26MAY162140SFATH-4 (strike 3.5, ask 0.96, edge 2.514pp)

## Safety
- No trades placed.
- No CLEAR_PICK emitted without all evidence gates passing.
- Sportsbook prices are reference-only no-vig fair values, not Kalshi prices.
- All picks require manual review before any action.
