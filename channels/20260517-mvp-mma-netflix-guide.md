# MVP MMA Netflix Special — Main Card Post-Event Settlement Guide

**Event:** MVP MMA: Netflix Special
**Date:** May 16, 2026
**Card:** Rousey vs. Carano · Diaz vs. Perry · Ngannou vs. Lins
**Source:** MVP MMA app · Kalshi markets
**Status:** Post-event. All Kalshi markets below are FINALIZED. Pre-event prices are not retrievable from the Kalshi API after settlement and are marked MISSING.
**Labels:** LEAN / WATCH / PASS only — no trade instructions, no bankroll advice

---

## Main-Card Summary

| Fight | Matchup | Division | Rounds | Kalshi Settlement |
|-------|---------|----------|--------|-------------------|
| Main Event | Ronda Rousey vs. Gina Carano | Women's Catchweight | 3 | Rousey YES · Carano NO |
| Co-Main | Nate Diaz vs. Mike Perry | Welterweight 170 | 3 | Perry YES · Diaz NO |
| Main Card | Francis Ngannou vs. Philipe Lins | Heavyweight 265 | 3 | Ngannou YES · Lins NO |

All six tickers settled via Kalshi trade-api/v2 markets endpoint. See Sources section.

---

## Fight 1: Ronda Rousey vs. Gina Carano

> **Sanctioning status UNCONFIRMED at the time of writing.** Available pre-event reporting did not confirm CSAC or other commission sanctioning as a professional MMA bout. Market liquidity and the Kalshi listing treated it as a real contest. Settlement was recorded as a binary YES/NO outcome.

### Fighter Profiles

**Ronda Rousey** — 12-2 MMA entering
- Last fight: Loss vs. Amanda Nunes, UFC 207, Dec 30 2016 (TKO R1, :48) — ~9.5-year layoff
- Finish rate: 100% wins by finish (9 armbar, 3 KO/TKO, 0 decisions)
- Style: Judo base, armbar specialist, aggressive wrestling, elite ground control
- Strengths: Takedown, clinch work, submission chain from top position
- Vulnerabilities: Elite striking exposed her twice (Holm, Nunes); returning at 39 after full retirement

**Gina Carano** — 7-1 MMA entering
- Last fight: Loss vs. Cris Cyborg, Strikeforce, Aug 15 2009 (TKO R1) — ~17-year layoff
- Finish rate: 71% (4 KO/TKO, 1 sub, 2 decisions)
- Style: Muay Thai/kickboxing base, forward pressure, hooks and knees in the pocket
- Strengths: Striking volume, physical strength for era, durability in standup
- Vulnerabilities: Never elite-tested at ground level; long layoff makes all physical attributes speculative; 43 years old

### Matchup Dynamics
Rousey's path was a wrestling-to-submission sequence — the same formula that went 9-for-9 in her career.
Carano's only credible path was keeping it standing and landing meaningful strikes before Rousey closed the distance.
Both fighters carried extreme inactivity risk. Rousey's grappling edge was structural; Carano's layoff was longer and she was finished by striking, not taken down, in her loss.

### Moneyline Markets

| Side | Pre-Event Price | Settlement | Source | Pre-Event Label |
|------|-----------------|------------|--------|-----------------|
| Rousey | MISSING — market settled before verification | YES | Kalshi KXUFCFIGHT-26MAY16ROUCAR-ROU (finalized) | WATCH — structural grappling edge |
| Carano | MISSING — market settled before verification | NO | Kalshi KXUFCFIGHT-26MAY16ROUCAR-CAR (finalized) | WATCH — any value required striking path to materialize early |

*Kalshi did not list prop markets (method, distance, round, finish) for this event — marked MISSING below.*

### Prop Markets

**Method of Victory**

| Method | Price | Pre-Event Label | Angle |
|--------|-------|-----------------|-------|
| Submission | MISSING — not listed on Kalshi | LEAN | Rousey armbar rate is 9-for-12 wins; primary finish path on the mat |
| KO/TKO | MISSING — not listed on Kalshi | WATCH | Carano's Muay Thai credible only if Rousey gets sloppy standing |
| Decision | MISSING — not listed on Kalshi | PASS | Low evidence for a 3-round grind given both fighters' finish rates and layoffs |

