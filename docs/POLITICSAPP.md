# POLITICSAPP.md — Politics Prediction Pipeline

## Overview

`politicsApp` prices outcome-based political markets. Resolution is event-based (election result, policy outcome, appointment confirmed), not text-based — separate from `mentionsApp` which handles word/phrase markets.

```
politicsApp
  ├── subtype: "electionsApp"          ← Federal/state elections, chamber control, candidate outcomes
  ├── subtype: "geopoliticsApp"        ← Geopolitical events, policy/legislation, international outcomes
  └── subtype: "cabinetApp"            ← Cabinet/admin appointments, confirmations
```

Routing rule: if a market resolves on whether a word was *spoken*, it is `mentionsApp`. If it resolves on whether an event *occurred*, it is `politicsApp`.

---

## Components

### politicsAppRouter
- Classifies incoming political markets by subtype
- Rejects mention markets (routes to `mentionsApp` instead)
- Normalizes market metadata for downstream engines

### politicsIntelIngest
- Worldmonitor-backed adapter
- Ingests headlines, entity tags, event clusters, region labels, urgency heat
- Upstream-only: provides intelligence inputs, never owns pricing or EV logic

### politicsNarrativeEngine
- Builds narrative summaries from `politicsIntelIngest` output
- Tracks dominant themes and emerging shifts
- Detects sudden narrative changes that warrant probability updates
- Flags convergence signals (multiple independent sources pointing same direction)

### electionsAlphaEngine
- Fair probability modeling for elections and chamber-control markets
- Inputs: polling averages (state/national, recency-weighted), historical base rates by race type, economic indicators, incumbency effects, presidential approval
- Applies Bayesian updating as new polls or events arrive

### geopoliticsAlphaEngine
- Fair probability inputs for geopolitical and policy events
- Inputs: worldmonitor event clusters, narrative heat, urgency heat, historical analogues
- Handles: legislation passage, international agreements, military/diplomatic events

### politicsReviewAnalyst
- Tracks performance by market subtype (elections vs geopolitics vs cabinet)
- Measures CLV and calibration over rolling windows
- Outputs parameter adjustment recommendations per subtype

---

## Workflow

1. Market ingested → `politicsAppRouter` classifies subtype and confirms it is *not* a mentions market
2. `politicsIntelIngest` pulls current headlines, entity tags, event clusters from worldmonitor
3. `politicsNarrativeEngine` builds narrative state: dominant themes, urgency, convergence signals
4. Route to appropriate alpha engine (`electionsAlphaEngine` or `geopoliticsAlphaEngine`)
5. Alpha engine constructs fair probability estimate
6. `decisionLogicAgent` runs EV, Kelly sizing, trade posture
7. Log decision; `politicsReviewAnalyst` captures for calibration

---

## Market Subtypes

### electionsApp
- Federal elections: House, Senate, Presidential
- State elections: governor, state legislature
- Special elections
- Chamber control markets
- Candidate outcome markets (dropout, nomination)

### geopoliticsApp
- Policy / legislation passage
- International agreements, treaties
- Geopolitical events (conflict escalation, ceasefires)
- Regulatory / agency actions

### cabinetApp
- Cabinet nominations and confirmations
- Admin appointments
- Key agency leadership

---

## Market Subtype Log Keys

```
elections_federal, elections_state, elections_chamber_control
elections_candidate_outcome
geopolitics_policy, geopolitics_legislation
geopolitics_international, geopolitics_conflict
cabinet_nomination, cabinet_confirmation
```

---

## Output Contract

```json
{
  "pipeline": "politicsApp",
  "marketSubtype": "elections_federal",
  "fairProbability": 0.62,
  "marketProbability": 0.55,
  "edge": 0.07,
  "expectedValue": 0.13,
  "confidence": 0.68,
  "primarySignal": "polling_convergence",
  "supportingSignals": ["historical_base_rate", "economic_indicator"],
  "noBetFlag": false,
  "notes": ""
}
```

---

## Worldmonitor Integration Rules

- Worldmonitor is upstream-only intelligence — it provides raw inputs, never owns pricing
- `politicsIntelIngest` consumes worldmonitor; no other module calls it directly
- Worldmonitor provides: headlines, entity tags, event clusters, region labels, urgency heat
- Use for: geopolitical event clustering, narrative heat detection, convergence signals
- Do not use worldmonitor output to directly set fair probabilities — pass through alpha engines

---

## Data Sources

| Category | Sources |
|----------|---------|
| Political intelligence | worldmonitor (koala73/worldmonitor) — geopolitical/news aggregation, event clustering, narrative heat |
| Polling | Polling averages (state/national, recency-weighted) |
| Historical base rates | Race-type historical win rates, incumbency data |
| Economic indicators | GDP, approval ratings, economic fundamentals |

---

## Routing Rule (vs mentionsApp)

| If the market resolves on... | Route to |
|------------------------------|----------|
| Word/phrase spoken by speaker | `mentionsApp` |
| Election winner / vote outcome | `politicsApp` (electionsApp) |
| Policy/legislation passed | `politicsApp` (geopoliticsApp) |
| Appointment confirmed | `politicsApp` (cabinetApp) |
| "Did X say Y at the briefing?" | `mentionsApp` |
| "Will X be confirmed?" | `politicsApp` (cabinetApp) |

---

## Cross-References

- Mentions pipeline (word/phrase markets): `docs/MENTIONSAPP.md`
- Sports pipeline: `docs/SPORTSAPP.md`
- Shared infrastructure modules: `ARCHITECTURE.md`
