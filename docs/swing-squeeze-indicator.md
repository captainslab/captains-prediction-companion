# Swing Squeeze Indicator Concept

Purpose: help users notice live prediction-market setups where price movement may be unusually sensitive to new information. This is an alerting and context tool, not financial advice and not a performance claim.

Current data status: use demo/sample market frames only until live market, order book, model, game clock, and catalyst feeds are wired. Every non-live view must show `Demo data` or `Sample only`.

## Product promise

Short copy: "Spot compressed markets before the next move gets crowded."

Safe subcopy: "Swing Squeeze highlights stale pricing, thin books, momentum bias, and upcoming catalysts so you can decide what deserves attention. It does not predict outcomes or recommend trades."

## Core idea

Prediction-market adaptation of TTM Squeeze:
- Compression: market price has stopped moving while relevant game/event state is changing or about to change.
- Trigger: compression releases through price, spread, volume, book imbalance, or catalyst confirmation.
- Bias: direction suggested by model-vs-market edge plus short-term price/order-book momentum.
- Risk context: latency, book depth, and catalyst proximity determine whether the signal is actionable, noisy, or stale.

## Inputs

Live-ready schema, demo-fillable now:

```ts
export type SwingSqueezeFrame = {
  marketId: string
  label: string
  source: 'kalshi' | 'polymarket' | 'demo'
  isDemo: boolean
  timestampMs: number

  market: {
    yesBid: number | null
    yesAsk: number | null
    midpoint: number | null
    last: number | null
    spreadCents: number | null
    volume1m: number | null
    priceChange30sCents: number | null
    priceChange2mCents: number | null
  }

  model: {
    fairYes: number | null
    fairYesUpdatedMs: number | null
    confidence: 'low' | 'medium' | 'high' | 'unknown'
  }

  book: {
    yesDepthCents1: number | null
    noDepthCents1: number | null
    yesDepthCents3: number | null
    noDepthCents3: number | null
    imbalance: number | null // -1 NO-heavy, +1 YES-heavy
  }

  eventState: {
    clockLabel: string | null
    stateUpdatedMs: number | null
    stateDeltaLabel: string | null
  }

  catalyst: {
    label: string | null
    etaSeconds: number | null
    severity: 'low' | 'medium' | 'high' | 'unknown'
  }
}
```

## Signal outputs

```ts
export type SwingSqueezeSignal = {
  state: 'idle' | 'compression' | 'armed' | 'triggered' | 'cooldown' | 'no-data'
  score: number // 0-100
  bias: 'YES' | 'NO' | 'neutral' | 'unknown'
  biasStrength: number // 0-100
  edgeCents: number | null // model fair - market midpoint, signed for YES
  latencyMs: number | null
  bookDepthLabel: 'thin' | 'normal' | 'deep' | 'unknown'
  catalystLabel: string
  reasons: string[]
  warnings: string[]
  demoLabel: string | null
}
```

## Scoring rules

Use simple weighted rules first; replace with calibrated model later only after logged history exists.

Compression score, 0-100:
- Price compression: 0-25. High when 2-minute price range is low relative to recent typical movement.
- Spread compression/fragility: 0-15. High when spread is tight enough to break but total near-touch depth is low.
- State divergence: 0-25. High when event/game state changed but midpoint moved less than expected.
- Book imbalance: 0-15. High when one side of book is lopsided or thin.
- Catalyst proximity: 0-20. High when a known clock/catalyst is imminent.

State thresholds:
- no-data: missing midpoint, spread, and event/model inputs.
- idle: score < 45.
- compression: score 45-64, no confirmed directional trigger.
- armed: score 65-79 or catalyst ETA <= 90s with stale market.
- triggered: score >= 65 and at least one release condition fires.
- cooldown: 60-180s after trigger, unless new catalyst appears.

Trigger conditions, any two preferred:
- midpoint moves >= 3 cents within 30 seconds.
- spread widens by >= 2 cents while near-touch depth drops >= 40%.
- new trade burst: 1-minute volume >= 2x local baseline.
- model edge crosses threshold: absolute edge >= 4 cents and model update is fresh.
- catalyst occurs or ETA hits zero with order-book imbalance >= 0.35.

Bias rules:
- YES bias if edgeCents >= +3 and momentum >= 0, or book imbalance favors YES with fresh positive state delta.
- NO bias if edgeCents <= -3 and momentum <= 0, or book imbalance favors NO with fresh negative state delta.
- Neutral when edge and momentum conflict or absolute edge < 2 cents.
- Unknown when model fair value or midpoint is missing.

Latency rules:
- Fresh: market, book, and event state all updated <= 2s ago.
- Lagging: any required feed 2-10s old.
- Stale: any required feed > 10s old.
- Unknown: timestamp missing.

Book depth rules:
- Thin: combined near-touch depth below configured market minimum or one side < 30% of the other.
- Normal: enough near-touch quantity on both sides with moderate imbalance.
- Deep: both sides exceed configured deep threshold and spread is stable.
- Unknown: depth unavailable.

