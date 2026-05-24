// IndyCar baseline fundamentals adapter.
//
// Source: Hand-coded from publicly known IndyCar team/driver quality
// context for the 2026 Indy 500 field. Ratings are based on:
//   - Team championship history and resource level (team_equipment_quality)
//   - Driver career win rate, championship form, and oval ability (driver_skill_rating)
//   - Driver IMS-specific ability to convert pace to finish (driver_ability_to_convert)
//   - Strategy track record and crew chief quality (strategy_risk_rating)
//
// Snapshot: scripts/indycar/lib/source-adapters/snapshots/indycar-baseline-fundamentals-2026.json
//
// Read-only. No live network. No fabricated race finishes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  __dirname, 'snapshots/indycar-baseline-fundamentals-2026.json',
);
const SOURCE_ID = 'indycar_baseline_fundamentals';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function indycarBaselineFundamentalsEnvelope({
  checked_at_utc,
  outputDir = 'state/indycar/2026-05-25/discovery',
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  const snap = loadJson(snapshotPath);
  const records = [];

  for (const d of snap.drivers ?? []) {
    records.push({
      query_type: 'baseline_fundamentals',
      driver_name: d.driver,
      car_number: d.car ?? null,
      team: d.team ?? null,
      engine: d.engine ?? null,
      driver_skill_rating: d.driver_skill_rating ?? null,
      driver_ability_to_convert: d.driver_ability_to_convert ?? null,
      team_equipment_quality: d.team_equipment_quality ?? null,
      strategy_risk_rating: d.strategy_risk_rating ?? null,
      data_quality: 'ok',
      source_basis: 'Hand-coded from public IndyCar team/driver context for 2026 Indy 500',
    });
  }

  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/indycar_baseline_fundamentals_adapter.json`,
    required: false,
    records,
    warnings: [
      'Ratings are derived from public context (team resources, career stats, owner points) — not from telemetry or proprietary data.',
    ],
    errors: [],
    source_urls: snap.source_urls ?? [],
  });
}
