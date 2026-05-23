// Cup-points top-20 adapter.
//
// Surfaces the CURRENT NASCAR Cup Series Drivers' championship top-20 standings
// as the canonical candidate pool for the next race's multi-lane ceiling board.
//
// Source: Wikipedia '2026 NASCAR Cup Series' — Drivers' championship table.
// Snapshot: scripts/nascar/lib/source-adapters/snapshots/
//             wikipedia-cup-points-2026-pre-coca-cola-600.json
//
// Joining: car_number / team / manufacturer are sourced from the Coca-Cola 600
// starting-grid snapshot (Wikipedia '2026 Coca-Cola 600') so the pool entries
// carry verifiable, race-event-correct identity fields. No live network.
//
// Read-only. No credentials. No trading. No fabricated drivers, no padding —
// if a points-top-20 driver is missing from the grid snapshot, the entry is
// still emitted with team/car/manufacturer set to null and a join_warning.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { isoNow, makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STANDINGS_SNAPSHOT_PATH = resolve(
  __dirname,
  'snapshots',
  'wikipedia-cup-points-2026-pre-coca-cola-600.json',
);
const GRID_SNAPSHOT_PATH = resolve(
  __dirname,
  'snapshots',
  'wikipedia-coca-cola-600-2026.json',
);

const STANDINGS_SOURCE_ID = 'cup_points_top_20';
const STANDINGS_SOURCE_URL = 'https://en.wikipedia.org/wiki/2026_NASCAR_Cup_Series';
const GRID_SOURCE_URL = 'https://en.wikipedia.org/wiki/2026_Coca-Cola_600';

function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function cupPointsTop20Envelope({
  checked_at_utc,
  outputDir = 'state/nascar/_dry-run/discovery',
  standingsSnapshotPath = STANDINGS_SNAPSHOT_PATH,
  gridSnapshotPath = GRID_SNAPSHOT_PATH,
  poolSize = 20,
} = {}) {
  const standings = loadJson(standingsSnapshotPath);
  const grid = loadJson(gridSnapshotPath);

  const gridByName = new Map();
  for (const row of grid.starting_grid ?? []) {
    gridByName.set(normalizeName(row.driver), row);
  }

  const warnings = [];
  const errors = [];
  const records = [];

  const top = (standings.standings ?? []).slice(0, poolSize);
  if (top.length < poolSize) {
    warnings.push(
      `Cup-points standings snapshot has only ${top.length} entries (< ${poolSize}); pool is short.`,
    );
  }

  for (const entry of top) {
    const norm = normalizeName(entry.driver);
    const g = gridByName.get(norm) ?? null;
    const join_status = g ? 'matched_starting_grid' : 'no_grid_join';
    if (!g) {
      warnings.push(
        `Cup-points top-20 driver "${entry.driver}" not found in 2026 Coca-Cola 600 starting-grid snapshot; emitted without car/team/manufacturer.`,
      );
    }
    records.push({
      query_type: 'cup_points_top_20_entry',
      points_position: entry.pos,
      season_points: entry.points,
      driver_name: g ? g.driver : entry.driver,
      car_number: g ? g.car : null,
      team: g ? g.team : null,
      manufacturer: g ? g.manufacturer : null,
      starting_grid_position: g ? g.pos : null,
      join_status,
    });
  }

  const envelope = makeEnvelope({
    source_id: STANDINGS_SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/${STANDINGS_SOURCE_ID}_adapter.json`,
    required: true,
    records,
    warnings,
    errors,
    source_urls: [STANDINGS_SOURCE_URL, GRID_SOURCE_URL],
  });

  return {
    ...envelope,
    pool_basis: 'cup_points_top_20',
    standings_snapshot_id: standings.snapshot_id,
    standings_snapshot_source_url: standings.snapshot_source_url,
    standings_snapshot_date: standings.snapshot_date,
    standings_as_of_event_label: standings.as_of_event_label,
    grid_snapshot_id: grid.snapshot_id,
    grid_snapshot_source_url: grid.snapshot_source_url ?? null,
    pool_size_requested: poolSize,
    pool_size_actual: records.length,
    source_notes: [
      `Top-${records.length} by Cup Series season points, transcribed from ${standings.snapshot_source_url} (${standings.snapshot_date}).`,
      `Car/team/manufacturer joined from 2026 Coca-Cola 600 starting-grid snapshot (${grid.snapshot_source_url ?? GRID_SOURCE_URL}).`,
      'No live network. No fabricated drivers. Drivers without a grid match are emitted with null car/team/manufacturer and a join_warning.',
    ],
  };
}

export async function fetchCupPointsTop20Readonly({
  outputDir = 'state/nascar/_dry-run/discovery',
  poolSize = 20,
  fixturesOnly = true,
  now = new Date(),
} = {}) {
  const checked_at_utc = isoNow(now);
  if (!fixturesOnly) {
    // Live fetch intentionally not implemented — fall back to the snapshot.
  }
  return cupPointsTop20Envelope({ checked_at_utc, outputDir, poolSize });
}
