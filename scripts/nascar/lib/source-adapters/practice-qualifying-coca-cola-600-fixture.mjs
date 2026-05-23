// Downgraded practice/qualifying envelope for the Coca-Cola 600 dry-run packet.
// User-mandated downgrade-instead-of-faking path:
//   practice/qualifying data was not available at packet time, so this envelope
//   is marked status='degraded' with placeholder driver records flagged unknown.
// No live network. No credentials. No trading.

import { makeEnvelope } from '../cache.mjs';

export const SOURCE_ID = 'practice_qualifying';

function placeholderDriver({ driver_name, car_number, current_points_rank }) {
  return {
    query_type: 'driver_universe_entry',
    driver_name,
    car_number,
    current_points_rank,
    starting_position: null,
    practice_rank: null,
    multi_lap_rank: null,
    track_history_signal: 'unknown',
    liquidity_signal: 'unknown',
    override_reasons: [],
    data_quality: 'unknown_downgrade_placeholder',
    notes: 'Practice/qualifying data unavailable at packet time; placeholder only.',
    source_urls: [],
  };
}

export function fixtureCocaCola600PracticeEnvelope({
  checked_at_utc = '2026-05-24T18:00:00.000Z',
  outputDir = 'state/nascar/2026-05-25/discovery',
} = {}) {
  const records = [
    placeholderDriver({ driver_name: 'Placeholder Driver A', car_number: 1, current_points_rank: 5 }),
    placeholderDriver({ driver_name: 'Placeholder Driver B', car_number: 2, current_points_rank: 12 }),
    placeholderDriver({ driver_name: 'Placeholder Driver C', car_number: 3, current_points_rank: 18 }),
  ];
  const env = makeEnvelope({
    source_id: SOURCE_ID,
    status: 'degraded',
    checked_at_utc,
    cache_path: `${outputDir}/practice_qualifying_adapter.json`,
    required: false,
    records,
    warnings: [
      'Coca-Cola 600 practice/qualifying data unavailable at packet time.',
      'Placeholder driver records inserted so discovery composer can still produce a packet.',
      'No invented driver speeds; track_history_signal and liquidity_signal are "unknown".',
    ],
    errors: [],
    source_urls: [],
  });
  env.degraded_reasons = [
    'practice_qualifying_source_unavailable_at_packet_time',
    'no_starting_grid_published_yet',
    'no_practice_session_results_published_yet',
    'placeholder_driver_records_inserted_to_avoid_fabricated_speeds',
  ];
  return env;
}
