// 2026 Cup Series season-form adapter.
//
// Reads the manually-transcribed Wikipedia snapshot of the 2026 NCS race-by-race
// matrix (snapshot covers races 1..N completed before the 2026 Coca-Cola 600;
// the All-Star Race is excluded — exhibition / no points).
//
// Era filter: Next Gen / Gen 7 (2022 Daytona 500 onward) — the snapshot is 2026
// only, so this is satisfied trivially.
//
// Read-only. No live network. No fabricated finishes — drivers whose race_by_race
// is empty are emitted with present=false and a missing_reason.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  __dirname,
  'snapshots',
  'wikipedia-cup-2026-season-form-pre-coca-cola-600.json',
);
const SOURCE_ID = 'cup_season_form_2026';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Convert an average finish into a 0-100 score: P1 -> 100, P35+ -> 0.
function finishToScore(avg) {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg))) return null;
  const a = Number(avg);
  const s = Math.round(((35 - a) / 34) * 100);
  return Math.max(0, Math.min(100, s));
}

export function seasonForm2026Envelope({
  checked_at_utc,
  outputDir = 'state/nascar/_dry-run/fundamentals',
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  const snap = loadJson(snapshotPath);
  const records = [];
  const warnings = [];

  for (const d of snap.drivers ?? []) {
    const rbr = Array.isArray(d.race_by_race) ? d.race_by_race : [];
    const agg = d.aggregates ?? {};
    const races_run = Number(agg.races_run) || rbr.length;
    if (races_run === 0) {
      records.push({
        query_type: 'season_form_2026',
        driver_name: d.driver,
        present: false,
        missing_reason: 'no race-by-race rows in 2026 snapshot for this driver',
        races_run: 0,
        score: null,
      });
      warnings.push(`season-form: ${d.driver} has no 2026 race-by-race rows.`);
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
      score, // 0-100
      sample_quality: races_run >= 8 ? 'ok' : (races_run >= 4 ? 'partial' : 'thin'),
      source_basis: 'Wikipedia 2026 NCS race-results matrix (Gen 7 era; All-Star excluded)',
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
      source_urls: [snap.snapshot_source_url].filter(Boolean),
    }),
    snapshot_id: snap.snapshot_id,
    snapshot_date: snap.snapshot_date,
    era_filter: snap.era_filter,
    all_star_excluded: snap.all_star_excluded === true,
  };
}
