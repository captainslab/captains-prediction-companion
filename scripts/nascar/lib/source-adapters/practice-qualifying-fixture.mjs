// Read-only fixture adapter for NASCAR practice + qualifying data.
// Fixture-first. No live network. No credentials.
//
// Surfaces the driver-universe fields required by later stages:
//   current_points_rank, starting_position, practice_rank, multi_lap_rank,
//   track_history_signal, liquidity_signal, override_reasons
//
// NOTE on top20:
//   `current_points_rank` may be <= 20; that is the modeling candidate-pool input
//   ("top 20 in current points") and is NOT a market lane. Do not conflate with
//   the Kalshi `top20` finish-position market lane.

import { isoNow, makeEnvelope } from '../cache.mjs';

export const SOURCE_ID = 'practice_qualifying';
export const NASCAR_STATS_BASE = 'https://www.nascar.com/stats';

function driverRecord({
  driver_name,
  car_number,
  current_points_rank,
  starting_position,
  practice_rank,
  multi_lap_rank,
  track_history_signal,
  liquidity_signal,
  override_reasons = [],
}) {
  return {
    query_type: 'driver_universe_entry',
    driver_name,
    car_number,
    current_points_rank, // candidate-pool signal only; NOT a market lane
    starting_position,
    practice_rank,
    multi_lap_rank,
    track_history_signal, // strong|neutral|weak|unknown
    liquidity_signal, // strong|thin|noisy|unknown — pass-through, not a recommendation
    override_reasons, // freeform reasons that may later trigger special_event_override
    source_urls: [NASCAR_STATS_BASE],
  };
}

function fixtureDriverRecords() {
  return [
    driverRecord({
      driver_name: 'Driver A',
      car_number: 11,
      current_points_rank: 4,
      starting_position: 2,
      practice_rank: 3,
      multi_lap_rank: 2,
      track_history_signal: 'strong',
      liquidity_signal: 'strong',
      override_reasons: [],
    }),
    driverRecord({
      driver_name: 'Driver B',
      car_number: 24,
      current_points_rank: 17,
      starting_position: 8,
      practice_rank: 12,
      multi_lap_rank: 9,
      track_history_signal: 'neutral',
      liquidity_signal: 'thin',
      override_reasons: ['thin_liquidity'],
    }),
    driverRecord({
      driver_name: 'Driver C',
      car_number: 99,
      current_points_rank: 27,
      starting_position: 22,
      practice_rank: 19,
      multi_lap_rank: 25,
      track_history_signal: 'weak',
      liquidity_signal: 'noisy',
      override_reasons: ['out_of_points_pool', 'weak_track_history'],
    }),
  ];
}

export function fixturePracticeQualifyingEnvelope({
  checked_at_utc = '2026-05-15T14:00:00.000Z',
  outputDir = 'state/nascar/_dry-run/discovery',
} = {}) {
  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/practice_qualifying_adapter.json`,
    required: false,
    records: fixtureDriverRecords(),
    warnings: [
      'Fixture mode: no live practice/qualifying source was called.',
      'current_points_rank is a candidate-pool signal only; it is NOT the top20 market lane.',
    ],
    source_urls: [NASCAR_STATS_BASE],
  });
}

export async function fetchPracticeQualifyingReadonly({
  outputDir = 'state/nascar/_dry-run/discovery',
  fixturesOnly = true,
  now = new Date(),
} = {}) {
  const checked_at_utc = isoNow(now);
  if (fixturesOnly) {
    return fixturePracticeQualifyingEnvelope({ checked_at_utc, outputDir });
  }
  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'blocked',
    checked_at_utc,
    cache_path: `${outputDir}/practice_qualifying_adapter.json`,
    required: false,
    errors: ['Live mode not implemented in Stage 2; fixtures-only.'],
    source_urls: [NASCAR_STATS_BASE],
  });
}
