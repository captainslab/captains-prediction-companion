// 1.5-mile intermediate OVAL Cup history adapter (Gen 7: 2022-2025).
//
// Tracks included: Charlotte (oval only), Las Vegas, Kansas, Texas, Homestead.
// EXCLUDED: Atlanta (reconfigured 2022 to draft/superspeedway style),
// Charlotte Roval, all road courses, superspeedways, short tracks, and other
// non-1.5-mi intermediates (Darlington 1.366, Pocono 2.5, etc.), All-Star Race.
//
// Read-only. No live network. No fabricated finishes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  __dirname,
  'snapshots',
  'wikipedia-intermediate-15mi-oval-cup-history-2022-2025.json',
);
const SOURCE_ID = 'intermediate_15mi_oval_cup_history';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function finishToScore(avg) {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg))) return null;
  const a = Number(avg);
  const s = Math.round(((35 - a) / 34) * 100);
  return Math.max(0, Math.min(100, s));
}

export function intermediate15miOvalHistoryEnvelope({
  checked_at_utc,
  outputDir = 'state/nascar/_dry-run/fundamentals',
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
        query_type: 'intermediate_15mi_oval_history',
        driver_name: d.driver,
        present: false,
        missing_reason: 'no 1.5-mi-oval Cup starts in Gen 7 window (2022-2025)',
        races_run: 0,
        score: null,
      });
      warnings.push(`intermediate-15mi: ${d.driver} has 0 Gen-7 1.5-mi-oval starts.`);
      continue;
    }
    const score = finishToScore(agg.average_finish_excluding_dns_dnf ?? agg.average_finish_excluding_dnf ?? agg.average_finish);
    records.push({
      query_type: 'intermediate_15mi_oval_history',
      driver_name: d.driver,
      present: true,
      races_run,
      wins: Number(agg.wins) || 0,
      top_5s: Number(agg.top_5s) || 0,
      top_10s: Number(agg.top_10s) || 0,
      dnfs: Number(agg.dnfs) || 0,
      dns: Number(agg.dns) || 0,
      average_finish: agg.average_finish_excluding_dns_dnf ?? agg.average_finish_excluding_dnf ?? agg.average_finish ?? null,
      score, // 0-100
      sample_quality: races_run >= 12 ? 'ok' : (races_run >= 6 ? 'partial' : 'thin'),
      source_basis: 'Wikipedia 1.5-mi-oval Cup race articles 2022-2025 (Atlanta excluded; Roval excluded)',
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
    intermediate_filter_policy: snap.intermediate_filter_policy ?? null,
    included_events_count: Array.isArray(snap.included_events) ? snap.included_events.length : null,
  };
}
