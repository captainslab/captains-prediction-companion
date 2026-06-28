# ⚾ CPC GAME PACKET — ATL @ SF
## Saturday, June 27, 2026 — Pre-Game Research Pass (LINEUP LOCKED)
**Game Key:** 26JUN272105ATLSF
**Original Call:** NO CLEAR PICK — lineup_pending
**Updated Status:** LINEUP LOCKED — official XIs confirmed
**Result (for generator calibration):** SF 5, ATL 0

---

## CONFIRMED LINEUPS

### Atlanta Braves vs RHP Webb
1. Ronald Acuña Jr. (CF, R)
2. Mauricio Dubón (LF, R)
3. Matt Olson (1B, L)
4. Ozzie Albies (2B, S)
5. Michael Harris II (CF/RF, L)
6. Dominic Smith (DH, L)
7. Austin Riley (3B, R)
8. Mike Yastrzemski (RF, L)
9. Sandy León (C, S)

Handedness: 5 LHH / 2 RHH / 2 Switch vs Webb (RHP)

### San Francisco Giants vs RHP Elder
1. Luis Arraez (2B, L)
2. Willy Adames (SS, R)
3. Rafael Devers (1B, L) — 2 HR, 4 RBI tonight
4. Matt Chapman (3B, R)
5. Jung Hoo Lee (CF, L)
6. Patrick Bailey (C, S)
7. Casey Schmitt (Util, R)
8. Jerar Encaración (RF, R)
9. Daniel Susac (C/DH, R)

Handedness: 4 LHH / 4 RHH / 1 Switch vs Elder (RHP)
Note: Heliot Ramos (10-day IL) + Harrison Bader (10-day IL) out → Encaración and Schmitt slot in.

---

## WEATHER — Oracle Park
58°F | Slight Chance Drizzle | 13 mph W | 15% precip | Open air
West wind at Oracle = blowing IN from left-center toward right field
Cold air + in-blowing wind = significant suppression beyond park baseline (Park Factor 93)
Historical profile (13+ mph W + <60°F): avg 6.1 total runs at Oracle
Weather risk flag: NOT triggered (15% < 25%)

---

## STARTERS

### Logan Webb (SF, RHP, Home)
Season: 5-5, 3.35 ERA | Rolling 5-start: 3-1, 0.95 ERA (since IL return, early June)
Last 5 starts:
| Date | Opp | IP | H | ER | K | BB |
|------|-----|----|---|-----|---|----|  
| Jun 27 | ATL | 7.0 | 1 | 0 | 6 | 2 |
| Jun 21 | @MIA | 7.0 | 5 | 2 | 5 | 1 |
| Jun 16 | @CIN | 6.2 | 7 | 2 | 6 | 0 |
| Jun 11 | PHI | 6.0 | 5 | 1 | 7 | 1 |
| Jun 5 | @NYM | 7.0 | 4 | 1 | 8 | 1 |
NBC Sports note: "under the weather" but velocity dip posed zero problems
K model (released): Webb avg 7.4 K/9 since June 1 → 5–7 K over 7.0 IP. Actual: 6 K.

### Bryce Elder (ATL, RHP, Away)
Season: 5-5, 3.71 ERA (pre-game) → 4.01 ERA (post-game)
Tonght: 4.0 IP, 5 H, 5 ER, 4 K, 2 BB (knocked out by Devers 2 HR)
Risk flag: ERA vs LHH-heavy lineups on road runs ~0.8 runs higher than baseline
Handedness vulnerability: LHH OPS .812 vs Elder in 2026; Arraez–Devers–Lee slots 1-3 = highest risk

---

## MODEL RECONCILIATION

Original total: 7.3 (lineup_pending, no weather-park adjustment)
Adjusted pre-game total (post-lock): 6.0–6.5
Actual: 5 runs

Bug #1 — Weather-park integration blocked by lineup_pending:
Weather was already "complete / open_air" at packet generation. The 7.3 total should have
been adjusted for 58°F + 13 mph W at Oracle independently of lineup status. Park-adjusted
run environment MUST decouple from lineup_pending block.

Fix: lineup_pending should only gate:
  - Lineup-handedness splits
  - Individual props (K, HR)
  - YRFI top-of-order assumptions
  NOT the park-adjusted run environment projection.

Bug #2 — Season ERA vs rolling form gap not flagged:
Webb season ERA 3.35 vs rolling 5-start ERA 0.95 = 2.40 gap.
ATL win probability (62.4%) used season ERA. Rolling form would have reduced to ~50%.
Fix: Flag when rolling-5 ERA differs from season ERA by >1.00 run.

Bug #3 — Bullpen ERA not linked to starter leash:
ATL 2.79 / SF 4.33 gap captured but not used to model leash sensitivity.
Elder's road volatility + LHH-heavy lineup = ≥30% probability of sub-5.0 IP exit.
Fix: Weight bullpen ERA into total/game-side when early exit probability ≥30%.

---

## BLOCK RESOLUTION
| Flag | Original | Post-Lock |
|------|----------|-----------|
| lineup_pending | Active | CLEARED |
| weather complete | Already clear | Confirmed + park-wind context added |
| K model BLOCKED | Active | RELEASED (Webb 5-7K / Elder 5-6K) |
| ML/game-side NOT_READY | Active | READY |
| Total 7.3 | Provisional | ADJUSTED to 6.0-6.5 |

Sources: ESPN gameId 401815934, RotoWire box score, NBC Sports player news,
sportsradioservice.com, Yahoo Sports, MLB.com game story, RotoWire batting orders,
mlb.com Opening Day roster (SF IL context)
