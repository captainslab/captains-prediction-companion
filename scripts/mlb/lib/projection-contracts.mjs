// MLB projection contracts — the market-FREE foundation layer.
//
// Source architecture: docs/Optimal MLB Projection Architecture for CPC.pdf
// (mirrored in docs/MLB_PROJECTION_IMPLEMENTATION_PLAN.md).
//
// This module defines the canonical OUTPUT CONTRACT every CPC baseball model
// family conforms to. It does NOT compute projections — it normalizes, gates,
// and price-guards model outputs into one coherent, auditable shape:
//
//   - one shared score-distribution contract powers ML / spread / total
//   - specialized but feature-compatible contracts for YRFI/NRFI, Ks, HR
//
// Cardinal invariants (verbatim from the architecture doc):
//   1. No market prices in model features or labels.
//   2. Use as-of timestamps for every input snapshot.
//   3. Treat missing lineups/starters/weather as first-class uncertainty signals.
//   4. Block, rather than hallucinate, when required evidence is absent.
//
// Price isolation is enforced two ways (defence in depth):
//   - builders read ONLY explicitly whitelisted, non-price input fields, so a
//     static grep proves no price field name is ever read here; and
//   - assertNoPriceFields() throws if any price/board-shape key is smuggled
//     into the inputs, outputs, uncertainty, or explanation a caller passes.
//
// Market prices, odds, liquidity, and board shape are allowed ONLY downstream
// as offline EV / closing-line context — never as inputs to these contracts.
//
// Pure ESM. No I/O. No live network. No fabricated values.

export const SCORE_ENGINE_SCHEMA = 'mlb_score_engine_projection_v1';
export const YRFI_SCHEMA         = 'mlb_yrfi_projection_v1';
export const KS_SCHEMA           = 'mlb_pitcher_ks_projection_v1';
export const HR_SCHEMA           = 'mlb_batter_hr_projection_v1';

// official    → all required inputs confirmed; projection is publishable.
// provisional → refreshable but key inputs (lineup/weather) not yet confirmed;
//               projection carries an explicit uncertainty penalty.
// blocked     → a required input is missing; NO projection is issued (outputs null).
export const PROJECTION_STATUSES = Object.freeze(['official', 'provisional', 'blocked']);

// Standard regulatory language reused across every contract.
export const NO_TRADE_NOTE =
  'Projection only — no trade, order, stake, or bankroll action implied.';

const SAFETY_NOTES = Object.freeze([
  NO_TRADE_NOTE,
  'No market price, odds, bid, ask, open interest, volume, or board shape entered these features.',
  'Missing lineups, starters, or weather surface as blocked or provisional status, never as fabricated outputs.',
  'Market lines may only be attached downstream as display / offline-EV context.',
]);

// ---------------------------------------------------------------------------
// Price-isolation guard
// ---------------------------------------------------------------------------

// Exact JSON keys (lowercased) that must never appear in model inputs/outputs.
export const FORBIDDEN_PRICE_KEYS = Object.freeze([
  'price', 'odds', 'bid', 'ask', 'vig', 'edge', 'kelly', 'stake',
  'oi', 'open_interest', 'volume', 'liquidity',
  'yes_ask', 'no_ask', 'yes_bid', 'no_bid',
  'kalshi_ask', 'kalshi_bid', 'moneyline_odds',
  'implied_prob', 'market_prob', 'fair_value',
  'line_movement', 'price_movement', 'board_shape', 'spread_shape',
]);

// Substrings that are unambiguously price/market even inside a compound key.
const FORBIDDEN_SUBSTRINGS = Object.freeze([
  'kalshi', 'implied_prob', 'market_prob', 'fair_value',
  'moneyline_odds', 'open_interest', 'price_movement', 'line_movement',
  'board_shape', 'spread_shape',
]);

const FORBIDDEN_SET = new Set(FORBIDDEN_PRICE_KEYS);

function keyIsPrice(key) {
  const lc = String(key).toLowerCase();
  if (FORBIDDEN_SET.has(lc)) return true;
  return FORBIDDEN_SUBSTRINGS.some((s) => lc.includes(s));
}

// Walk an object graph and collect dotted paths of any price/market keys.
export function findPriceKeys(value, path = '') {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findPriceKeys(v, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      if (keyIsPrice(k)) hits.push(here);
      hits.push(...findPriceKeys(v, here));
    }
  }
  return hits;
}

