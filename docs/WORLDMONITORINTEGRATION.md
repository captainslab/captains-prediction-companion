# WORLDMONITORINTEGRATION.md — worldmonitor Sources and Integration

> worldmonitor (koala73/worldmonitor) is the upstream intelligence layer for `politicsApp`.
> It provides headlines, entity tags, event clusters, and urgency heat.
> It does **not** own pricing, EV, or Kelly logic — it feeds `politicsIntelIngest` only.

---

## What It Is

Real-time global intelligence dashboard aggregating **65+ data sources** and **435+ curated news feeds** across 15 categories. Geographic coverage spans 190 countries with native-language feeds and regional specialization.

---

## Feed Variants

| Variant | Focus |
|---------|-------|
| `world` | Mainstream geopolitical + global news |
| `tech` | TechCrunch, ArXiv, VentureBeat — technology and AI |
| `finance` | CNBC, crypto, FX, market-moving news |
| `commodity` | Metals, energy, rare earths |
| `energy` | OPEC, LNG, pipeline infrastructure |
| `happy` | Positive/constructive news (noise filter) |

**For politicsApp:** use `world` variant as primary. `finance` for policy/economic markets.

---

## Intelligence Sources (40+)

Includes Defense One, Jane's, Chatham House, Bellingcat OSINT, and 35+ additional geopolitical and defense intelligence feeds.

These are the highest-signal inputs for `geopoliticsAlphaEngine` — conflict escalation, sanctions, diplomatic shifts.

---

## Output Schema

| Field | Description |
|-------|-------------|
| Headlines | Parsed RSS/Atom XML from all feeds |
| Entity tags | Named entities (people, organizations, regions) per article |
| Event clusters | Articles grouped by topic/event |
| Region labels | Hex cell tagging — 12 named conflict regions via bounding-box |
| Urgency heat | Alert keywords: `war`, `invasion`, `nuclear`, `sanctions` |
| Status | `fresh` / `stale` / `very_stale` / `no_data` / `error` / `disabled` per feed |

Data format: Protocol Buffers (92 protobuf definitions, 22 services).

---

## What `politicsIntelIngest` Takes From It

| worldmonitor output | Used by |
|--------------------|---------|
| Headlines + entity tags | `politicsNarrativeEngine` — dominant themes, sudden shifts |
| Event clusters | `geopoliticsAlphaEngine` — probability inputs for conflict/policy markets |
| Urgency heat (alert keywords) | `politicsNarrativeEngine` — escalation detection |
| Region labels | `geopoliticsAlphaEngine` — geographic context for conflict markets |
| Feed freshness / status | `@alphaagent` — data health reporting |

---

## Integration Rules

- **Upstream-only.** worldmonitor feeds `politicsIntelIngest`. No other module calls it directly.
- **Never prices.** worldmonitor output is raw intelligence — it enters the fair probability engine via `geopoliticsAlphaEngine`, never bypasses it.
- **Freshness matters.** Always check feed status before using output. `stale` or `very_stale` feeds need flagging.
- **Preserve mentionsApp compatibility.** worldmonitor can surface transcript sources (press briefing archives, interview feeds) useful for `mentionsApp` — but route through `@alphaagent`, not through `politicsIntelIngest`.

---

## Running Locally

```bash
git clone https://github.com/koala73/worldmonitor
cd worldmonitor
npm install
npm run dev          # opens localhost:5173 (world variant)
npm run dev:finance  # finance variant
npm run dev:tech     # tech variant
```

Optional: `.env.local` for Redis (Upstash) caching and local Ollama integration.
Production: `npm run build:full` — supports Vercel Edge Functions.

---

## When to Query worldmonitor

| Market type | Query worldmonitor? | What to look for |
|-------------|--------------------|--------------------|
| Federal election | Yes | Polling convergence, news sentiment shift, economic headlines |
| Geopolitical event | Yes (primary source) | Event clusters, urgency heat, conflict region tags |
| Cabinet appointment | Conditional | Nomination news, Senate confirmation signals |
| Earnings mentions | Conditional | Company news that affects topic selection at the call |
| Sports market | No | Not applicable |
| Fed presser mentions | No | Fed communications are their own source |
