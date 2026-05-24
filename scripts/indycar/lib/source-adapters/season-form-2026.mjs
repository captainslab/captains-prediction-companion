// 2026 IndyCar NTT Series season-form adapter (pre-Indy 500).
//
// Source: Wikipedia / IndyCar.com 2026 NTT IndyCar Series race results.
// Snapshot: scripts/indycar/lib/source-adapters/snapshots/indycar-season-form-2026.json
//
// Covers all 2026 IndyCar races completed before the Indy 500 (May 25, 2026).
// Read-only. No live network. No fabricated finishes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, 'snapshots/indycar-season-form-2026.json');
const SOURCE_ID = 'indycar_season_form_2026';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// P1 -> 100, P33+ -> 0 (scaled for IndyCar 33-car fields)
function finishToScore(avg) {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg))) return null;
  const a = Number(avg);
  const s = Math.round(((33 - a) / 32) * 100);
  return Math.max(0, Math.min(100, s));
}

export function indyCarSeasonForm2026Envelope({
  checked_at_utc,
  outputDir = 'state/indycar/2026-05-25/discovery',
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  const snap = loadJson(snapshotPath);
  const records = [];
  const warnings = [];

  for (const d of snap.drivers ?? []) {
    const agg = d.aggregates ?? {};
    const races_run = Number(agg.races_run) || 0;
    if (races_run === 0) {
      records.push({
        query_type: 'season_form_2026',
        driver_name: d.driver,
        present: false,
        missing_reason: 'no 2026 IndyCar season starts before the Indy 500',
        races_run: 0,
        score: null,
      });
      warnings.push(`season-form: ${d.driver} has no 2026 pre-Indy starts.`);
      continue;
    }
    const score = finishToScore(agg.average_finish_excluding_dnf);
    records.push({
      query_type: 'season_form_2026',
      driver_name: d.driver,
      present: true,
      races_run,
      wins: Number(agg.wins) || 0,
      top_5s: Number(agg.top_5s) || 0,
      top_10s: Number(agg.top_10s) || 0,
      dnfs: Number(agg.dnfs) || 0,
      average_finish_excluding_dnf: agg.average_finish_excluding_dnf ?? null,
      score,
      sample_quality: races_run >= 5 ? 'ok' : (races_run >= 3 ? 'partial' : 'thin'),
      source_basis: 'IndyCar 2026 NTT Series race results (Wikipedia/IndyCar.com; Indy 500 excluded)',
    });
  }

  return {
    ...makeEnvelope({
      source_id: SOURCE_ID,
      status: 'ok',
      checked_at_utc,
      cache_path: `${outputDir}/${SOURCE_ID}_adapter.json`,
      required: false,
      records,
      warnings,
      errors: [],
      source_urls: snap.snapshot_source_urls ?? [],
    }),
    snapshot_id: snap.snapshot_id,
    snapshot_date: snap.snapshot_date,
    races_covered: snap.races_covered ?? [],
  };
}
