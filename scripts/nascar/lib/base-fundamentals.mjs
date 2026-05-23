// NASCAR base fundamentals composer.
//
// Normalizes the 4 fundamentals layers (driver skill, team/equipment,
// pit crew/crew chief, strategy risk) into a single per-driver object
// and an overall data-quality summary used by the Storyline Modifier
// gate. Pure ESM. No I/O. No live network.
//
// Output per driver:
//   {
//     driver_name, car_number, team, manufacturer,
//     driver_skill_rating, driver_ability_to_convert,
//     team_equipment_quality, pit_crew_crew_chief_grade,
//     strategy_risk_rating,
//     layer_status: { driver_skill, team_equipment, pit_crew, strategy_risk },
//     data_quality: 'ok' | 'partial' | 'degraded' | 'unavailable',
//     downgrade_reasons: string[],
//   }
//
// Output summary:
//   {
//     by_driver: [...records],
//     layer_status, layer_source_notes,
//     overall_data_quality, allowed_max_posture,
//     downgrade_reasons,
//   }

import { FUNDAMENTAL_LAYERS } from './source-adapters/fundamentals-fixture.mjs';

const NUMERIC_FIELDS = Object.freeze({
  driver_skill: ['driver_skill_rating', 'driver_ability_to_convert'],
  team_equipment: ['team_equipment_quality'],
  pit_crew: ['pit_crew_crew_chief_grade'],
  strategy_risk: ['strategy_risk_rating'],
});

function driverKey(record) {
  if (!record) return null;
  if (record.car_number !== null && record.car_number !== undefined) {
    return `car-${record.car_number}`;
  }
  return record.driver_name ? `name-${record.driver_name.toLowerCase()}` : null;
}

function indexLayer(envelope) {
  const out = new Map();
  if (!envelope || !Array.isArray(envelope.records)) return out;
  for (const rec of envelope.records) {
    const k = driverKey(rec);
    if (k) out.set(k, rec);
  }
  return out;
}

