// NASCAR fundamentals fixture adapters.
//
// Read-only, fixture-first. No live network. No credentials. No trading.
//
// Surfaces the four base-fundamentals layers the Storyline Modifier gate
// depends on:
//
//   1. Driver skill rating
//   2. Team / equipment quality
//   3. Pit crew / crew chief grade
//   4. Strategy risk rating
//
// Each layer returns a per-driver record plus an envelope-level
// `source_status` (ok | degraded | unavailable) and `source_notes`.
// When a layer is `unavailable` no per-driver numeric ratings are emitted —
// the downstream packet must show DOWNGRADED:UNAVAILABLE rather than fake
// numbers. When `degraded`, neutral placeholder ratings may be emitted but
// the data_quality flag stays low so the storyline gate cannot pass on
// placeholder data alone.

import { isoNow, makeEnvelope } from '../cache.mjs';

export const FUNDAMENTAL_LAYERS = Object.freeze([
  'driver_skill',
  'team_equipment',
  'pit_crew',
  'strategy_risk',
]);

export const LAYER_SOURCE_IDS = Object.freeze({
  driver_skill: 'driver_skill_ratings',
  team_equipment: 'team_equipment_quality',
  pit_crew: 'pit_crew_chief_grades',
  strategy_risk: 'strategy_risk_model',
});

export const LAYER_DEFAULT_SOURCE_URLS = Object.freeze({
  driver_skill: ['https://www.nascar.com/stats/drivers/'],
  team_equipment: ['https://www.nascar.com/stats/teams/'],
  pit_crew: ['https://www.nascar.com/stats/pit-crew/'],
  strategy_risk: ['https://www.nascar.com/stats/race-results/'],
});

const ALLOWED_STATUS = Object.freeze(['ok', 'degraded', 'unavailable']);

