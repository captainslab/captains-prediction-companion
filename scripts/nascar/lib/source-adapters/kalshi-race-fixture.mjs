// Read-only fixture adapter for Kalshi NASCAR race market boards.
// Fixture-first. No authenticated endpoints. No order placement. No live network by default.
//
// Race lane coverage required by Stage 1 router:
//   win, top3, top5, top10, top20, fastest_lap
//
// IMPORTANT:
//   - top20 here is the FINISH-POSITION market lane.
//     It is unrelated to the modeling "top 20 in current points" candidate-pool rule
//     applied downstream by scoring. This adapter never mentions points-pool eligibility.
//   - Records carry NO price recommendations. yes_bid/yes_ask are raw board snapshots only.
//   - Records carry NO trade, order, stake, pick, recommendation, fair_value, or execution
//     fields and MUST NOT introduce them.

import { isoNow, makeEnvelope } from '../cache.mjs';

export const KALSHI_PUBLIC_BASE = 'https://kalshi.com/markets';
export const SOURCE_ID = 'kalshi_race';

export const RACE_LANES = Object.freeze([
  'win',
  'top3',
  'top5',
  'top10',
  'top20',
  'fastest_lap',
]);

function raceMarketRecord({ lane, ticker, driver_name, yes_bid, yes_ask, event_ticker, event_format }) {
  return {
    query_type: 'race_market_board',
    market_ticker: ticker,
    event_ticker,
    market_lane: lane, // one of RACE_LANES; FINISH-POSITION semantics, not points-pool
    driver_name: driver_name ?? null,
    event_format, // points|all_star|clash|exhibition|heat|qualifying_transfer|cutdown
    yes_bid, // raw board snapshot, not a recommendation
    yes_ask, // raw board snapshot, not a recommendation
    volume: null,
    open_interest: null,
    last_update_utc: null,
    source_urls: [`${KALSHI_PUBLIC_BASE}/${event_ticker}`.toLowerCase()],
    notes:
      lane === 'top20'
        ? 'top20 here is the finish-position market lane; not the modeling "top 20 in current points" rule'
        : null,
  };
}

function fixtureRecords({ event_format = 'points' } = {}) {
  const event_ticker = event_format === 'all_star' ? 'KXNASCAR-CUP-2026-ALLSTAR' : 'KXNASCAR-CUP-2026-DAYTONA';
  return [
    raceMarketRecord({ lane: 'win',         ticker: `${event_ticker}-WIN-DRIVER-A`,       driver_name: 'Driver A', yes_bid: 0.18, yes_ask: 0.22, event_ticker, event_format }),
    raceMarketRecord({ lane: 'top3',        ticker: `${event_ticker}-TOP3-DRIVER-A`,      driver_name: 'Driver A', yes_bid: 0.35, yes_ask: 0.40, event_ticker, event_format }),
    raceMarketRecord({ lane: 'top5',        ticker: `${event_ticker}-TOP5-DRIVER-A`,      driver_name: 'Driver A', yes_bid: 0.45, yes_ask: 0.50, event_ticker, event_format }),
    raceMarketRecord({ lane: 'top10',       ticker: `${event_ticker}-TOP10-DRIVER-A`,     driver_name: 'Driver A', yes_bid: 0.60, yes_ask: 0.65, event_ticker, event_format }),
    raceMarketRecord({ lane: 'top20',       ticker: `${event_ticker}-TOP20-DRIVER-A`,     driver_name: 'Driver A', yes_bid: 0.78, yes_ask: 0.82, event_ticker, event_format }),
    raceMarketRecord({ lane: 'fastest_lap', ticker: `${event_ticker}-FASTESTLAP-DRIVER-A`, driver_name: 'Driver A', yes_bid: 0.04, yes_ask: 0.07, event_ticker, event_format }),
  ];
}

export function fixtureKalshiRaceEnvelope({
  checked_at_utc = '2026-05-15T14:00:00.000Z',
  outputDir = 'state/nascar/_dry-run/discovery',
  event_format = 'points',
} = {}) {
  const warnings = ['Fixture mode: no live Kalshi NASCAR board was called.'];
  if (event_format !== 'points') {
    warnings.push(
      `Fixture event_format="${event_format}" is a special/exhibition-style event; downstream scoring must apply special_event_override and not use it as the default model.`,
    );
  }
  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/kalshi_race_adapter.json`,
    required: true,
    records: fixtureRecords({ event_format }),
    warnings,
    source_urls: [KALSHI_PUBLIC_BASE],
  });
}

export async function fetchKalshiRaceReadonly({
  outputDir = 'state/nascar/_dry-run/discovery',
  fixturesOnly = true,
  now = new Date(),
  event_format = 'points',
} = {}) {
  const checked_at_utc = isoNow(now);
  if (fixturesOnly) {
    return fixtureKalshiRaceEnvelope({ checked_at_utc, outputDir, event_format });
  }
  // Stage 2 dry-run intentionally refuses live mode. No credentials, no trade endpoints.
  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'blocked',
    checked_at_utc,
    cache_path: `${outputDir}/kalshi_race_adapter.json`,
    required: true,
    errors: ['Live mode not implemented in Stage 2; fixtures-only.'],
    source_urls: [KALSHI_PUBLIC_BASE],
  });
}