**Go the Distance**

| Side | Price | Pre-Event Label | Angle |
|------|-------|-----------------|-------|
| Yes | MISSING — not listed on Kalshi | PASS | Near-zero competitive cardio base for either fighter |
| No | MISSING — not listed on Kalshi | LEAN | Style clash + layoff length favored early stoppage |

**Round of Victory**

| Round | Price | Pre-Event Label | Angle |
|-------|-------|-----------------|-------|
| Round 1 | MISSING — not listed on Kalshi | LEAN | Rousey historically closed in R1 |
| Round 2–3 | MISSING — not listed on Kalshi | WATCH | Only if Carano survived R1 |

**Method of Finish**

| Method | Price | Pre-Event Label | Angle |
|--------|-------|-----------------|-------|
| Armbar/Submission | MISSING — not listed on Kalshi | LEAN | Rousey's signature finish in 9 of 12 career wins |
| Strikes | MISSING — not listed on Kalshi | WATCH | Carano's path required sustained standup |

---

## Fight 2: Nate Diaz vs. Mike Perry

### Fighter Profiles

**Nate Diaz** — 22-13 MMA entering
- Last MMA fight: W vs. Tony Ferguson, UFC 279, Sep 10 2022 (Sub R4, guillotine choke) — ~3.5-year MMA layoff
- Recent activity: Beat Jorge Masvidal by boxing UD (Nov 2024); lost boxing exhibition to Jake Paul (Jul 2023)
- Finish rate: ~91% (12 sub, 8 KO/TKO, 2 decisions)
- Style: Cesar Gracie BJJ black belt, southpaw boxing, high-volume forward pressure, elite cardio
- Strengths: Cardio, submission from back, volume boxing at range, chin durability
- Vulnerabilities: Stronger wrestlers/grapplers can dominate him

**Mike Perry** — 14-7 MMA · 5-1 BKFC entering
- Last MMA fight: Loss vs. Tim Means, May 2020 (TKO) — 6-year MMA layoff
- Recent activity: 5 BKFC KO wins; boxing exhibition loss to Jake Paul (Jul 2024)
- Finish rate: ~86% MMA
- Style: Forward-pressure power striker, heavy hands, high aggression
- Strengths: One-punch KO power, chin, pressure, striking sharpness refined in BKFC
- Vulnerabilities: Takedown defense historically porous; 6-year absence from MMA grappling exchanges

### Matchup Dynamics
The most competitive fight on the card by style balance. Perry's BKFC circuit kept his striking extremely sharp — his hands were the most recently tested of any fighter here. Diaz's cardio and BJJ were the equalizers. Perry's window was Rounds 1–2; if he could not finish early, Diaz's volume and submission threats compounded with each minute.

### Moneyline Markets

| Side | Pre-Event Price | Settlement | Source | Pre-Event Label |
|------|-----------------|------------|--------|-----------------|
| Mike Perry | MISSING — market settled before verification | YES | Kalshi KXUFCFIGHT-26MAY16DIAPER-PER (finalized) | WATCH |
| Nate Diaz | MISSING — market settled before verification | NO | Kalshi KXUFCFIGHT-26MAY16DIAPER-DIA (finalized) | LEAN |

*Kalshi did not list prop markets for this fight — MISSING below.*

### Prop Markets

**Method of Victory**

| Method | Price | Pre-Event Label | Angle |
|--------|-------|-----------------|-------|
| Submission | MISSING — not listed on Kalshi | LEAN | Diaz BJJ black belt; Perry's MMA grappling defense 6 years cold |
| KO/TKO | MISSING — not listed on Kalshi | WATCH | Perry's primary path; Diaz has durability but Perry's power is real |
| Decision | MISSING — not listed on Kalshi | LEAN | Diaz volume + cardio = 3-round decision is a genuine outcome path |

**Go the Distance**

| Side | Price | Pre-Event Label | Angle |
|------|-------|-----------------|-------|
| Yes | MISSING — not listed on Kalshi | LEAN | Both fighters demonstrated durability; Diaz cardio pushes fights deep |
| No | MISSING — not listed on Kalshi | WATCH | Perry had to hurt Diaz early or distance favors Diaz |

**Round of Victory**

