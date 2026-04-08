# mentionsApp — Architecture & Pipeline

> **One app. Multiple subtypes. Same 8-step pipeline.**
>
> `mentionsApp` prices the probability that a specific word or phrase is spoken by an eligible speaker during a live event. The resolution source is always a transcript. The pipeline is identical regardless of event type — only the context loader changes.

---

## Subtype Registry

```
mentionsApp
  ├── subtype: "earningsMentionsApp"     ← CEO/CFO during earnings calls (Delta, Tesla, United…)
  ├── subtype: "politicalMentionsApp"    ← Political figures at press briefings (Hegseth, Trump…)
  ├── subtype: "fedMentionsApp"          ← Powell / FOMC press conferences
  ├── subtype: "sportsPresserApp"        ← Coach/player post-game pressers
  ├── subtype: "sportsAnnouncerApp"      ← Live broadcast commentary
  └── subtype: "mediaInterviewApp"       ← TV hits, podcasts
```

The `subtype` flag controls only two things:
1. **Who is the eligible speaker** — CEO/CFO vs. a specific official vs. broadcast announcer
2. **Where comparable transcripts are fetched** — SEC 8-K vs. DoD briefing archive vs. broadcast archive

Everything else — normalization, probability engine, resolution auditor, output packet — is shared.

---

## Why These Are the Same Market

| | Delta Earnings Call | Pete Hegseth Iran Briefing |
|---|---|---|
| **Market type** | Word said during event | Word said during event |
| **Resolution source** | Official earnings transcript | Press briefing transcript/video |
| **Eligible speaker** | CEO / CFO | Pete Hegseth only |
| **Pipeline** | `mentionsApp` | `mentionsApp` |
| **Core math** | P(word appears ≥ 1 time) | P(word appears ≥ 1 time) |
| **Key inputs** | Prior earnings transcripts | Prior Hegseth briefings / statements |
| **Strike normalization** | "oil" vs "crude" vs "jet fuel" | "Terrorist" vs "Terrorism" vs "Terror" |
| **Edge source** | Rule friction + alias ambiguity | Narrative heat + speaker pattern |

The only thing that changes is the context loader config block:

```python
# Delta earnings call
context = {
    "subtype": "earningsMentionsApp",
    "speaker": "Delta CEO/CFO",
    "transcript_source": "SEC 8-K / Seeking Alpha",
    "comparables": "prior_delta_earnings_calls"
}

# Hegseth Iran press briefing
context = {
    "subtype": "politicalMentionsApp",
    "speaker": "Pete Hegseth",
    "transcript_source": "DoD press briefing video/transcript",
    "comparables": "prior_hegseth_pressers + hegseth_interviews"
}
```

---

## Live Market Reference

### Delta Earnings Call — $112,042 vol

| Strike | Market YES | Payout | Notes |
|---|---|---|---|
| Technology | 87% | 1.14x | Near-certain |
| Weather | 84% | 1.16x | Airline ops — near-certain |
| Acquisition | 81% | 1.19x | Standard M&A boilerplate — high base rate |
| Oil | 56% | 1.73x | **Edge candidate** — Delta says "jet fuel" not "oil" |
| YouTube | 50% | 1.93x | **Edge candidate** — unusual for airline earnings; narrative-driven |
| Tariff | 47% | 2.05x | **Edge candidate** — tariff environment live but exact word uncertain |
| Iran | 39% | 2.46x | Low base rate for airline earnings |
| Nonstop / Non-Stop | 27% | 3.52x | Route marketing language, not earnings language |
| Holiday | 23% | 4.13x | Seasonal language; unlikely in Q1 call |

### Pete Hegseth Iran Press Briefing — $6,339 vol

| Strike | Market YES | Payout | Notes |
|---|---|---|---|
| Obliterate / Obliterated / Obliter… | 72% | 1.46x | Hegseth rhetorical pattern — elevated |
| Terrorist / Terrorism | 70% | 1.52x | High base rate for any Hegseth national security briefing |
| Oil | 70% | 1.44x | Iran context makes this live |
| Russia | 68% | 1.57x | Iran briefing topic — moderate base rate |
| CIA | 47% | 2.05x | **Edge candidate** — Hegseth historically avoids intelligence agency mentions |
| Hamas / Hezbollah | 40% | 2.52x | Iran-adjacent but not guaranteed in a nuclear-focus briefing |
| Fake News | 40% | 2.52x | **Edge candidate** — rhetorical, not on-topic for Iran |

