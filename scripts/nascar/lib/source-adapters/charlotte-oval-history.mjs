// Charlotte Motor Speedway OVAL-only Cup history adapter (Gen 7: 2022-2025).
//
// Snapshot includes exactly the four Coca-Cola 600s (2022, 2023, 2024, 2025).
// Bank of America Roval 400 (road course) and the All-Star Race (not held at
// Charlotte oval in Gen 7) are EXPLICITLY EXCLUDED.
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
  'wikipedia-charlotte-oval-cup-history-2022-2025.json',
);
const SOURCE_ID = 'charlotte_oval_cup_history';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function finishToScore(avg) {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg))) return null;
  const a = Number(avg);
  const s = Math.round(((35 - a) / 34) * 100);
  return Math.max(0, Math.min(100, s));
}

export function charlotteOvalHistoryEnvelope({
  checked_at_utc,
  outputDir = 'state/nascar/_dry-run/fundamentals',
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  const snap = loadJson(snapshotPath);
  const records = [];
  const warnings = [];

  for (const d of snap.drivers ?? []) {
    const agg = d.aggregates ?? {};
    // races_run = number of result rows that are an actual finish (not DNS).
    const results = Array.isArray(d.results) ? d.results : [];
    const realStarts = results.filter(r => {
      const f = r.finish_position;
      return f !== 'DNS' && f !== null && f !== undefined;
    }).length;
    const races_run = Number(agg.races_run) ?? realStarts;
    if (races_run === 0) {
      records.push({
        query_type: 'charlotte_oval_history',
        driver_name: d.driver,
        present: false,
        missing_reason: 'no Charlotte OVAL Cup starts in Gen 7 window (2022-2025 Coca-Cola 600s)',
        races_run: 0,
        score: null,
      });
      warnings.push(`charlotte-oval: ${d.driver} has 0 Gen-7 Charlotte oval starts.`);
      continue;
    }
    const score = finishToScore(agg.average_finish_excluding_dns_dnf ?? agg.average_finish);
    records.push({
      query_type: 'charlotte_oval_history',
      driver_name: d.driver,
      present: true,
      races_run,
      wins: Number(agg.wins) || 0,
      top_5s: Number(agg.top_5s) || 0,
      top_10s: Number(agg.top_10s) || 0,
      dnfs: agg.dnfs ?? null,
      dns: Number(agg.dns) || 0,
      average_finish: agg.average_finish_excluding_dns_dnf ?? agg.average_finish ?? null,
      score, // 0-100
      sample_quality: races_run >= 3 ? 'ok' : (races_run >= 2 ? 'partial' : 'thin'),
      source_basis: 'Wikipedia Coca-Cola 600 race articles 2022-2025 (Charlotte oval; Roval excluded)',
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
    oval_filter_policy: snap.oval_filter_policy ?? null,
    included_events: snap.included_events ?? [],
  };
}
