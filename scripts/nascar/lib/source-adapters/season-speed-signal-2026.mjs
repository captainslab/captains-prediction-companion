// 2026 Cup Series season SPEED SIGNAL adapter.
//
// Reads a Wikipedia-sourced snapshot of two season-aggregate fields (pre-Coca-Cola 600):
//   - stage_points          (sum of stage points scored through race 12)
//   - most_laps_led_races   (count of races in 1..12 where the driver was the "*" holder)
//
// Source: https://en.wikipedia.org/wiki/2026_NASCAR_Cup_Series
//   - "Stages" column on the Drivers' championship standings table
//   - "*" marker per legend: "Most laps led" (single marker per race cell)
//
// Why this layer: stage points + leading laps are the strongest public proxy for
// in-race SPEED, independent of finish-position luck. Pure finish-only metrics
// (already captured in season_form_2026) understate dominators who got wrecked
// and overstate finish-vultures.
//
// Era filter: 2026 only — Gen-7 trivially satisfied. All-Star excluded (non-points).
//
// Read-only. No live network. Missing drivers surfaced (present=false), never invented.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { makeEnvelope } from '../cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  __dirname,
  'snapshots',
  'wikipedia-cup-2026-season-speed-signal-pre-coca-cola-600.json',
);
const SOURCE_ID = 'cup_season_speed_signal_2026';

function loadJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

// Score: stage_points (~0..100 in practice) + 3 pts per "most-laps-led" race,
// clamped 0..100. This rewards dominators (Reddick, Hamlin, Larson) without
// letting the marker bonus dominate the actual stage-points number.
function speedScore(stagePoints, mostLapsLedRaces) {
  if (stagePoints === null || stagePoints === undefined || !Number.isFinite(Number(stagePoints))) return null;
  const sp = Math.max(0, Number(stagePoints));
  const mll = Math.max(0, Number(mostLapsLedRaces) || 0);
  return Math.max(0, Math.min(100, Math.round(sp + mll * 3)));
}

export function seasonSpeedSignal2026Envelope({
  checked_at_utc,
  outputDir = 'state/nascar/_dry-run/fundamentals',
  snapshotPath = SNAPSHOT_PATH,
} = {}) {
  const snap = loadJson(snapshotPath);
  const records = [];
  const warnings = [];

  for (const d of snap.drivers ?? []) {
    const sp = d.stage_points;
    const mll = d.most_laps_led_races;
    const races = Number(d.races_counted) || 0;
    if (sp === null || sp === undefined) {
      records.push({
        query_type: 'season_speed_signal_2026',
        driver_name: d.driver_name,
        present: false,
        missing_reason: 'no stage_points value in 2026 speed-signal snapshot for this driver',
        stage_points: null,
        most_laps_led_races: null,
        races_counted: races,
        score: null,
      });
      warnings.push(`season-speed-signal: ${d.driver_name} missing stage_points.`);
      continue;
    }
    const score = speedScore(sp, mll);
    records.push({
      query_type: 'season_speed_signal_2026',
      driver_name: d.driver_name,
      present: true,
      stage_points: Number(sp),
      most_laps_led_races: Number(mll) || 0,
      races_counted: races,
      score,
      sample_quality: races >= 10 ? 'ok' : (races >= 6 ? 'partial' : 'thin'),
      source_basis: 'Wikipedia 2026 NCS — season stage points + "most laps led" race count (Gen 7; All-Star excluded)',
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
      source_urls: [snap.snapshot_url].filter(Boolean),
    }),
    snapshot_id: snap.snapshot_id,
    snapshot_date: snap.snapshot_date,
    era_filter: snap.era_filter,
    all_star_excluded: snap.all_star_excluded === true,
  };
}