// Throw if any price/market/board-shape field is present. This is the
// "block, rather than hallucinate" guard applied to caller-supplied data.
export function assertNoPriceFields(value, ctx = 'input') {
  const hits = findPriceKeys(value);
  if (hits.length) {
    throw new Error(
      `price-isolation violation in ${ctx}: market/odds/board-shape field(s) not allowed in model data: ${hits.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------

function requireString(name, v) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`projection contract requires non-empty ${name}`);
  }
  return v;
}

function isProb(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

// A distribution: every value a probability, summing to ~1 (tolerance 1e-3).
function isDistribution(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const vals = Object.values(obj);
  if (!vals.length || !vals.every((v) => isProb(v))) return false;
  const sum = vals.reduce((s, v) => s + v, 0);
  return Math.abs(sum - 1) < 1e-3;
}

// A *_distribution (or bare `distribution`) key holds a normalized count
// distribution that must sum to ~1. Any other number-map (e.g. derived_probs:
// { over_5_5, over_6_5 }) is a set of INDEPENDENT rung probabilities — each a
// probability in [0,1], with no sum constraint.
const isDistributionKey = (k) => k === 'distribution' || k.endsWith('_distribution');

// Recursively validate a model OUTPUT block: bare numbers must be probabilities;
// distribution-keyed number-maps must sum to 1; other number-maps are independent
// rung probabilities; nested objects recurse (supports nested
// team_runs_distribution: { home: {...}, away: {...} }).
function validateOutputs(outputs, ctx) {
  if (outputs == null) return null;
  if (typeof outputs !== 'object' || Array.isArray(outputs)) {
    throw new Error(`${ctx}: outputs must be an object or null`);
  }
  const walk = (node, p, expectDist) => {
    for (const [k, v] of Object.entries(node)) {
      const here = `${p}.${k}`;
      const childExpectDist = expectDist || isDistributionKey(k);
      if (typeof v === 'number') {
        if (!isProb(v)) throw new Error(`${ctx}: ${here} must be a probability in [0,1], got ${v}`);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        const allNum = Object.values(v).every((x) => typeof x === 'number');
        if (allNum) {
          if (childExpectDist) {
            if (!isDistribution(v)) throw new Error(`${ctx}: ${here} must be a distribution summing to 1`);
          } else {
            for (const [rk, rv] of Object.entries(v)) {
              if (!isProb(rv)) throw new Error(`${ctx}: ${here}.${rk} must be a probability in [0,1], got ${rv}`);
            }
          }
        } else {
          walk(v, here, childExpectDist);
        }
      } else {
        throw new Error(`${ctx}: ${here} must be a probability, distribution, or nested object`);
      }
    }
  };
  walk(outputs, ctx, false);
  return outputs;
}

// Lower-bound expected value of a count distribution. Open buckets ("3+",
// "8_plus") contribute their leading integer as a floor, so the result is
// labelled "at least" downstream. Returns null for an unusable distribution.
export function distributionFloorMean(dist) {
  if (!dist || typeof dist !== 'object') return null;
  let sum = 0;
  let mass = 0;
  for (const [k, p] of Object.entries(dist)) {
    if (!isProb(p)) return null;
    const n = parseInt(String(k), 10);
    if (!Number.isFinite(n)) return null;
    sum += n * p;
    mass += p;
  }
  if (mass <= 0) return null;
  return sum / mass;
}

function parkRoofOpen(park) {
  // Unknown roof is treated as open-air (weather matters) — never assumed closed.
  return !park || park.roof == null || park.roof === 'open';
}

function baseEnvelope({ schema_version, market_families, game_id, as_of }) {
  return {
    schema_version,
    market_families,
    game_id: requireString('game_id', game_id),
    as_of:   requireString('as_of', as_of),
    no_trade: true,
    bankroll_action: 'none',
    safety_notes: [...SAFETY_NOTES],
  };
}

// ---------------------------------------------------------------------------
// Shared score-distribution contract → moneyline / spread / total
// ---------------------------------------------------------------------------
//
// One score model, three coherent markets. ML, spread, and total are read off
// the SAME latent game-state distribution so they can never disagree.
//
//   inputs:  { home_lineup, away_lineup, home_starter, away_starter,
//              park, weather }                                  (no prices)
//   outputs: { moneyline_home, runline_home_minus_1_5, total_over_<line>,
//              team_runs_distribution: { home, away },
//              total_runs_distribution }                       (probabilities only)
//
// Gating: starters + park required (else blocked); lineup confirmation and
// open-air weather completeness gate official vs provisional.
export function buildScoreEngineProjection({
  game_id, as_of,
  lineup_status = null,   // 'confirmed' | 'projected' | 'unconfirmed' | null
  weather_status = null,  // 'complete' | 'partial' | 'missing' | null
  inputs = {},
  outputs = null,
  uncertainty = {},
} = {}) {
  assertNoPriceFields(inputs, 'score-engine inputs');
  assertNoPriceFields(outputs, 'score-engine outputs');
  assertNoPriceFields(uncertainty, 'score-engine uncertainty');

  const { home_starter, away_starter, park } = inputs;
  const blocked_reasons = [];
  if (!home_starter || home_starter.player_id == null) blocked_reasons.push('home_starter_unconfirmed');
  if (!away_starter || away_starter.player_id == null) blocked_reasons.push('away_starter_unconfirmed');
  if (!park || park.id == null) blocked_reasons.push('park_unknown');

  const uncertainty_out = { lineup_penalty: 0, weather_penalty: 0, calibration_band: null, ...uncertainty };
  const weatherNeeded = parkRoofOpen(park);
  const weatherComplete = weather_status === 'complete' || !weatherNeeded;
  const lineupConfirmed = lineup_status === 'confirmed';

  let status;
  if (blocked_reasons.length) {
    status = 'blocked';
  } else {
    if (!lineupConfirmed) uncertainty_out.lineup_penalty = Math.max(uncertainty_out.lineup_penalty, 0.10);
    if (!weatherComplete) uncertainty_out.weather_penalty = Math.max(uncertainty_out.weather_penalty, 0.05);
    status = (lineupConfirmed && weatherComplete && outputs != null) ? 'official' : 'provisional';
  }

  return {
    ...baseEnvelope({
      schema_version: SCORE_ENGINE_SCHEMA,
      market_families: ['moneyline', 'spread', 'total'],
      game_id, as_of,
    }),
    status,
    lineup_status,
    weather_status,
    inputs_complete: status !== 'blocked',
    blocked_reasons,
    outputs: status === 'blocked' ? null : validateOutputs(outputs, 'score-engine outputs'),
    uncertainty: uncertainty_out,
  };
}

// ---------------------------------------------------------------------------
// YRFI / NRFI contract — first-inning run probability
// ---------------------------------------------------------------------------
//
// Top-of-order vs starter problem. Reuses the shared inputs stack. Official
// only with confirmed starters AND confirmed lineup; otherwise provisional
// with a sharp lineup penalty (the doc: "downgraded sharply or blocked").
export function buildYrfiProjection({
  game_id, as_of,
  lineup_status = null,
  weather_status = null,
  inputs = {},   // { home_top_order, away_top_order, home_starter, away_starter, park, weather }
  outputs = null, // { yrfi_prob, nrfi_prob }
  uncertainty = {},
} = {}) {
  assertNoPriceFields(inputs, 'yrfi inputs');
  assertNoPriceFields(outputs, 'yrfi outputs');
  assertNoPriceFields(uncertainty, 'yrfi uncertainty');

  const { home_starter, away_starter, park } = inputs;
  const blocked_reasons = [];
  if (!home_starter || home_starter.player_id == null) blocked_reasons.push('home_starter_unconfirmed');
  if (!away_starter || away_starter.player_id == null) blocked_reasons.push('away_starter_unconfirmed');
  if (!park || park.id == null) blocked_reasons.push('park_unknown');

  const uncertainty_out = { lineup_penalty: 0, weather_penalty: 0, calibration_band: null, ...uncertainty };
  const lineupConfirmed = lineup_status === 'confirmed';

  let status;
  if (blocked_reasons.length) {
    status = 'blocked';
  } else if (lineupConfirmed) {
    status = outputs != null ? 'official' : 'provisional';
  } else {
    // Unconfirmed top of the order → provisional, sharply downgraded.
    uncertainty_out.lineup_penalty = Math.max(uncertainty_out.lineup_penalty, 0.25);
    status = 'provisional';
  }

  return {
    ...baseEnvelope({
      schema_version: YRFI_SCHEMA,
      market_families: ['yrfi', 'nrfi'],
      game_id, as_of,
    }),
    status,
    lineup_status,
    weather_status,
    inputs_complete: status === 'official',
    blocked_reasons,
    outputs: status === 'blocked' ? null : validateOutputs(outputs, 'yrfi outputs'),
    uncertainty: uncertainty_out,
  };
}

// ---------------------------------------------------------------------------
// Pitcher strikeout contract — full K-count distribution
// ---------------------------------------------------------------------------
//
// Target is the full strikeout count for the starter, then over/under rungs
// derive from it. Blocks when starter, pitch-count leash, or opposing lineup
// quality is uncertain (the doc: "block when starter, pitch-count leash, or
// lineup quality is uncertain"). No provisional tier.
export function buildKsProjection({
  game_id, as_of, player_id,
  lineup_status = null,
  inputs = {},      // { starter, pitch_count_leash, opponent_lineup }
  outputs = null,   // { distribution, derived_probs }
  explanation = {}, // { expected_batters_faced, expected_k_rate, lineup_confirmed }
} = {}) {
  assertNoPriceFields(inputs, 'ks inputs');
  assertNoPriceFields(outputs, 'ks outputs');
  assertNoPriceFields(explanation, 'ks explanation');

  const { starter, pitch_count_leash } = inputs;
  const blocked_reasons = [];
  if (!starter || starter.player_id == null) blocked_reasons.push('starter_unconfirmed');
  if (pitch_count_leash == null) blocked_reasons.push('pitch_count_leash_unknown');
  if (lineup_status !== 'confirmed') blocked_reasons.push('opponent_lineup_unconfirmed');

  const status = blocked_reasons.length ? 'blocked' : 'official';

  return {
    ...baseEnvelope({
      schema_version: KS_SCHEMA,
      market_families: ['pitcher_strikeouts'],
      game_id, as_of,
    }),
    market_family: 'pitcher_strikeouts',
    player_id: player_id ?? null,
    status,
    lineup_status,
    inputs_complete: status === 'official',
    blocked_reasons,
    outputs: status === 'blocked' ? null : validateOutputs(outputs, 'ks outputs'),
    explanation: status === 'blocked' ? null : { lineup_confirmed: lineup_status === 'confirmed', ...explanation },
  };
}

// ---------------------------------------------------------------------------
// Batter home-run contract — rare-event P(at least one HR)
// ---------------------------------------------------------------------------
//
// Expected plate appearances × per-PA HR probability, rolled to game level.
// Blocks when the lineup is pending (the doc: "Block if lineup is unconfirmed").
// Open-air weather gaps widen uncertainty to provisional rather than block.
export function buildHrProjection({
  game_id, as_of, player_id,
  lineup_status = null,
  weather_status = null,
  inputs = {},      // { batter_in_lineup, expected_pa, park, weather, starter }
  outputs = null,   // { p_at_least_one_hr }
  explanation = {},
  uncertainty = {},
} = {}) {
  assertNoPriceFields(inputs, 'hr inputs');
  assertNoPriceFields(outputs, 'hr outputs');
  assertNoPriceFields(explanation, 'hr explanation');
  assertNoPriceFields(uncertainty, 'hr uncertainty');

  const { batter_in_lineup, expected_pa, park } = inputs;
  const blocked_reasons = [];
  if (lineup_status !== 'confirmed') blocked_reasons.push('lineup_unconfirmed');
  if (batter_in_lineup !== true)      blocked_reasons.push('batter_not_in_confirmed_lineup');
  if (expected_pa == null)            blocked_reasons.push('expected_pa_unknown');
  if (!park || park.id == null)       blocked_reasons.push('park_unknown');

  const uncertainty_out = { weather_penalty: 0, calibration_band: null, ...uncertainty };
  const weatherNeeded = parkRoofOpen(park);
  const weatherComplete = weather_status === 'complete' || !weatherNeeded;

  let status;
  if (blocked_reasons.length) {
    status = 'blocked';
  } else if (!weatherComplete) {
    uncertainty_out.weather_penalty = Math.max(uncertainty_out.weather_penalty, 0.05);
    status = 'provisional';
  } else {
    status = outputs != null ? 'official' : 'provisional';
  }

  return {
    ...baseEnvelope({
      schema_version: HR_SCHEMA,
      market_families: ['batter_home_runs'],
      game_id, as_of,
    }),
    market_family: 'batter_home_runs',
    player_id: player_id ?? null,
    status,
    lineup_status,
    weather_status,
    inputs_complete: status === 'official',
    blocked_reasons,
    outputs: status === 'blocked' ? null : validateOutputs(outputs, 'hr outputs'),
    explanation: status === 'blocked' ? null : { ...explanation },
    uncertainty: uncertainty_out,
  };
}
