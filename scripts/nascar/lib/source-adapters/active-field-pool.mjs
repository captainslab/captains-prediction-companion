// Active-field pool adapter.
//
// Produces the SCORING POOL for the 2026 Coca-Cola 600 as the union of:
//   1. Cup-points top-20 (Drivers' championship standings snapshot), in order
//   2. The remaining published starting-grid entries, appended in grid order
//
// Why this shape:
//   - Score ACTIVE race entries only. Drivers not on the published starting
//     grid never appear in the pool. (Kyle Busch is not entered in 2026 and
//     therefore never appears here — he is handled exclusively as storyline
//     context in the packet renderer, never as a scored driver.)
//   - The top-20 by points is the high-confidence head of the board; the
//     remaining ~19 entries are the "field tail" (part-timers, Open entries,
//     etc.) which still get scored where evidence supports it.
//   - `points_position` is populated only when the driver appears in the
//     points snapshot; field-tail drivers get `points_position: null` —
//     never fabricated.
//
// Read-only. No live network. No fabricated drivers.

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

const SOURCE_ID = 'active_field_pool';
const STANDINGS_SOURCE_URL = 'https://en.wikipedia.org/wiki/2026_NASCAR_Cup_Series';
const GRID_SOURCE_URL = 'https://en.wikipedia.org/wiki/2026_Coca-Cola_600';

function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(i\)|\(R\)/gi, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function loadJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

export function activeFieldPoolEnvelope({
  checked_at_utc,
  outputDir = 'state/nascar/_dry-run/discovery',
  standingsSnapshotPath = STANDINGS_SNAPSHOT_PATH,
  gridSnapshotPath = GRID_SNAPSHOT_PATH,
} = {}) {
  const standings = loadJson(standingsSnapshotPath);
  const grid = loadJson(gridSnapshotPath);

  // Index points by normalized name.
  const pointsByName = new Map();
  for (const s of standings.standings ?? []) {
    pointsByName.set(normalizeName(s.driver), s);
  }

  // Build records: top-20 by points first (in points order), then remaining
  // grid entries (in grid order) that weren't in the top-20.
  const records = [];
  const seen = new Set();

  for (const s of standings.standings ?? []) {
    const norm = normalizeName(s.driver);
    const g = (grid.starting_grid ?? []).find(r => normalizeName(r.driver) === norm) ?? null;
    if (!g) {
      // Top-20 points driver who isn't on the grid (e.g. Kyle Busch were he
      // top-20). Skip — pool is active entries only. Surface as warning.
      continue;
    }
    seen.add(norm);
    records.push({
      query_type: 'active_field_pool_entry',
      pool_section: 'points_top_20',
      points_position: s.pos,
      season_points: s.points,
      driver_name: g.driver,
      car_number: g.car,
      team: g.team,
      manufacturer: g.manufacturer,
      starting_grid_position: g.pos,
    });
  }

  for (const g of grid.starting_grid ?? []) {
    const norm = normalizeName(g.driver);
    if (seen.has(norm)) continue;
    const s = pointsByName.get(norm) ?? null;
    records.push({
      query_type: 'active_field_pool_entry',
      pool_section: 'field_tail',
      points_position: s ? s.pos : null,
      season_points: s ? s.points : null,
      driver_name: g.driver,
      car_number: g.car,
      team: g.team,
      manufacturer: g.manufacturer,
      starting_grid_position: g.pos,
    });
  }

  const warnings = [];
  // Surface any points-top-20 drivers not on the grid (would be a data drift).
  for (const s of standings.standings ?? []) {
    const norm = normalizeName(s.driver);
    if (!(grid.starting_grid ?? []).some(r => normalizeName(r.driver) === norm)) {
      warnings.push(
        `points-top-20 driver "${s.driver}" not on the published Coca-Cola 600 starting grid; excluded from pool (active entries only).`,
      );
    }
  }

  const env = makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/${SOURCE_ID}_adapter.json`,
    required: true,
    records,
    warnings,
    errors: [],
    source_urls: [STANDINGS_SOURCE_URL, GRID_SOURCE_URL],
  });

  return {
    ...env,
    pool_basis: 'cup_points_plus_active_field',
    standings_snapshot_id: standings.snapshot_id,
    standings_snapshot_source_url: standings.snapshot_source_url,
    standings_snapshot_date: standings.snapshot_date,
    standings_as_of_event_label: standings.as_of_event_label,
    grid_snapshot_id: grid.snapshot_id,
    grid_snapshot_source_url: grid.snapshot_source_url ?? GRID_SOURCE_URL,
    grid_basis: /competition-based/i.test(grid.qualifying_format_note ?? '')
      ? 'rules_set'
      : 'qualifying_session',
    qualifying_format_note: grid.qualifying_format_note ?? null,
    pool_size_actual: records.length,
    scored_head_size: records.filter(r => r.pool_section === 'points_top_20').length,
    field_tail_size: records.filter(r => r.pool_section === 'field_tail').length,
    source_notes: [
      `Head of pool: top-${records.filter(r => r.pool_section === 'points_top_20').length} by 2026 Cup Series season points, transcribed from ${standings.snapshot_source_url} (${standings.snapshot_date}).`,
      `Field tail: remaining Coca-Cola 600 grid entries from ${grid.snapshot_source_url ?? GRID_SOURCE_URL}.`,
      'Active entries only. Drivers not on the published starting grid are excluded.',
    ],
  };
}

export async function fetchActiveFieldPoolReadonly({
  outputDir = 'state/nascar/_dry-run/discovery',
  fixturesOnly = true,
  now = new Date(),
} = {}) {
  const checked_at_utc = isoNow(now);
  if (!fixturesOnly) { /* live not implemented */ }
  return activeFieldPoolEnvelope({ checked_at_utc, outputDir });
}
