// IMS / Indy 500 history adapter (aero era: 2021-2025).
//
// Source: Wikipedia "Indianapolis 500" race articles (CC-BY-SA-4.0).
// Snapshot: scripts/indycar/lib/source-adapters/snapshots/ims-500-history-2021-2025.json
//
// Covers the five most recent Indy 500s (2021-2025) under the current aero kit era.
// Oval-only (IMS road course is excluded).
// Read-only. No live network. No fabricated finishes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  __dirname, 'snapshots/ims-500-history-2021-2025.json',
);
const SOURCE_ID = 'ims_500_history';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// P1 -> 100, P33 -> 0 (linear for 33-car Indy 500 field).
function finishToScore(avg) {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg))) return null;
  const a = Number(avg);
  const s = Math.round(((33 - a) / 32) * 100);
  return Math.max(0, Math.min(100, s));
}

export function ims500HistoryEnvelope({
  checked_at_utc,
  outputDir = 'state/indycar/2026-05-25/discovery',
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  const snap = loadJson(snapshotPath);
  const records = [];
  const warnings = [];

  for (const d of snap.drivers ?? []) {
    const agg = d.aggregates ?? {};
    const results = Array.isArray(d.results) ? d.results : [];
    const realStarts = results.filter(r => {
      const f = r.finish_position;
      return f !== 'DNS' && f !== null && f !== undefined;
    }).length;
    const races_run = Number(agg.races_run) ?? realStarts;
    if (races_run === 0) {
      records.push({
        query_type: 'ims_500_history',
        driver_name: d.driver,
        present: false,
        missing_reason: 'no Indy 500 starts in the 2021-2025 aero-era window',
        races_run: 0,
        score: null,
      });
      warnings.push(`ims-history: ${d.driver} has 0 Indy 500 starts (2021-2025).`);
      continue;
    }
    const score = finishToScore(agg.average_finish ?? agg.average_finish_excluding_dns_dnf);
    records.push({
      query_type: 'ims_500_history',
      driver_name: d.driver,
      present: true,
      races_run,
      wins: Number(agg.wins) || 0,
      top_5s: Number(agg.top_5s) || 0,
      top_10s: Number(agg.top_10s) || 0,
      dnfs: Number(agg.dnfs) || 0,
      average_finish: agg.average_finish ?? null,
      score,
      sample_quality: races_run >= 4 ? 'ok' : (races_run >= 2 ? 'partial' : 'thin'),
      source_basis: 'Wikipedia Indy 500 race articles 2021-2025 (IMS oval; aero era)',
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
    era_filter: snap.era_filter,
    included_events: snap.included_events ?? [],
  };
}