Catalyst rules:
- High: play/drive/inning/round/settlement-adjacent moment, official update, injury/substitution, weather/economic release.
- Medium: scheduled possession/period transition or recurring clock checkpoint.
- Low: no near-term catalyst.
- Unknown: no catalyst feed.

## UI modules

1. Squeeze Badge
- Compact status pill beside market title.
- States:
  - No data: gray, "Squeeze: not connected"
  - Idle: gray, "No squeeze"
  - Compression: amber, "Compression building"
  - Armed: orange, "Squeeze armed"
  - Triggered: cyan/green, "Swing trigger"
  - Cooldown: purple/gray, "Cooling down"
- Always show `Demo data` pill when isDemo is true.

2. Swing Meter
- Horizontal 0-100 meter with zones: Quiet, Building, Armed, Triggered.
- Tooltip copy: "Composite of market compression, stale-vs-state gap, book fragility, and catalyst proximity."

3. Bias Chip
- YES/NO/Neutral/Unknown chip with strength bar.
- Copy examples:
  - "Bias: YES, moderate"
  - "Bias: NO, weak"
  - "Bias: neutral — edge and momentum disagree"
  - "Bias unavailable — missing fair value"

4. Edge Row
- Shows model fair, market midpoint, and edge.
- Formula label: "Edge = model fair YES - market midpoint"
- Copy:
  - Positive: "+4.2¢ vs midpoint"
  - Negative: "-3.1¢ vs midpoint"
  - Missing: "Edge unavailable until model fair value is connected"

5. Feed Freshness / Latency Row
- Shows market feed, book feed, event state feed freshness.
- Copy:
  - "Fresh: all feeds under 2s"
  - "Lagging: event state 7s old"
  - "Stale: do not treat this as live"
  - "Demo timestamps only"

6. Book Depth Card
- Mini depth summary with spread, near-touch depth, imbalance.
- Copy:
  - "Thin book: small orders may move price"
  - "Lopsided YES book: support/resistance is uneven"
  - "Depth normal"
  - "Depth unavailable"

7. Catalyst Card
- Shows next catalyst label and ETA.
- Copy:
  - "Catalyst in 0:42 — possession change"
  - "Catalyst now — official update pending"
  - "No near-term catalyst detected"
  - "Catalyst feed not connected"

8. Reason Stack
- 2-4 short bullets generated from deterministic rule reasons.
- Examples:
  - "Market midpoint flat for 90s while game state changed."
  - "Spread tight, but near-touch depth is thin."
  - "Model fair is 4.2¢ above midpoint."
  - "Next catalyst in under 60s."

9. Empty / Demo State Panel
- Header: "Swing Squeeze demo"
- Body: "This preview uses sample frames to show how the indicator will behave once live market, book, model, and event-state feeds are connected."
- CTA: "Connect live feeds" or "View sample market"

## Market card layout

Top line:
- Market title
- Squeeze Badge
- Demo data pill if applicable

Second line:
- Swing Meter
- Bias Chip
- Edge Row

Context grid:
- Latency
- Book Depth
- Catalyst

Expandable detail:
- Reasons
- Raw metrics
- Method note

Method note copy:
"Swing Squeeze is an attention signal. It combines market compression, model-vs-market edge, book depth, feed freshness, and catalyst proximity. It is not a recommendation to buy or sell, and demo/sample data does not represent live market conditions."

## Copy library

Hero:
"Swing Squeeze"
"Find the moments when a live prediction market is wound tight."
"Compression is not a prediction. It is a watchlist signal: the market looks stale, thin, or catalyst-sensitive enough to deserve a closer look."

Module intro:
"Built for live Kalshi and sports-style markets where the chart can sit still, then move all at once."

Safe disclaimer:
"For research and alerting only. Not financial advice. No indicator guarantees timing, direction, fill quality, or profit."

Demo disclaimer:
"Demo mode uses sample frames. Prices, depth, edge, catalysts, and timestamps are illustrative until live integrations are enabled."

Triggered copy:
"Swing trigger: compression released. Check freshness, spread, and book depth before acting."

Armed copy:
"Squeeze armed: market is compressed and a catalyst or stale-state gap is near."

Compression copy:
"Compression building: price is quiet while setup pressure is rising."

Idle copy:
"No squeeze: current inputs do not show a compressed swing setup."

No-data copy:
"Not connected: waiting for market, model, book, and event-state feeds."

## Implementation notes

First build with deterministic helper functions:
- `computeSwingSqueeze(frame): SwingSqueezeSignal`
- `classifyLatency(frame)`
- `classifyBookDepth(frame)`
- `classifyCatalyst(frame)`
- `deriveBias(frame)`
- `buildReasons(frame, signal)`

Use feature flag:
- `NEXT_PUBLIC_ENABLE_SWING_SQUEEZE_DEMO=true`

Do not label any state as live unless:
- `isDemo === false`
- all required feed timestamps are present
- latency classification is Fresh or Lagging
- source is a connected exchange/feed adapter

Initial visual route/component options:
- Route: `/dashboard/swing-squeeze` or module inside existing dashboard.
- Component: `SwingSqueezeCard.tsx` fed by static demo frames first.
- Types: `frontend/types/swing-squeeze.ts`.
