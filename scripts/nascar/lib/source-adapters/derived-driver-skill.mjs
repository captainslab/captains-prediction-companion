// NASCAR driver_skill adapter — derived-degraded.
//
// Read-only. No live network. Surfaces driver_skill_rating and
// driver_ability_to_convert in [0, 100] derived from the nascaR.data
// strategy snapshot (stage_points_rate, restart_pos_delta, dnf_rate)
// blended with the Wikipedia team_equipment_quality.
//
// This is a DEGRADED proxy. Live sources (DriverAverages, Racing-Reference,
// nascar.com/stats) returned 403/blocked under the simple-curl recon and
// are not used. When the underlying snapshots are missing, this adapter
// returns status='unavailable' and emits zero records.

import { isoNow, makeEnvelope } from '../cache.mjs';
import { nascardataStrategyRiskEnvelope } from './nascardata-strategy.mjs';
import { wikipediaTeamEquipmentEnvelope } from './wikipedia-team-equipment.mjs';

const SOURCE_ID = 'driver_skill_ratings';
const LAYER = 'driver_skill';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function carKey(n) { return Number.isFinite(Number(n)) ? `car-${Number(n)}` : null; }

export function derivedDriverSkillEnvelope({
  checked_at_utc = isoNow(),
  outputDir = 'state/nascar/_dry-run/fundamentals',
  strategyEnvelope = null,
  teamEnvelope = null,
} = {}) {
  const strat = strategyEnvelope ?? nascardataStrategyRiskEnvelope({ checked_at_utc, outputDir });
  const team = teamEnvelope ?? wikipediaTeamEquipmentEnvelope({ checked_at_utc, outputDir });

  const cache_path = `${outputDir}/${SOURCE_ID}_adapter.json`;
  const source_urls = [
    'https://github.com/kyleGrealis/nascaR.data',
    'https://en.wikipedia.org/wiki/2025_NASCAR_Cup_Series',
  ];

  if (
    !Array.isArray(strat.records) || strat.records.length === 0 ||
    strat.source_status === 'unavailable'
  ) {
    const env = makeEnvelope({
      source_id: SOURCE_ID,
      status: 'unavailable',
      checked_at_utc,
      cache_path,
      required: false,
      records: [],
      warnings: ['Underlying strategy snapshot unavailable; driver_skill cannot be derived.'],
      errors: ['strategy_snapshot_unavailable'],
      source_urls,
    });
    return {
      ...env,
      layer: LAYER,
      source_status: 'unavailable',
      source_notes: ['driver_skill UNAVAILABLE — required strategy snapshot missing.'],
      degraded_reasons: [],
      unavailable_reasons: ['strategy_snapshot_unavailable_for_skill_derivation'],
    };
  }

  // Index team_equipment by car number for blend.
  const teamByCar = new Map();
  if (Array.isArray(team.records)) {
    for (const t of team.records) {
      const k = carKey(t.car_number);
      if (k) teamByCar.set(k, t);
    }
  }

  const records = strat.records.map(s => {
    const stage = clamp(Number(s.inputs?.stage_points_rate ?? 0) * 100, 0, 100);
    const restart = clamp((0.8 - Number(s.inputs?.restart_pos_delta ?? 0)) / 1.6 * 100, 0, 100);
    const dnf = clamp((0.18 - Number(s.inputs?.dnf_rate ?? 0.18)) / 0.18 * 100, 0, 100);
    // Skill core: weights driver decision/finish proxies, not pit-stop time.
    const skillCore = 0.55 * stage + 0.20 * restart + 0.25 * dnf;
    const k = carKey(s.car_number);
    const teamRec = k ? teamByCar.get(k) : null;
    const teamQ = Number.isFinite(Number(teamRec?.team_equipment_quality))
      ? Number(teamRec.team_equipment_quality)
      : 50;
    // 70% strategy-derived behavior, 30% team context (since driver and equipment
    // are correlated in NASCAR — but cap the team contribution at 30% so a slow
    // driver in a fast car doesn't get a free skill bump).
    const composite = Math.round(clamp(0.70 * skillCore + 0.30 * teamQ, 0, 100));
    // "Ability to convert" tilts toward stage points + low DNF (closes races).
    const convert = Math.round(clamp(0.60 * stage + 0.40 * dnf, 0, 100));
    return {
      query_type: `fundamentals_${LAYER}`,
      driver_name: s.driver_name,
      car_number: s.car_number,
      team: s.team ?? null,
      manufacturer: teamRec?.manufacturer ?? null,
      driver_skill_rating: composite,
      driver_ability_to_convert: convert,
      skill_notes: 'derived from nascaR.data 2024 stage/restart/dnf rates blended with Wikipedia team aggregates (DEGRADED proxy).',
    };
  });

  const warnings = [
    'driver_skill is a DEGRADED derived proxy: live NASCAR/Racing-Reference/DriverAverages sources returned 403 under simple curl and are not called.',
  ];
  const env = makeEnvelope({
    source_id: SOURCE_ID,
    status: 'degraded',
    checked_at_utc,
    cache_path,
    required: false,
    records,
    warnings,
    errors: [],
    source_urls,
  });

  return {
    ...env,
    layer: LAYER,
    source_status: 'degraded',
    source_notes: [
      'driver_skill_rating = 0.70 * (0.55 stage + 0.20 restart + 0.25 dnf) + 0.30 * team_equipment_quality (DEGRADED).',
      'driver_ability_to_convert = 0.60 stage + 0.40 dnf (DEGRADED).',
      'Live driver-skill sources are blocked by anti-bot under this profile; values are proxies only.',
    ],
    degraded_reasons: [
      'live_driver_skill_sources_blocked_by_anti_bot',
      'derived_from_2024_strategy_aggregates_and_2025_team_aggregates',
    ],
    unavailable_reasons: [],
  };
}

export default derivedDriverSkillEnvelope;
