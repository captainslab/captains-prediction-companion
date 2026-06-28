# ⚾ CPC GAME PACKET — NYY @ BOS
## Sunday, June 28, 2026 — Pre-Game Research Enrichment
**Game Key:** 26JUN281920NYYBOS
**First Pitch:** 7:20 PM ET / 6:20 PM CT | Fenway Park, Boston
**Series:** Final game of 4-game series (BOS leads series 2-1)
**Broadcast:** NBC / Peacock (national)
**Perplexity Research:** sonar-pro | Generated 9:43 AM CDT
**Original Call:** NO CLEAR PICK — lineup_pending
**Research Pass Status:** Weather, starter form, splits, park context — ALL SOURCED

---

## WEATHER — Fenway Park (Fills `weather_adapter unknown` block)
76°F | Partly Cloudy | 5.8 mph SE | 11% precip | Humidity 68.8%
SE wind at Fenway = blowing in from right-center at ~15 mph (PropFinder)
weather_risk block: CLEARED (11% < 25% threshold)

---

## STARTERS

### Sonny Gray (BOS, RHP, Home)
Record: 9-1 | ERA: 2.95 | WHIP: 1.19 | IP: 76.1 | K: 66 | K/9: 7.8
Home ERA: 2.61 (7 GS, 38 IP, 28 K)
Away ERA: 3.29
vs NYY 2026 (Jun 5 @NYY): 6.1 IP, 8H, 3 ER, 2 HR, 2 BB, 3 K
Last 7 days: 7.0 IP, 1 ER, 11 K (vs COL)
vs LHH AVG: .254 | vs RHH AVG: .233

Last 5 starts game log:
| Date | Opp | IP | H | ER | K | BB |
|------|-----|----|---|-----|---|----|
| Jun 23 | COL | 7.0 | 6 | 1 | 11 | 3 |
| Jun 18 | TOR | 7.0 | 6 | 3 | 4 | 1 |
| Jun 12 | TEX | 6.0 | 5 | 1 | 7 | 0 |
| Jun 5 | @NYY | 6.1 | 8 | 3 | 3 | 2 |
| May 30 | @CLE | 6.0 | 4 | 1 | 7 | 3 |

### Carlos Rodón (NYY, LHP, Away)
Record: 4-2 | ERA: 3.70 | WHIP: 1.28 | IP: 41.1 | K: 46 | K/9: 10.0 | BB/9: 4.8
Last 3 starts ERA: 3.63 (StatMuse)
Risk: elevated BB rate (4.8 BB/9) + Fenway short RF dimensions vs LHP

---

## INJURY LOG — BOS (Full)
- Patrick Sandoval: 60-day IL
- Jovani Morán: 15-day IL (2nd rehab today, activation possible Mon/Tue)
- Nick Sogard: 10-day IL (return ~Jul 5)
- Romy González: 60-day IL (shoulder) — ACTIVATION WATCH — "as soon as June 28" per MLB.com
- Marcelo Mayer: 10-day IL (left ulna, Jun 26) — post All-Star
- Isiah Kiner-Falefa: 10-day IL (left forearm, Jun 19) — post All-Star
- Trevor Story: 60-day IL (sports hernia, May 16)
- Triston Casas: 60-day IL (abdominal strain, Mar 22)

---

## MODEL RECONCILIATION
Flagged mismatch (composite leads BOS, projected runs favor NYY 3.5 vs BOS 3.3):
→ NOT an error. NYY OPS .756 vs BOS .700 = NYY scores more runs on average.
  BOS composite advantage = home field + Gray at home + bullpen parity (3.25 vs 3.23).
  Both can be simultaneously true.

YRFI 56% lean supported by:
- Rodón BB/9 of 4.8 = traffic risk in 1st inning
- BOS top of order vs LHP (RHH-heavy lineup)
- Gray allows 1st-inning runs in ~50% of recent starts

Total 6.8 projection: well-calibrated vs Gray home form + Rodón volatility at Fenway.

---

## BLOCK STATUS
- lineup_pending: STILL ACTIVE (clears ~5:30-6:00 PM ET)
- weather_adapter unknown: CLEARED
- injury_activation_pending (González): STILL ACTIVE (pre-game decision)
- K model BLOCKED: STILL ACTIVE (needs lineup)
- starter_confirmation: CONFIRMED (Rodón vs Gray)

CPC call: NO CLEAR PICK — awaiting lineups.

---

## REFERENCE SCHEMA — Enrichment Pattern
See full packet in conversation for complete schema documentation.
Key patterns demonstrated:
1. Weather block resolves direction vs park orientation (not just mph)
2. Starter block includes last-5-start game log + home/away split + vs-opponent
3. Model reconciliation explains MISMATCH flags explicitly
4. Injury block = full team IL, not just flagged player
5. Block resolution table closes every packet (flag → original → post-research → still active)

Sources: PlainTextSports, CBS Sports game log, Fox Sports, ESPN splits, StatMuse,
RotoWire, Covers.com weather, WeatherForYou.com, PropFinder.app, MLB.com injury pages