function clampRating(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function buildLayerRecord(layer, driverInput) {
  const base = {
    query_type: `fundamentals_${layer}`,
    driver_name: driverInput.driver_name ?? null,
    car_number: driverInput.car_number ?? null,
    team: driverInput.team ?? null,
    manufacturer: driverInput.manufacturer ?? null,
  };
  switch (layer) {
    case 'driver_skill':
      return {
        ...base,
        driver_skill_rating: clampRating(driverInput.driver_skill_rating),
        driver_ability_to_convert: clampRating(driverInput.driver_ability_to_convert),
        skill_notes: driverInput.skill_notes ?? null,
      };
    case 'team_equipment':
      return {
        ...base,
        team_equipment_quality: clampRating(driverInput.team_equipment_quality),
        engine_supplier: driverInput.engine_supplier ?? null,
        equipment_notes: driverInput.equipment_notes ?? null,
      };
    case 'pit_crew':
      return {
        ...base,
        pit_crew_crew_chief_grade: clampRating(driverInput.pit_crew_crew_chief_grade),
        avg_pit_stop_rank: driverInput.avg_pit_stop_rank ?? null,
        crew_chief: driverInput.crew_chief ?? null,
      };
    case 'strategy_risk':
      return {
        ...base,
        // strategy_risk_rating: higher = safer/more disciplined strategy.
        strategy_risk_rating: clampRating(driverInput.strategy_risk_rating),
        fuel_strategy_volatility: driverInput.fuel_strategy_volatility ?? null,
        tire_strategy_volatility: driverInput.tire_strategy_volatility ?? null,
      };
    default:
      throw new Error(`Unknown fundamentals layer: ${layer}`);
  }
}

// Fixture roster used for the Coca-Cola 600 dry-run. Three drivers,
// neutral but non-fabricated; each rating below 60 so gates do not
// accidentally trip from fixture data alone.
const COCA_COLA_600_ROSTER = [
  {
    driver_name: 'Placeholder Driver A',
    car_number: 1,
    team: 'RCR',
    manufacturer: 'Chevrolet',
    driver_skill_rating: 55,
    driver_ability_to_convert: 50,
    team_equipment_quality: 55,
    engine_supplier: 'ECR',
    pit_crew_crew_chief_grade: 50,
    avg_pit_stop_rank: 18,
    crew_chief: 'fixture-mode placeholder',
    strategy_risk_rating: 50,
    fuel_strategy_volatility: 'unknown',
    tire_strategy_volatility: 'unknown',
    skill_notes: 'fixture-mode placeholder rating; replace with sourced packet before publication.',
    equipment_notes: 'fixture-mode placeholder; not a real team grade.',
  },
  {
    driver_name: 'Placeholder Driver B',
    car_number: 8,
    team: 'RCR',
    manufacturer: 'Chevrolet',
    driver_skill_rating: 50,
    driver_ability_to_convert: 45,
    team_equipment_quality: 55,
    engine_supplier: 'ECR',
    pit_crew_crew_chief_grade: 50,
    avg_pit_stop_rank: 20,
    crew_chief: 'fixture-mode placeholder',
    strategy_risk_rating: 45,
    fuel_strategy_volatility: 'unknown',
    tire_strategy_volatility: 'unknown',
    skill_notes: 'fixture-mode placeholder rating; replace with sourced packet before publication.',
    equipment_notes: 'fixture-mode placeholder; not a real team grade.',
  },
  {
    driver_name: 'Placeholder Driver C',
    car_number: 99,
    team: 'Trackhouse',
    manufacturer: 'Chevrolet',
    driver_skill_rating: 48,
    driver_ability_to_convert: 45,
    team_equipment_quality: 50,
    engine_supplier: 'ECR',
    pit_crew_crew_chief_grade: 48,
    avg_pit_stop_rank: 22,
    crew_chief: 'fixture-mode placeholder',
    strategy_risk_rating: 45,
    fuel_strategy_volatility: 'unknown',
    tire_strategy_volatility: 'unknown',
    skill_notes: 'fixture-mode placeholder rating; replace with sourced packet before publication.',
    equipment_notes: 'fixture-mode placeholder; not a real team grade.',
  },
];

export function fixtureFundamentalsEnvelope({
  layer,
  status = 'degraded',
  checked_at_utc = '2026-05-25T18:00:00.000Z',
  outputDir = 'state/nascar/_dry-run/fundamentals',
  drivers = null,
} = {}) {
  if (!FUNDAMENTAL_LAYERS.includes(layer)) {
    throw new Error(`fixtureFundamentalsEnvelope: unknown layer "${layer}"`);
  }
  if (!ALLOWED_STATUS.includes(status)) {
    throw new Error(`fixtureFundamentalsEnvelope: invalid status "${status}"`);
  }

  const roster = Array.isArray(drivers) ? drivers : COCA_COLA_600_ROSTER;

  let records = [];
  const warnings = ['Fixture mode: no live fundamentals source was called.'];
  const errors = [];
  let source_notes = [
    `Layer "${layer}" surfaced via fixture adapter; ratings are placeholders unless explicitly sourced.`,
  ];

  if (status === 'ok') {
    records = roster.map(driver => buildLayerRecord(layer, driver));
  } else if (status === 'degraded') {
    // Emit per-driver records but keep ratings neutral / placeholder-tagged.
    records = roster.map(driver => buildLayerRecord(layer, driver));
    warnings.push(
      `${layer} source returned degraded data: ratings are neutral placeholders; gates must not pass on placeholder data alone.`,
    );
    source_notes.push(
      `${layer} layer DEGRADED — driver ratings present but flagged unknown_downgrade_placeholder.`,
    );
  } else if (status === 'unavailable') {
    records = [];
    errors.push(`${layer} source unavailable: no records emitted.`);
    source_notes.push(`${layer} layer UNAVAILABLE — packet must show DOWNGRADED:UNAVAILABLE for this layer.`);
  }

  const envelope = makeEnvelope({
    source_id: LAYER_SOURCE_IDS[layer],
    status,
    checked_at_utc,
    cache_path: `${outputDir}/${LAYER_SOURCE_IDS[layer]}_adapter.json`,
    required: false,
    records,
    warnings,
    errors,
    source_urls: [...LAYER_DEFAULT_SOURCE_URLS[layer]],
  });

  return {
    ...envelope,
    layer,
    source_status: status,
    source_notes,
    degraded_reasons: status === 'degraded'
      ? [`${layer}_source_returned_placeholder_only`, 'no_real_rating_published_yet']
      : [],
    unavailable_reasons: status === 'unavailable'
      ? [`${layer}_source_not_available_at_packet_time`]
      : [],
  };
}

export async function fetchFundamentalsLayerReadonly({
  layer,
  status = 'degraded',
  outputDir = 'state/nascar/_dry-run/fundamentals',
  fixturesOnly = true,
  now = new Date(),
  drivers = null,
} = {}) {
  const checked_at_utc = isoNow(now);
  if (fixturesOnly) {
    return fixtureFundamentalsEnvelope({ layer, status, checked_at_utc, outputDir, drivers });
  }
  // Live mode is intentionally not implemented — surface as unavailable.
  return fixtureFundamentalsEnvelope({
    layer,
    status: 'unavailable',
    checked_at_utc,
    outputDir,
  });
}