---

## How Research Is Performed

Research for any mentions market flows through three layers, executed in order:

### Layer 1 — Comparable Transcript Library

Pull every prior instance of the eligible speaker in the same event context. This is the base data asset — without it there is no signal. Minimum viable samples:

- Earnings calls: last 6 quarters for the same company
- Political briefings: last 20 briefings on related topics by the same speaker
- Fed pressers: last 8 FOMC press conferences

Sources in priority order (earnings subtype):
1. SEC 8-K filings (official prepared remarks)
2. Seeking Alpha / Motley Fool earnings transcripts
3. Company IR page (investor relations)
4. Refinitiv / Bloomberg if accessible

Sources in priority order (political subtype):
1. DoD / White House press briefing archives
2. C-SPAN transcripts
3. News transcript databases (Nexis, Factiva)

### Layer 2 — Hit Rate Analysis

For each strike, compute against all prior transcripts:
- **Hit rate** — how many prior calls contained the word at least once (e.g., 3/8 calls)
- **Frequency** — average occurrences per call when the word did appear
- **Trend** — whether usage is increasing or decreasing over recent quarters
- **Location** — prepared remarks vs. Q&A

Prepared remarks are significantly more predictable. If a word has never appeared in prepared remarks across 6 prior calls, it requires an active live narrative reason to appear now. Q&A is noisier because analyst questions can introduce vocabulary the speaker wouldn't otherwise use.

### Layer 3 — Alias Expansion + Rule Friction

The most underrated research step. Contract resolution rules determine what literally counts as a match. Kalshi often bundles variants together (e.g., "Terrorist / Terrorism", "Nonstop / Non-Stop", "Obliterate / Obliterated / Obliter…") — this is a direct signal that Kalshi treats them as equivalent under resolution rules. When variants are *not* bundled, assume strict literal matching.

The alias expansion boundary is where edge lives:

```python
# Delta earnings — alias expansion
strikes = {
    "Oil":      ["oil"],   # judgment call: does "jet fuel" or "crude" count?
    "YouTube":  ["youtube", "you tube"],
    "Tariff":   ["tariff", "tariffs"],
}

# Hegseth briefing — alias expansion
strikes = {
    "CIA":        ["cia", "central intelligence agency"],
    "Fake News":  ["fake news"],
    "Oil":        ["oil", "crude"],   # Iran context: "crude" is plausible
}
```

If "Oil" resolves only on the literal word "oil" but Delta's last 8 transcripts show 0 occurrences of "oil" and 47 occurrences of "jet fuel" — the NO edge is enormous regardless of market price. This is the research question that matters most on that strike.

---

## The 8-Step Pipeline

### Step 1 — Market Discovery

The companion router receives the Kalshi event URL. `classifyMentionMarket` reads the event title, identifies the eligible speaker and event type, and routes to `mentionsApp`. It ingests all strikes, their current YES prices, volume, and the scheduled event datetime.

### Step 2 — Resolution Parsing

`parseResolutionRules` identifies:

- **Who is the eligible speaker?** CEO/CFO only, or does the full call including analyst Q&A count?
- **What is the accepted resolution source?** Official transcript vs. live audio vs. video replay.
- **What counts as a match?** Bundled variants (e.g., "Shut Down / Shutdown") signal that Kalshi treats them as equivalent. Unbundled strikes should be treated as strict literal matches.

### Step 3 — Transcript Collection

`fetchTranscripts` pulls prior transcripts for the eligible speaker. (See Layer 1 above for source priority.)

### Step 4 — Strike Normalization

`normalizeStrikes` expands each strike into all acceptable match variants given the resolution rules identified in Step 2. Flags any expansion where the boundary is ambiguous.

### Step 5 — Mention Extraction

`extractMentions` runs the normalized strike list against all prior transcripts. (See Layer 2 above for metrics computed.)

### Step 6 — Probability Engine

`scoreMentions` estimates P(YES) for each strike:

```
base_rate         = hits / total_calls_in_sample
recency_weight    = heavier weight on last 2 quarters / last 4 briefings
narrative_adjust  = ± delta based on current news environment
rule_friction     = discount when alias expansion is ambiguous or resolution source is unconfirmed
```

Narrative context for the live slates:
- **Delta / YouTube (50%)** — driven by Kalshi/YouTube partnership market narrative, not by Delta's transcript history. Check whether prior Delta calls ever mentioned YouTube before applying positive adjustment.
- **Delta / Oil (56%)** — tariff + fuel cost environment makes oil language live, but Delta's prepared remarks historically use "fuel" or "jet fuel". Exact-word friction is the key variable.
- **Hegseth / CIA (47%)** — Hegseth has publicly antagonized intelligence agencies but rarely names them in official DoD briefings. Base rate from prior pressers likely below 47%.
- **Hegseth / Fake News (40%)** — off-topic for an Iran nuclear briefing. Narrative heat from his media persona has inflated this above its topic-adjusted base rate.

### Step 7 — Resolution Auditor

`auditResolution` runs a final gate before any strike is flagged as tradable:

- Confirms resolution source is identified
- Confirms eligible speaker is identified
- Flags any strikes where alias expansion is ambiguous
- Tags markets where rule friction is high enough to materially discount the edge
- Marks strikes with `resolutionRisk: high` when contract language is unclear

### Step 8 — Output Packet

`emitTradePacket` produces one packet per strike:

```json
{
    "pipeline": "mentionsApp",
    "subtype": "earningsMentionsApp",
    "event": "Delta Q1 2026 Earnings Call",
    "strike": "Oil",
    "fairYes": 0.42,
    "fairNo": 0.58,
    "marketYes": 0.56,
    "marketNo": 0.44,
    "edgeYes": -0.14,
    "edgeNo": +0.14,
    "confidence": 0.71,
    "primarySignal": "historical-persistence",
    "supportingEvidence": [
        "prior_call_hit_rate: 3/8",
        "exact_word_rule_friction: high",
        "delta_prepared_remarks_use_jet_fuel_not_oil"
    ],
    "resolutionNotes": "Resolves on official transcript. 'Jet fuel' does NOT count. Only literal 'oil'.",
    "resolutionRisk": "high",
    "noBetFlag": false
}
```

---

## Where the Edge Lives

The highest-value output from `mentionsApp` on any slate is a **ranked edge table** — the gap between fair value and market price, sorted by absolute edge, flagged by direction.

General patterns:

| Price Range | Pattern | Action |
|---|---|---|
| 85–96% YES | Near-certainty plays | Only trade if strong historical rate AND confirmed resolution rules |
| 50–70% YES | Mid-range contested | Transcript analysis has the most impact — base rate vs. narrative heat |
| 23–47% YES | Low-probability strikes | Edge comes from narrative overprice vs. true topic-adjusted base rate |

The single hardest problem in any mentions market — regardless of whether the eligible speaker is a CEO or a Secretary of Defense — is getting enough comparable transcripts to establish a reliable base rate. That is the data problem. The pipeline is the same.

---

## Context Loader Config Reference

```python
CONTEXT_CONFIGS = {
    "earningsMentionsApp": {
        "transcript_sources": ["sec_8k", "seeking_alpha", "motley_fool", "company_ir"],
        "speaker_role": "CEO/CFO",
        "comparable_window": "last_6_quarters",
        "prepared_vs_qa": True,
    },
    "politicalMentionsApp": {
        "transcript_sources": ["dod_briefings", "whitehouse_transcripts", "c_span", "nexis"],
        "speaker_role": "named_individual",
        "comparable_window": "last_20_briefings",
        "prepared_vs_qa": True,
    },
    "fedMentionsApp": {
        "transcript_sources": ["fed_transcripts", "fomc_minutes", "fed_website"],
        "speaker_role": "Fed Chair",
        "comparable_window": "last_8_pressers",
        "prepared_vs_qa": True,
    },
    "sportsPresserApp": {
        "transcript_sources": ["team_website", "beat_reporter_transcripts"],
        "speaker_role": "coach_or_player",
        "comparable_window": "last_10_pressers",
        "prepared_vs_qa": False,
    },
}
```
