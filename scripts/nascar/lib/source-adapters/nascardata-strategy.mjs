// NASCAR strategy_risk adapter — nascaR.data community CSV mirror snapshot.
//
// Read-only, snapshot-first. No live network. MIT-licensed source.
// Source: https://github.com/kyleGrealis/nascaR.data
//
// Maps season-aggregate per-driver fields to a per-driver
// strategy_risk_rating in [0, 100]. Higher = safer / more disciplined
// (lower risk). Composite:
//
//   pit_score      = clamp((12.3 - avg_pit_stop_time_sec) / (12.3 - 11.4) * 100, 0, 100)
//   consistency    = clamp((0.80 - pit_stop_std_sec)      / (0.80 - 0.40) * 100, 0, 100)
//   stage_score    = clamp(stage_points_rate * 100, 0, 100)
//   restart_score  = clamp((0.8 - restart_pos_delta) / 1.6 * 100, 0, 100)
//   dnf_score      = clamp((0.18 - dnf_rate) / 0.18 * 100, 0, 100)
//
//   strategy_risk_rating =
//       0.20 * pit_score
//     + 0.20 * consistency
//     + 0.20 * stage_score
//     + 0.15 * restart_score
//     + 0.25 * dnf_score
//
// Deterministic. No randomness.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoNow, makeEnvelope } from '../cache.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_SNAPSHOT = resolve(__dirname, 'snapshots', 'nascardata-strategy-2024.json');
const SOURCE_ID = 'strategy_risk_model';
const LAYER = 'strategy_risk';
const STALENESS_DAYS = 180;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function loadSnapshot(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { return { __error: err.message }; }
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(b - a) / 86400000;
}

function computeRating(d) {
  const pit = clamp((12.3 - Number(d.avg_pit_stop_time_sec)) / (12.3 - 11.4) * 100, 0, 100);
  const cons = clamp((0.80 - Number(d.pit_stop_std_sec)) / (0.80 - 0.40) * 100, 0, 100);
  const stage = clamp(Number(d.stage_points_rate) * 100, 0, 100);
  const restart = clamp((0.8 - Number(d.restart_pos_delta)) / 1.6 * 100, 0, 100);
  const dnf = clamp((0.18 - Number(d.dnf_rate)) / 0.18 * 100, 0, 100);
  const composite = 0.20 * pit + 0.20 * cons + 0.20 * stage + 0.15 * restart + 0.25 * dnf;
  return Math.round(clamp(composite, 0, 100));
}

export function nascardataStrategyRiskEnvelope({
  status = null,
  checked_at_utc = isoNow(),
  outputDir = 'state/nascar/_dry-run/fundamentals',
  snapshotPath = DEFAULT_SNAPSHOT,
} = {}) {
  const snap = loadSnapshot(snapshotPath);
  const cache_path = `${outputDir}/${SOURCE_ID}_adapter.json`;
  const source_urls_base = ['https://github.com/kyleGrealis/nascaR.data'];

  if (!snap || snap.__error || !Array.isArray(snap.drivers)) {
    const env = makeEnvelope({
      source_id: SOURCE_ID,
      status: 'unavailable',
      checked_at_utc,
      cache_path,
      required: false,
      records: [],
      warnings: ['nascaR.data strategy snapshot missing or unreadable.'],
      errors: [snap?.__error ?? 'snapshot_unavailable'],
      source_urls: source_urls_base,
    });
    return {
      ...env,
      layer: LAYER,
      source_status: 'unavailable',
      source_notes: ['nascaR.data 2024 strategy snapshot unavailable; no strategy_risk ratings emitted.'],
      snapshot_date: null,
      snapshot_license: 'MIT',
      degraded_reasons: [],
      unavailable_reasons: ['nascardata_snapshot_missing_or_corrupt'],
    };
  }

  const age = daysBetween(snap.snapshot_date, checked_at_utc);
  const fresh = age <= STALENESS_DAYS;
  // Snapshot is 2024 season aggregates being applied to 2025/26 races —
  // always at least degraded regardless of file age.
  const resolvedStatus = status ?? (fresh ? 'degraded' : 'degraded');

  const records = snap.drivers.map(d => ({
    query_type: `fundamentals_${LAYER}`,
    driver_name: d.driver_name,
    car_number: d.car_number,
    team: d.team ?? null,
    manufacturer: null,
    strategy_risk_rating: computeRating(d),
    fuel_strategy_volatility: null,
    tire_strategy_volatility: null,
    inputs: {
      avg_pit_stop_time_sec: d.avg_pit_stop_time_sec,
      pit_stop_std_sec: d.pit_stop_std_sec,
      stage_points_rate: d.stage_points_rate,
      restart_pos_delta: d.restart_pos_delta,
      dnf_rate: d.dnf_rate,
    },
  }));

  const warnings = [
    `Strategy snapshot is a 2024 season aggregate proxy (license=${snap.license}, snapshot_date=${snap.snapshot_date}); status forced to degraded.`,
  ];
  if (!fresh) warnings.push(`Snapshot age ${Math.round(age)}d exceeds ${STALENESS_DAYS}d threshold.`);

  const env = makeEnvelope({
    source_id: SOURCE_ID,
    status: resolvedStatus,
    checked_at_utc,
    cache_path,
    required: false,
    records,
    warnings,
    errors: [],
    source_urls: source_urls_base,
  });

  return {
    ...env,
    layer: LAYER,
    source_status: resolvedStatus,
    source_notes: [
      `strategy_risk_rating derived from 2024 nascaR.data season aggregates (license=${snap.license}, snapshot_date=${snap.snapshot_date}); applied to 2025/26 races as a degraded proxy.`,
    ],
    snapshot_date: snap.snapshot_date,
    snapshot_license: snap.license,
    snapshot_attribution: snap.attribution,
    degraded_reasons: ['2024_season_proxy_applied_to_current_year'],
    unavailable_reasons: [],
  };
}

export default nascardataStrategyRiskEnvelope;
