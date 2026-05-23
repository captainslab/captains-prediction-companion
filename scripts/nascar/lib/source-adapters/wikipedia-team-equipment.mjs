// NASCAR team_equipment adapter — Wikipedia 2025 Cup season snapshot.
//
// Read-only, snapshot-first. No live network. CC-BY-SA-4.0 source.
// Source: https://en.wikipedia.org/wiki/2025_NASCAR_Cup_Series
//
// Mapping team-level season aggregates to a per-driver team_equipment_quality
// in [0, 100]. Composite (recommended in Phase-1 recon):
//
//   wins_score        = clamp(season_wins / 11 * 100, 0, 100)   # 11 ~= top team
//   top5_score        = clamp(season_top5 / max(starts,1) / 0.35 * 100, 0, 100)
//   top10_score       = clamp(season_top10 / max(starts,1) / 0.55 * 100, 0, 100)
//   avg_finish_score  = clamp((30 - season_avg_finish) / 20 * 100, 0, 100)
//
//   team_equipment_quality =
//       0.30 * wins_score
//     + 0.25 * top5_score
//     + 0.25 * top10_score
//     + 0.20 * avg_finish_score
//
// Deterministic. No randomness. No hidden lookups.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoNow, makeEnvelope } from '../cache.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_SNAPSHOT = resolve(__dirname, 'snapshots', 'wikipedia-cup-2025.json');
const SOURCE_ID = 'team_equipment_quality';
const LAYER = 'team_equipment';
const STALENESS_DAYS = 90;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function loadSnapshot(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { __error: err.message };
  }
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(b - a) / 86400000;
}

function computeQuality(team) {
  const starts = Math.max(1, Number(team.starts) || 0);
  const winsScore = clamp((Number(team.season_wins) || 0) / 11 * 100, 0, 100);
  const top5Score = clamp(((Number(team.season_top5) || 0) / starts) / 0.35 * 100, 0, 100);
  const top10Score = clamp(((Number(team.season_top10) || 0) / starts) / 0.55 * 100, 0, 100);
  const af = Number(team.season_avg_finish);
  const avgFinishScore = Number.isFinite(af)
    ? clamp((30 - af) / 20 * 100, 0, 100)
    : 0;
  const composite =
      0.30 * winsScore
    + 0.25 * top5Score
    + 0.25 * top10Score
    + 0.20 * avgFinishScore;
  return Math.round(clamp(composite, 0, 100));
}

export function wikipediaTeamEquipmentEnvelope({
  status = null,
  checked_at_utc = isoNow(),
  outputDir = 'state/nascar/_dry-run/fundamentals',
  snapshotPath = DEFAULT_SNAPSHOT,
} = {}) {
  const snap = loadSnapshot(snapshotPath);
  const cache_path = `${outputDir}/${SOURCE_ID}_adapter.json`;
  const source_urls_base = ['https://en.wikipedia.org/wiki/2025_NASCAR_Cup_Series'];

  if (!snap || snap.__error || !Array.isArray(snap.teams)) {
    const env = makeEnvelope({
      source_id: SOURCE_ID,
      status: 'unavailable',
      checked_at_utc,
      cache_path,
      required: false,
      records: [],
      warnings: ['Wikipedia team/equipment snapshot missing or unreadable.'],
      errors: [snap?.__error ?? 'snapshot_unavailable'],
      source_urls: source_urls_base,
    });
    return {
      ...env,
      layer: LAYER,
      source_status: 'unavailable',
      source_notes: ['Wikipedia 2025 Cup snapshot unavailable; no team_equipment ratings emitted.'],
      snapshot_date: null,
      snapshot_license: 'CC-BY-SA-4.0',
      degraded_reasons: [],
      unavailable_reasons: ['wikipedia_snapshot_missing_or_corrupt'],
    };
  }

  const age = daysBetween(snap.snapshot_date, checked_at_utc);
  const fresh = age <= STALENESS_DAYS;
  const resolvedStatus = status ?? (fresh ? 'ok' : 'degraded');

  const records = snap.teams.map(team => ({
    query_type: `fundamentals_${LAYER}`,
    team_name: team.team_name,
    short_code: team.short_code ?? null,
    manufacturer: team.manufacturer ?? null,
    primary_cars: Array.isArray(team.primary_cars) ? team.primary_cars : [],
    starts: team.starts ?? null,
    season_wins: team.season_wins ?? null,
    season_top5: team.season_top5 ?? null,
    season_top10: team.season_top10 ?? null,
    season_avg_finish: team.season_avg_finish ?? null,
    team_equipment_quality: computeQuality(team),
    proxy_year: team.proxy_year ?? null,
  }));

  // Per-driver expansion so the base-fundamentals composer (which keys on
  // car_number) can index team_equipment by driver/car.
  const driverRecords = [];
  for (const t of records) {
    for (const car of t.primary_cars) {
      driverRecords.push({
        query_type: `fundamentals_${LAYER}`,
        driver_name: null,
        car_number: car,
        team: t.team_name,
        manufacturer: t.manufacturer,
        team_equipment_quality: t.team_equipment_quality,
        engine_supplier: null,
        equipment_notes: `team_equipment_quality derived from Wikipedia 2025 Cup season aggregates for ${t.team_name}`,
      });
    }
  }

  const warnings = [];
  const degraded_reasons = [];
  const unavailable_reasons = [];
  const source_notes = [
    `team_equipment_quality derived from Wikipedia 2025 Cup season aggregates (snapshot_date=${snap.snapshot_date}, license=${snap.license}).`,
  ];
  if (!fresh) {
    warnings.push(`Wikipedia snapshot is ${Math.round(age)} days old (>${STALENESS_DAYS}d threshold); marked degraded.`);
    degraded_reasons.push('wikipedia_snapshot_stale_gt_90_days');
  }
  if (records.some(r => r.proxy_year)) {
    warnings.push('One or more teams used 2024 proxy values (proxy_year=2024).');
    if (resolvedStatus === 'ok') degraded_reasons.push('partial_proxy_year_used');
  }

  const env = makeEnvelope({
    source_id: SOURCE_ID,
    status: resolvedStatus,
    checked_at_utc,
    cache_path,
    required: false,
    records: driverRecords,
    warnings,
    errors: [],
    source_urls: source_urls_base,
  });

  return {
    ...env,
    layer: LAYER,
    source_status: resolvedStatus,
    source_notes,
    snapshot_date: snap.snapshot_date,
    snapshot_license: snap.license,
    snapshot_attribution: snap.attribution,
    team_aggregates: records,
    degraded_reasons,
    unavailable_reasons,
  };
}

export default wikipediaTeamEquipmentEnvelope;
