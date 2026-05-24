// IndyCar oval / superspeedway history adapter (2021-2025 aero era; non-IMS).
//
// Source: Wikipedia IndyCar race articles (CC-BY-SA-4.0).
// Snapshot: scripts/indycar/lib/source-adapters/snapshots/indycar-oval-history-2021-2025.json
//
// Includes: Texas, Iowa, Milwaukee, Gateway (World Wide Tech Raceway).
// Excludes: IMS (covered by ims-500-history), road courses, street courses.
// Read-only. No live network. No fabricated finishes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  __dirname, 'snapshots/indycar-oval-history-2021-2025.json',
);
const SOURCE_ID = 'indycar_oval_superspeedway_history';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function finishToScore(avg) {
  if (avg === null || avg === undefined || !Number.isFinite(Number(avg))) return null;
  const a = Number(avg);
  const s = Math.round(((27 - a) / 26) * 100);
  return Math.max(0, Math.min(100, s));
}

export function ovalSuperspeedwayHistoryEnvelope({
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
        query_type: 'oval_superspeedway_history',
        driver_name: d.driver,
        present: false,
        missing_reason: 'no non-IMS IndyCar oval starts in the 2021-2025 window',
        races_run: 0,
        score: null,
      });
      warnings.push(`oval-history: ${d.driver} has 0 non-IMS oval starts (2021-2025).`);
      continue;
    }
    const score = finishToScore(agg.average_finish ?? agg.average_finish_excluding_dns_dnf);
    records.push({
      query_type: 'oval_superspeedway_history',
      driver_name: d.driver,
      present: true,
      races_run,
      wins: Number(agg.wins) || 0,
      top_5s: Number(agg.top_5s) || 0,
      top_10s: Number(agg.top_10s) || 0,
      dnfs: Number(agg.dnfs) || 0,
      average_finish: agg.average_finish ?? null,
      score,
      sample_quality: races_run >= 6 ? 'ok' : (races_run >= 3 ? 'partial' : 'thin'),
      source_basis: 'Wikipedia IndyCar oval race articles 2021-2025 (Texas, Iowa, Milwaukee, Gateway; IMS excluded)',
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
    included_venues: snap.included_venues ?? [],
  };
}