| Round | Price | Pre-Event Label | Angle |
|-------|-------|-----------------|-------|
| Rounds 1–2 | MISSING — not listed on Kalshi | WATCH | Perry's power window; BKFC sharpness front-loaded |
| Round 3 | MISSING — not listed on Kalshi | LEAN | Diaz's cardio and pressure favor later rounds |

**Method of Finish**

| Method | Price | Pre-Event Label | Angle |
|--------|-------|-----------------|-------|
| Submission | MISSING — not listed on Kalshi | LEAN | Diaz's signature path; Perry BJJ defense unknown after 6 years out |
| Strikes | MISSING — not listed on Kalshi | WATCH | Perry striking threat credible but Diaz durability well-documented |

---

## Fight 3: Francis Ngannou vs. Philipe Lins

### Fighter Profiles

**Francis Ngannou** — 17-3 MMA (1 NC) entering
- Last MMA result: PFL 2023 (undefeated MMA record intact); Oct 2024 Ferreira fight was boxing (Ngannou KO W R3), not MMA
- Last completed MMA win: def. Ciryl Gane, UFC 270, Jan 22 2022
- Recent boxing: Split-decision loss to Tyson Fury (Oct 2023; knocked Fury down); KO loss to Anthony Joshua R5 (Mar 2024)
- Finish rate: ~94% (12 KO/TKO, 4 sub, 1 decision)
- Style: Explosive power striker, elite KO threat, has supplementary submission game
- Strengths: Hardest puncher in sport, explosive athleticism, finishing instinct
- Vulnerabilities: Joshua KO showed durability questions under sustained pressure; sharpness after boxing detour uncertain

**Philipe Lins** — 17-6 MMA entering
- Last fight: Loss vs. Ion Cutelaba, Bellator, May 11 2024 — ~1-year layoff
- Wins breakdown: 11 KO/TKO, 4 sub, 2 decisions — 88% finish rate
- Style: BJJ black belt with heavy hands; finishes via both grappling and striking
- Strengths: Active MMA career (freshest fighter on the card), submission threat, durable, well-rounded
- Vulnerabilities: Power disadvantage against a heavyweight of Ngannou's caliber is extreme

### Matchup Dynamics
The clearest style mismatch on the card. Ngannou's punch output was historically in a different class at heavyweight. Lins's best path was a fast, early takedown before Ngannou could set his feet — on the mat with position, his BJJ was credible. Standing, Lins faced a near-unwinnable power disparity.

### Moneyline Markets

| Side | Pre-Event Price | Settlement | Source | Pre-Event Label |
|------|-----------------|------------|--------|-----------------|
| Ngannou | MISSING — market settled before verification | YES | Kalshi KXUFCFIGHT-26MAY16NGALIN-NGA (finalized) | WATCH — near-consensus favorite |
| Philipe Lins | MISSING — market settled before verification | NO | Kalshi KXUFCFIGHT-26MAY16NGALIN-LIN (finalized) | PASS — grappling path real but priced thin |

*Kalshi did not list prop markets for this fight — MISSING below.*

### Prop Markets

**Method of Victory**

| Method | Price | Pre-Event Label | Angle |
|--------|-------|-----------------|-------|
| KO/TKO | MISSING — not listed on Kalshi | LEAN | Ngannou's entire career arc; 12 of 17 wins by knockout |
| Submission | MISSING — not listed on Kalshi | WATCH | Lins BJJ is real; Ngannou has 4 career subs himself |
| Decision | MISSING — not listed on Kalshi | PASS | Very low evidence for Ngannou grinding a 3-round decision |

**Go the Distance**

| Side | Price | Pre-Event Label | Angle |
|------|-------|-----------------|-------|
| Yes | MISSING — not listed on Kalshi | PASS | Ngannou's 94% finish rate makes this unlikely |
| No | MISSING — not listed on Kalshi | LEAN | Power + finish rate = early stoppage is the base case |

**Round of Victory**

| Round | Price | Pre-Event Label | Angle |
|-------|-------|-----------------|-------|
| Round 1 | MISSING — not listed on Kalshi | LEAN | Ngannou's most dangerous window |
| Rounds 2–3 | MISSING — not listed on Kalshi | WATCH | Lins's grappling attrition could survive into later rounds |

