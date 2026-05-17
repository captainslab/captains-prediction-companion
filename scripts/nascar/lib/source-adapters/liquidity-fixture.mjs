// Read-only fixture adapter for Kalshi NASCAR market liquidity sanity.
// Fixture-first. No credentials. No order placement. No live network by default.
//
// Records pass through spread / volume / open-interest snapshots and flag
// weak or noisy markets via `liquidity_status` and `flags`.
// Stage 2 does NOT make recommendations, does NOT size bets, and does NOT
// emit trade, order, stake, pick, fair_value, or execution fields.

import { isoNow, makeEnvelope } from '../cache.mjs';

export const SOURCE_ID = 'liquidity';
export const KALSHI_PUBLIC_BASE = 'https://kalshi.com/markets';

function liquidityRecord({
  market_ticker,
  event_ticker,
  market_lane,
  best_bid,
  best_ask,
  volume,
  open_interest,
}) {
  const spread =
    typeof best_bid === 'number' && typeof best_ask === 'number'
      ? Math.round((best_ask - best_bid) * 100) / 100
      : null;
  const flags = [];
  if (spread !== null && spread > 0.10) flags.push('wide_spread');
  if (typeof volume === 'number' && volume < 50) flags.push('low_volume');
  if (typeof open_interest === 'number' && open_interest < 100) flags.push('low_open_interest');

  let liquidity_status = 'strong';
  if (flags.includes('wide_spread') && (flags.includes('low_volume') || flags.includes('low_open_interest'))) {
    liquidity_status = 'noisy';
  } else if (flags.length > 0) {
    liquidity_status = 'thin';
  }

  return {
    query_type: 'market_liquidity',
    market_ticker,
    event_ticker,
    market_lane,
    best_bid,
    best_ask,
    spread,
    volume,
    open_interest,
    liquidity_status,
    flags,
    source_urls: [`${KALSHI_PUBLIC_BASE}/${event_ticker}`.toLowerCase()],
    notes: 'Liquidity snapshot only; not a recommendation.',
  };
}

function fixtureRecords() {
  return [
    liquidityRecord({
      market_ticker: 'KXNASCAR-CUP-2026-DAYTONA-WIN-DRIVER-A',
      event_ticker: 'KXNASCAR-CUP-2026-DAYTONA',
      market_lane: 'win',
      best_bid: 0.18,
      best_ask: 0.22,
      volume: 4200,
      open_interest: 9000,
    }),
    liquidityRecord({
      market_ticker: 'KXNASCAR-CUP-2026-DAYTONA-TOP20-DRIVER-B',
      event_ticker: 'KXNASCAR-CUP-2026-DAYTONA',
      market_lane: 'top20',
      best_bid: 0.40,
      best_ask: 0.58, // wide spread
      volume: 30, // low
      open_interest: 60, // low
    }),
    liquidityRecord({
      market_ticker: 'KXNASCAR-CUP-2026-DAYTONA-FASTESTLAP-DRIVER-C',
      event_ticker: 'KXNASCAR-CUP-2026-DAYTONA',
      market_lane: 'fastest_lap',
      best_bid: 0.02,
      best_ask: 0.20, // wide
      volume: 800,
      open_interest: 1200,
    }),
  ];
}

export function fixtureLiquidityEnvelope({
  checked_at_utc = '2026-05-15T14:00:00.000Z',
  outputDir = 'state/nascar/_dry-run/discovery',
} = {}) {
  const records = fixtureRecords();
  const flagged = records.filter(r => r.liquidity_status !== 'strong').length;
  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/liquidity_adapter.json`,
    required: false,
    records,
    warnings: [
      'Fixture mode: no live Kalshi liquidity endpoint was called.',
      `${flagged} market(s) flagged thin/noisy. Liquidity flags are inputs only, not recommendations.`,
    ],
    source_urls: [KALSHI_PUBLIC_BASE],
  });
}

export async function fetchLiquidityReadonly({
  outputDir = 'state/nascar/_dry-run/discovery',
  fixturesOnly = true,
  now = new Date(),
} = {}) {
  const checked_at_utc = isoNow(now);
  if (fixturesOnly) {
    return fixtureLiquidityEnvelope({ checked_at_utc, outputDir });
  }
  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'blocked',
    checked_at_utc,
    cache_path: `${outputDir}/liquidity_adapter.json`,
    required: false,
    errors: ['Live mode not implemented in Stage 2; fixtures-only.'],
    source_urls: [KALSHI_PUBLIC_BASE],
  });
}
