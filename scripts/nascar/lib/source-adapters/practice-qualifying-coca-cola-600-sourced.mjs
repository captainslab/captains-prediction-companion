// Sourced practice/qualifying envelope for the 2026 Coca-Cola 600.
//
// Sources: public race-page, starting-lineup, and practice-result snapshots.
// Snapshot: scripts/nascar/lib/source-adapters/snapshots/wikipedia-coca-cola-600-2026.json
//
// Provides:
//   - starting_position from the published competition-based grid
//   - practice_rank from the local public-source snapshot. The current
//     snapshot ingests top-3 practice ranks only; remaining drivers get
//     null practice_rank -- NOT fabricated.
//   - multi_lap_rank set to null (snapshot does not publish it cleanly)
//   - track_history_signal / liquidity_signal stay "unknown" (not in this source)
//
// No live network at run-time. No credentials. No trading.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeEnvelope } from '../cache.mjs';

export const SOURCE_ID = 'practice_qualifying';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, 'snapshots/wikipedia-coca-cola-600-2026.json');

function loadSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
}

function snapshotSourceUrls(snap) {
  return [
    ...(snap.snapshot_source_urls ?? []),
    ...(snap.starting_grid_source_urls ?? []),
    ...(snap.practice_source_urls ?? []),
    snap.snapshot_source_url,
  ].filter(Boolean);
}

export function sourcedCocaCola600PracticeEnvelope({
  checked_at_utc = '2026-05-25T01:00:00.000Z',
  outputDir = 'state/nascar/2026-05-25/discovery',
} = {}) {
  const snap = loadSnapshot();
  const practiceRows = snap.practice_results ?? snap.practice_top3 ?? [];
  const source_urls = [...new Set(snapshotSourceUrls(snap))];
  const practiceByCar = new Map(practiceRows.map(p => [p.car, p.pos]));
  const records = snap.starting_grid.map(g => ({
    query_type: 'driver_universe_entry',
    driver_name: g.driver,
    car_number: g.car,
    team: g.team,
    manufacturer: g.manufacturer,
    // current_points_rank not provided by this source; leave null so
    // downstream pool logic does NOT inject fake rankings. Pool inclusion
    // via fundamentals composite score is the primary path.
    current_points_rank: null,
    starting_position: g.pos,
    practice_rank: practiceByCar.get(g.car) ?? null,
    multi_lap_rank: null,
    track_history_signal: 'unknown',
    liquidity_signal: 'unknown',
    override_reasons: [],
    data_quality: 'sourced',
    notes: practiceByCar.has(g.car)
      ? 'Starting grid from public lineup sources; practice rank from public practice-result snapshot.'
      : 'Starting grid from public lineup sources; practice rank not ingested in current model snapshot.',
    source_urls,
  }));
  const practiceScope = practiceRows.length >= records.length
    ? 'full-field'
    : `top-${practiceRows.length}`;

  const env = makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/practice_qualifying_adapter.json`,
    required: false,
    records,
    warnings: [
      `Practice results are ${practiceScope} in the current model snapshot; non-ingested drivers have practice_rank=null (not fabricated).`,
      'multi_lap_rank is null — source does not publish it cleanly.',
      'current_points_rank is null on these records — pool selection should rely on fundamentals composite score, not these placeholder ranks.',
    ],
    errors: [],
    source_urls,
  });
  const gridBasis = /competition-based/i.test(snap.qualifying_format_note ?? '')
    ? 'rules_set'
    : 'qualifying_session';
  env.snapshot = {
    snapshot_id: snap.snapshot_id,
    snapshot_date: snap.snapshot_date,
    license: snap.license,
    qualifying_format_note: snap.qualifying_format_note,
    pole_position_driver: snap.pole_position_driver,
    pole_position_car: snap.pole_position_car,
    grid_basis: gridBasis,
  };
  if (gridBasis === 'rules_set') {
    env.warnings = [
      ...(env.warnings ?? []),
      'grid_basis=rules_set: timed qualifying cancelled; grid set by competition-based formula. practice_qualifying layer weight will be reduced downstream.',
    ];
  }
  return env;
}