function pickNum(rec, field) {
  if (!rec) return null;
  const v = rec[field];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function layerStatusOf(envelope) {
  if (!envelope) return 'unavailable';
  return envelope.source_status ?? envelope.status ?? 'unavailable';
}

// Layer criticality: pit_crew is low-weight, non-critical (no clean public
// source exists). The other three layers are critical because they directly
// feed the composite ceiling score and the storyline gate.
//   - driver_skill:    critical (derived/degraded counts as "present")
//   - team_equipment:  critical (Wikipedia season snapshot is OK)
//   - strategy_risk:   critical (nascaR.data proxy counts as "present")
//   - pit_crew:        non-critical (unavailable does NOT force degraded)
const CRITICAL_LAYERS = Object.freeze(['driver_skill', 'team_equipment', 'strategy_risk']);
const NON_CRITICAL_LAYERS = Object.freeze(['pit_crew']);

function resolveDataQuality(layerStatus) {
  const critStatuses = CRITICAL_LAYERS.map(l => layerStatus[l] ?? 'unavailable');
  const nonCritStatuses = NON_CRITICAL_LAYERS.map(l => layerStatus[l] ?? 'unavailable');
  // Hard floor: if every layer is unavailable, overall is unavailable.
  if ([...critStatuses, ...nonCritStatuses].every(s => s === 'unavailable')) return 'unavailable';
  // Any critical layer unavailable -> degraded (the board must cap at WATCH).
  if (critStatuses.some(s => s === 'unavailable')) return 'degraded';
  // All critical layers OK and all non-critical OK -> fully ok.
  if (critStatuses.every(s => s === 'ok') && nonCritStatuses.every(s => s === 'ok')) return 'ok';
  // All critical layers at least "present" (ok or degraded); non-critical
  // may be unavailable/degraded -> partial. This unblocks LEAN/EVIDENCE_LEAN
  // when pit_crew is the only missing layer or when derived/proxy sources
  // surface critical layers as 'degraded'.
  return 'partial';
}

// Storyline gates require equipment_quality >= 60 AND driver_ability >= 55
// AND storyline_score >= 60. If fundamentals are anything less than 'ok'
// the packet must cap posture at WATCH (storyline modifier remains 0).
function allowedMaxPosture(overallDataQuality) {
  if (overallDataQuality === 'ok') return 'PICK';
  if (overallDataQuality === 'partial') return 'EVIDENCE_LEAN';
  if (overallDataQuality === 'degraded') return 'WATCH';
  return 'NO_CLEAR_PICK';
}

export function composeBaseFundamentals({ envelopes } = {}) {
  if (!envelopes || typeof envelopes !== 'object') {
    throw new Error('composeBaseFundamentals requires { envelopes }');
  }

  const layerStatus = {};
  const layerSourceNotes = {};
  const layerSourceUrls = {};
  const indexed = {};
  for (const layer of FUNDAMENTAL_LAYERS) {
    const env = envelopes[layer];
    layerStatus[layer] = layerStatusOf(env);
    layerSourceNotes[layer] = env?.source_notes ?? [];
    layerSourceUrls[layer] = Array.isArray(env?.source_urls) ? env.source_urls : [];
    indexed[layer] = indexLayer(env);
  }

  // Build union of driver keys present across layers.
  const allKeys = new Set();
  for (const layer of FUNDAMENTAL_LAYERS) {
    for (const k of indexed[layer].keys()) allKeys.add(k);
  }

  const by_driver = [];
  for (const k of allKeys) {
    const skill = indexed.driver_skill.get(k);
    const equip = indexed.team_equipment.get(k);
    const pit = indexed.pit_crew.get(k);
    const strat = indexed.strategy_risk.get(k);
    const anchor = skill ?? equip ?? pit ?? strat;
    const driverDowngrade = [];
    for (const layer of FUNDAMENTAL_LAYERS) {
      if (!indexed[layer].get(k)) {
        driverDowngrade.push(`${layer}_missing_for_driver`);
      } else if (layerStatus[layer] === 'degraded') {
        driverDowngrade.push(`${layer}_degraded_source`);
      } else if (layerStatus[layer] === 'unavailable') {
        driverDowngrade.push(`${layer}_unavailable`);
      }
    }
    const driverDataQuality = driverDowngrade.length === 0
      ? 'ok'
      : driverDowngrade.some(r => r.endsWith('_unavailable')) ? 'degraded' : 'partial';

    by_driver.push({
      driver_name: anchor?.driver_name ?? null,
      car_number: anchor?.car_number ?? null,
      team: anchor?.team ?? null,
      manufacturer: anchor?.manufacturer ?? null,
      driver_skill_rating: pickNum(skill, 'driver_skill_rating'),
      driver_ability_to_convert: pickNum(skill, 'driver_ability_to_convert'),
      team_equipment_quality: pickNum(equip, 'team_equipment_quality'),
      pit_crew_crew_chief_grade: pickNum(pit, 'pit_crew_crew_chief_grade'),
      strategy_risk_rating: pickNum(strat, 'strategy_risk_rating'),
      layer_status: { ...layerStatus },
      data_quality: driverDataQuality,
      downgrade_reasons: driverDowngrade,
    });
  }

  const overall_data_quality = resolveDataQuality(layerStatus);
  const downgrade_reasons = [];
  for (const layer of FUNDAMENTAL_LAYERS) {
    if (layerStatus[layer] !== 'ok') {
      downgrade_reasons.push(`${layer}_${layerStatus[layer]}`);
    }
  }

  return {
    schema_version: 'nascar_base_fundamentals_v1',
    by_driver,
    layer_status: layerStatus,
    layer_source_notes: layerSourceNotes,
    layer_source_urls: layerSourceUrls,
    overall_data_quality,
    allowed_max_posture: allowedMaxPosture(overall_data_quality),
    downgrade_reasons,
    safety_notes: [
      'Fundamentals composer is fixture-mode aware; placeholder ratings must NOT trip storyline gates.',
      'No price, volume, OI, or line-movement field is considered here.',
    ],
  };
}

// Convenience: given a normalized by_driver entry, return the
// fundamentals shape expected by composeStorylineModifier.
export function fundamentalsForStoryline(driverEntry) {
  if (!driverEntry) {
    return {
      driver_name: null,
      car_number: null,
      equipment_quality: 0,
      driver_ability_to_convert: 0,
      base_win_probability: 0,
      overpricing_penalty: 0,
    };
  }
  // When fundamentals are anything less than fully ok, force the gate
  // inputs to neutral midline values so the storyline modifier cannot
  // turn placeholder data into a positive true_win_modifier.
  const ok = driverEntry.data_quality === 'ok';
  return {
    driver_name: driverEntry.driver_name,
    car_number: driverEntry.car_number,
    equipment_quality: ok ? (driverEntry.team_equipment_quality ?? 0) : Math.min(driverEntry.team_equipment_quality ?? 0, 55),
    driver_ability_to_convert: ok ? (driverEntry.driver_ability_to_convert ?? 0) : Math.min(driverEntry.driver_ability_to_convert ?? 0, 50),
    base_win_probability: 0,
    overpricing_penalty: 0,
  };
}