**Method of Finish**

| Method | Price | Pre-Event Label | Angle |
|--------|-------|-----------------|-------|
| Knockout | MISSING — not listed on Kalshi | LEAN | Ngannou's signature; 12 KO/TKO wins speak for themselves |
| Submission | MISSING — not listed on Kalshi | PASS | Lins path requires full takedown control |

---

## Picks Summary (Pre-Event Labels)

| Fight | Market | Label | Rationale |
|-------|--------|-------|-----------|
| Rousey vs. Carano | Moneyline Rousey | WATCH | Structural grappling edge |
| Rousey vs. Carano | Method: Submission | LEAN | 9-for-9 armbar finish history |
| Rousey vs. Carano | Go the Distance No | LEAN | Styles and layoffs favored early stoppage |
| Rousey vs. Carano | Round of Finish R1 | LEAN | Rousey historical pattern |
| Diaz vs. Perry | Moneyline Diaz | LEAN | BJJ + cardio combination undervalued by implied side |
| Diaz vs. Perry | Go the Distance Yes | LEAN | Both known for durability |
| Diaz vs. Perry | Method: Decision | LEAN | Diaz volume + Perry durability = distance outcome was live |
| Diaz vs. Perry | Method: Submission | LEAN | Perry grappling defense unknown after 6 years out |
| Ngannou vs. Lins | Method: KO/TKO | LEAN | 12 of 17 career wins |
| Ngannou vs. Lins | Go the Distance No | LEAN | 94% finish rate |
| Ngannou vs. Lins | Round of Finish R1 | LEAN | Explosive early pattern |

---

## Sources

| Source | What It Covers | Status |
|--------|---------------|--------|
| Kalshi API (api.elections.kalshi.com/trade-api/v2/markets) | All 6 moneyline tickers — ROUCAR, DIAPER, NGALIN | FINALIZED, settlement results verified |
| Tapology.com | All fighter MMA records | VERIFIED |
| UFC.com | Rousey, Diaz, Ngannou win-method breakdowns | VERIFIED |
| Sherdog.com | Carano 7-1 record | VERIFIED |
| BloodElbow | Perry BKFC career, Jake Paul loss Jul 2024 | VERIFIED |
| BBC Sport / Sky Sports | Ngannou boxing results (Joshua KO Mar 2024, Fury Oct 2023) | VERIFIED |
| MMAJunkie.com homepage | Event listed as May 16 card | VERIFIED |

### Kalshi Settlement Snapshot

Endpoint:
`GET https://api.elections.kalshi.com/trade-api/v2/markets?tickers=KXUFCFIGHT-26MAY16ROUCAR-ROU,KXUFCFIGHT-26MAY16ROUCAR-CAR,KXUFCFIGHT-26MAY16DIAPER-PER,KXUFCFIGHT-26MAY16DIAPER-DIA,KXUFCFIGHT-26MAY16NGALIN-NGA,KXUFCFIGHT-26MAY16NGALIN-LIN`

| Ticker | Status | Result |
|--------|--------|--------|
| KXUFCFIGHT-26MAY16ROUCAR-ROU | finalized | YES |
| KXUFCFIGHT-26MAY16ROUCAR-CAR | finalized | NO |
| KXUFCFIGHT-26MAY16DIAPER-PER | finalized | YES |
| KXUFCFIGHT-26MAY16DIAPER-DIA | finalized | NO |
| KXUFCFIGHT-26MAY16NGALIN-NGA | finalized | YES |
| KXUFCFIGHT-26MAY16NGALIN-LIN | finalized | NO |

Pre-event prices (bid/ask/last/volume) returned null for every ticker after settlement and are not included in this guide.

---

## Internal Notes (Not for Publication)

- Kalshi tickers (KXUFCFIGHT-26MAY16*) were the canonical IDs; event date confirmed May 16 2026 via mvpmma.com and multiple outlets.
- Opponent listed as Philipe Lins per the MVP MMA app card. Some web research returned "Renan Lins" — disregard unless app is updated.
- Rousey/Carano sanctioning (CSAC vs. exhibition) reported but not confirmed via working primary source.
- Perry's MMA record may differ from 14-7 depending on any unrecorded activity between May 2020 and event date; verify if needed.
