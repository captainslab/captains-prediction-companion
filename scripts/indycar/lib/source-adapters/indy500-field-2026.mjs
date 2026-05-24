// 2026 Indy 500 starting grid + qualifying envelope.
//
// Source: Wikipedia "2026 Indianapolis 500" (CC-BY-SA-4.0).
// Snapshot: scripts/indycar/lib/source-adapters/snapshots/indy500-2026-field.json
//
// Provides:
//   - starting_position from the official 33-car qualifying grid
//   - qualifying_speed_mph from time trials
//   - team, engine manufacturer, car number per entry
//
// No live network at run-time. No credentials. No trading.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeEnvelope } from '../cache.mjs';

export const SOURCE_ID = 'indy500_field_2026';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, 'snapshots/indy500-2026-field.json');

function loadSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
}

export function indy500Field2026Envelope({
  checked_at_utc = '2026-05-24T12:00:00.000Z',
  outputDir = 'state/indycar/2026-05-25/discovery',
} = {}) {
  const snap = loadSnapshot();

  const records = (snap.starting_grid ?? []).map(g => ({
    query_type: 'driver_universe_entry',
    driver_name: g.driver,
    car_number: g.car,
    team: g.team,
    engine: g.engine,
    starting_position: g.pos,
    qualifying_speed_mph: g.qual_speed_mph ?? null,
    qualifying_time: g.qual_time ?? null,
    rookie: g.rookie === true,
    data_quality: 'sourced',
    source_urls: [snap.snapshot_source_url],
  }));

  const env = makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/indy500_field_2026_adapter.json`,
    required: true,
    records,
    warnings: snap.warnings ?? [],
    errors: [],
    source_urls: [snap.snapshot_source_url],
  });
  env.snapshot = {
    snapshot_id: snap.snapshot_id,
    snapshot_date: snap.snapshot_date,
    license: snap.license,
    pole_position_driver: snap.pole_position_driver,
    pole_position_car: snap.pole_position_car,
    qualifying_format: snap.qualifying_format,
  };
  return env;
}
