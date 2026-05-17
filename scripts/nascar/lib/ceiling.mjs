// NASCAR Stage 4 ceiling composer.
// Fixture-first dry-run only. No runtime integration, credentials, picks,
// fair values, sizing, or trades.
//
// Input: Stage 3 discovery object (composeRaceDiscovery output).
// Output: research board with exactly one ceiling_market per active candidate.
//
// IMPORTANT RULES (mirrored from runbooks/nascar-implementation-plan.md):
//   - Each active candidate driver is compressed to ONE best ceiling label.
//   - Allowed ceiling_market values: win, top3, top5, top10, top20,
//     fastest_lap, pass.
//   - fastest_lap is a SPECIAL PROP lane, not a finish-position ceiling.
//   - top20 ceiling lane is the Kalshi finish-position market lane, NOT the
//     "top 20 in current points" candidate-pool filter.
//   - FIELD / longshot bucket is summarized only; never priced driver-by-driver.
//   - special_event_override metadata flows through unchanged.
//   - No trade, order, stake, pick, recommendation, fair_value, edge, kelly,
//     or execution fields may be emitted.

export const ALLOWED_CEILING_MARKETS = Object.freeze([
  'win',
  'top3',
  'top5',
  'top10',
  'top20',
  'fastest_lap',
  'pass',
]);

export const FORBIDDEN_CEILING_FIELDS = Object.freeze([
  'trade',
  'order',
  'stake',
  'pick',
  'recommendation',
  'fair_value',
  'edge',
  'kelly',
  'execution',
]);

const CEILING_LABELS = Object.freeze({
  win: 'Win',
  top3: 'Top 3',
  top5: 'Top 5',
  top10: 'Top 10',
  top20: 'Top 20',
  fastest_lap: 'Fastest Lap',
  pass: 'Pass',
});

function laneTypeFor(market) {
  if (market === 'fastest_lap') return 'special_prop';
  if (market === 'pass') return 'none';
  return 'finish_position';
}

function num(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

// Lower score == stronger ceiling.
function ceilingScore(driver) {
  const sp = num(driver.starting_position, 30);
  const pr = num(driver.practice_rank, 30);
  const ml = num(driver.multi_lap_rank, 30);
  const cp = num(driver.current_points_rank, 30);
  return (sp + pr + ml + cp / 2) / 3.5;
}

function pickCeilingMarket(driver) {
  const score = ceilingScore(driver);
  if (score <= 3) return 'win';
  if (score <= 6) return 'top3';
  if (score <= 10) return 'top5';
  if (score <= 15) return 'top10';
  if (score <= 22) return 'top20';
  return 'pass';
}

function basisFor(driver, market) {
  if (market === 'top20') {
    return 'Finish-position top 20 ceiling derived from starting position, practice speed, and multi-lap pace; this is the Kalshi market lane and is separate from the candidate-pool eligibility rule.';
  }
  if (market === 'pass') {
    return 'No ceiling assigned. Signals across starting position, practice rank, and multi-lap pace are not strong enough to push a ceiling label.';
  }
  if (market === 'fastest_lap') {
    return 'Special prop lane callout. Not a finish-position ceiling.';
  }
  return `Composite of starting position ${driver.starting_position}, practice rank ${driver.practice_rank}, and multi-lap rank ${driver.multi_lap_rank}.`;
}

function assertNoForbidden(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, [...path, String(idx)]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_CEILING_FIELDS.includes(key)) {
          throw new Error(`Ceiling board contains forbidden field ${[...path, key].join('.')}`);
        }
        walk(child, [...path, key]);
      }
    }
  };
  walk(value);
}

export function composeCeilingBoard({ discovery } = {}) {
  if (!discovery || typeof discovery !== 'object') {
    throw new Error('composeCeilingBoard requires a Stage 3 discovery object');
  }

  const active = Array.isArray(discovery.active_candidate_pool)
    ? discovery.active_candidate_pool
    : [];

  const seen = new Set();
  const ceilings = active.map(driver => {
    if (seen.has(driver.driver_id)) {
      throw new Error(`Duplicate active candidate driver_id ${driver.driver_id}`);
    }
    seen.add(driver.driver_id);
    const market = pickCeilingMarket(driver);
    if (!ALLOWED_CEILING_MARKETS.includes(market)) {
      throw new Error(`Composer produced disallowed ceiling_market ${market} for ${driver.driver_id}`);
    }
    return {
      driver_id: driver.driver_id,
      driver_name: driver.driver_name,
      car_number: driver.car_number,
      ceiling_market: market,
      ceiling_label: CEILING_LABELS[market],
      lane_type: laneTypeFor(market),
      basis: basisFor(driver, market),
      pool_entry_reason: driver.pool_entry_reason,
      override_reasons: Array.isArray(driver.override_reasons) ? driver.override_reasons : [],
    };
  });

  const user_facing_lines = ceilings.map(entry => `${entry.driver_name} ${entry.ceiling_label}`);

  const board = {
    schema_version: 'nascar_ceiling_board_v1',
    mode: 'fixtures-only',
    run_date: discovery.run_date ?? null,
    checked_at_utc: discovery.checked_at_utc ?? null,
    event_context: discovery.event_context ?? null,
    pool_rules: discovery.pool_rules ?? null,
    supported_market_lanes: discovery.supported_market_lanes ?? [],
    special_event_override: discovery.special_event_override ?? null,
    ceilings,
    field_bucket: discovery.field_bucket ?? null,
    user_facing_lines,
    safety_notes: [
      'Research board only. Ceiling labels are not picks or recommendations.',
      'No fair value, sizing, or execution fields are emitted.',
      'No trades placed by this workflow.',
    ],
  };

  assertNoForbidden(board);
  return board;
}
