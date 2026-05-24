// Carb Day (May 23, 2026) / final practice speeds adapter.
//
// Source: IndyCar.com / motorsport.com Carb Day practice report.
// Snapshot: scripts/indycar/lib/source-adapters/snapshots/carb-day-2026.json
//
// Carb Day is the final practice session before the Indy 500. Results are
// often published as top-N only. Non-top-N drivers get present=false (not fabricated).
// Read-only. No live network. No credentials.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, 'snapshots/carb-day-2026.json');
const SOURCE_ID = 'carb_day_2026';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Speed -> score: faster than P1 reference impossible; P1 = 100, typical range ~225-232 mph at IMS.
// Use rank-based scoring: P1 -> 100, Pn -> max(0, 100 - (n-1)*4).
function rankToScore(rank) {
  if (!Number.isFinite(rank)) return null;
  return Math.max(0, Math.round(100 - (rank - 1) * 4));
}

export function carbDayEnvelope({
  checked_at_utc = '2026-05-24T00:00:00.000Z',
  outputDir = 'state/indycar/2026-05-25/discovery',
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  let snap;
  try {
    snap = loadJson(snapshotPath);
  } catch {
    return makeEnvelope({
      source_id: SOURCE_ID,
      status: 'degraded',
      checked_at_utc,
      cache_path: `${outputDir}/carb_day_2026_adapter.json`,
      required: false,
      records: [],
      warnings: ['Carb Day snapshot not found — layer MISSING for all drivers.'],
      errors: ['carb-day-2026.json not present'],
      source_urls: [],
    });
  }

  const records = [];
  const warnings = [];
  const topN = snap.practice_top_n ?? [];

  for (const entry of topN) {
    const rank = Number(entry.rank);
    const score = rankToScore(rank);
    records.push({
      query_type: 'carb_day_practice',
      driver_name: entry.driver,
      car_number: entry.car ?? null,
      present: true,
      rank,
      speed_mph: entry.speed_mph ?? null,
      time: entry.time ?? null,
      score,
      sample_quality: 'partial',
      detail: `Carb Day P${rank}${entry.speed_mph ? ` (${entry.speed_mph} mph)` : ''}`,
      source_basis: 'IndyCar Carb Day 2026 (May 23) practice — top N only',
    });
  }

  if (topN.length === 0) {
    warnings.push('Carb Day: no top-N entries in snapshot — layer MISSING for all drivers.');
  } else {
    warnings.push(`Carb Day: only top-${topN.length} published; remaining drivers have no Carb Day score.`);
  }

  return makeEnvelope({
    source_id: SOURCE_ID,
    status: snap.status ?? 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/carb_day_2026_adapter.json`,
    required: false,
    records,
    warnings,
    errors: [],
    source_urls: snap.source_urls ?? [],
  });
}
