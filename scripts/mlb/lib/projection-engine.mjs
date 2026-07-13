// MLB projection ENGINE — computes REAL, market-free projections from public
// baseball inputs (MLB Stats API records materialised in
// state/mlb/<date>/discovery/stats_adapter.json) and emits them through the
// price-isolated projection CONTRACTS (projection-contracts.mjs).
//
// This is the transparent Phase-2 baseline from
// docs/MLB_PROJECTION_IMPLEMENTATION_PLAN.md: "one market-free model with
// public inputs", judged later by calibration / CLV. It is intentionally a
// documented statistical model, NOT a black box and NOT fabricated numbers:
// every output traces to a real input via a stated formula.
//
// Inputs used (all baseball performance, NEVER market/price):
//   - team runs scored / allowed per game, games played
//   - starting-pitcher ERA + K% + BB% + IP/GS + batters faced
//   - bullpen ERA
//   - venue (park identity), confirmed-lineup + weather status (gating only)
//
// Run model (log5-style matchup): a team's expected runs scale its own scoring
// rate by how good the opponent's run prevention is relative to the league.
// Scores are Poisson around that mean; the three game markets (ML / run line /
// total) and YRFI all read off the SAME two team-run means so they can never
// disagree. Strikeouts use a Binomial(batters_faced, K%) count model.
//
// Pure ESM. No I/O except the explicit loader. No network. No fabricated values.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildScoreEngineProjection,
  buildYrfiProjection,
  buildKsProjection,
} from './projection-contracts.mjs';
import {
  buildGameHrProjections,
  loadRegularGameModel,
} from '../hr-engine/regular-game-model.mjs';

const BUNDLED_HR_MODEL_URL = new URL('../hr-engine/artifacts/regular-game-model-2025.json', import.meta.url);
let bundledHrModelCache;

function loadBundledHrModel() {
  if (bundledHrModelCache !== undefined) return bundledHrModelCache;
  if (!existsSync(BUNDLED_HR_MODEL_URL)) {
    bundledHrModelCache = null;
    return bundledHrModelCache;
  }
  try {
    bundledHrModelCache = loadRegularGameModel(BUNDLED_HR_MODEL_URL);
  } catch {
    bundledHrModelCache = null;
  }
  return bundledHrModelCache;
}

// --- Documented model constants (transparent, not tuned to any market) -------
export const MODEL = Object.freeze({
  // Run prevention is mostly the starter, with bullpen and team-defense signal.
  STARTER_WEIGHT: 0.60,
  BULLPEN_WEIGHT: 0.25,
  TEAM_DEF_WEIGHT: 0.15,
  HOME_RUN_BOOST: 1.03,     // modest, well-established home scoring edge
  LAMBDA_MIN: 1.0,
  LAMBDA_MAX: 9.0,
  FIRST_INNING_FACTOR: 1.10, // top-of-order sees the 1st inning; mild uplift
  FALLBACK_LEAGUE_RPG: 4.40,
  STARTER_DEFAULT_BF: 22,    // batters faced per start when IP/BF missing
});

// --- Poisson helpers ---------------------------------------------------------
export function poissonPmf(lambda, k) {
  if (!(lambda > 0) || k < 0) return 0;
  // exp(k*ln λ − λ − ln k!) for numerical stability.
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(k * Math.log(lambda) - lambda - logFact);
}

// Normalised count distribution { '0':p, ... '<max>_plus':p } summing to 1.
// The open top bucket absorbs the entire upper tail so the result is exact.
export function poissonDistribution(lambda, maxBucket = 12) {
  const dist = {};
  let mass = 0;
  for (let k = 0; k < maxBucket; k++) {
    const p = poissonPmf(lambda, k);
    dist[String(k)] = p;
    mass += p;
  }
  dist[`${maxBucket}_plus`] = Math.max(0, 1 - mass);
  return dist;
}

// League baseline runs/game = mean team scoring rate across the slate records.
export function leagueRunsPerGame(records = []) {
  let sum = 0;
  let n = 0;
  for (const r of records) {
    for (const s of [r?.away_team_stats, r?.home_team_stats]) {
      const rs = Number(s?.runs_scored);
      const g = Number(s?.gamesPlayed ?? s?.games_played);
      if (Number.isFinite(rs) && g > 0) { sum += rs / g; n += 1; }
    }
  }
  return n ? sum / n : MODEL.FALLBACK_LEAGUE_RPG;
}

function teamRatePerGame(stats, key) {
  const v = Number(stats?.[key]);
  const g = Number(stats?.gamesPlayed ?? stats?.games_played);
  return (Number.isFinite(v) && g > 0) ? v / g : null;
}

function starterEra(p) {
  const e = Number(p?.era);
  const gs = Number(p?.games_started);
  const ip = Number.parseFloat(p?.innings_pitched);
  if (!Number.isFinite(e) || e <= 0) return NaN;
  if (Number.isFinite(gs) && gs < 1) return NaN;
  if (Number.isFinite(ip) && ip < 10) return NaN;
  return e;
}

// Opponent run prevention per 9, blended starter + bullpen + team defense.
function runPrevention(starterEra, bullpenEra, teamRunsAllowedPerGame, leagueRPG) {
  const parts = [];
  let wsum = 0;
  if (Number.isFinite(starterEra)) { parts.push(MODEL.STARTER_WEIGHT * starterEra); wsum += MODEL.STARTER_WEIGHT; }
  if (Number.isFinite(bullpenEra)) { parts.push(MODEL.BULLPEN_WEIGHT * bullpenEra); wsum += MODEL.BULLPEN_WEIGHT; }
  if (Number.isFinite(teamRunsAllowedPerGame)) { parts.push(MODEL.TEAM_DEF_WEIGHT * teamRunsAllowedPerGame); wsum += MODEL.TEAM_DEF_WEIGHT; }
  if (!wsum) return leagueRPG;
  return parts.reduce((a, b) => a + b, 0) / wsum;
}

function clampLambda(x) {
  if (!Number.isFinite(x)) return null;
  return Math.min(MODEL.LAMBDA_MAX, Math.max(MODEL.LAMBDA_MIN, x));
}

// Expected runs each team scores: own scoring rate × (opp run prevention /
// league). Home side gets the modest home boost.
export function projectRunMeans(record, leagueRPG) {
  const a = record?.away_team_stats;
  const h = record?.home_team_stats;
  const ap = record?.away_pitcher;
  const hp = record?.home_pitcher;

  const offAway = teamRatePerGame(a, 'runs_scored');
  const offHome = teamRatePerGame(h, 'runs_scored');
  if (offAway == null || offHome == null) return null;

  // Opponent run prevention: away offense faces HOME pitching, and vice versa.
  const prevHomePitch = runPrevention(starterEra(hp), Number(record?.home_bullpen?.era), teamRatePerGame(h, 'runs_allowed'), leagueRPG);
  const prevAwayPitch = runPrevention(starterEra(ap), Number(record?.away_bullpen?.era), teamRatePerGame(a, 'runs_allowed'), leagueRPG);

  const lambdaAway = clampLambda(offAway * (prevHomePitch / leagueRPG));
  const lambdaHome = clampLambda(offHome * (prevAwayPitch / leagueRPG) * MODEL.HOME_RUN_BOOST);
  if (lambdaAway == null || lambdaHome == null) return null;
  return { lambdaAway, lambdaHome };
}

// P(home wins), P(home−away ≥ 2), from two independent Poisson run totals.
function gameOutcomeProbs(lambdaHome, lambdaAway, cap = 25) {
  let pHomeWin = 0;
  let pTie = 0;
  let pHomeCover = 0; // home −1.5 (margin ≥ 2)
  for (let h = 0; h <= cap; h++) {
    const ph = poissonPmf(lambdaHome, h);
    for (let a = 0; a <= cap; a++) {
      const pa = poissonPmf(lambdaAway, a);
      const joint = ph * pa;
      if (h > a) pHomeWin += joint;
      else if (h === a) pTie += joint;
      if (h - a >= 2) pHomeCover += joint;
    }
  }
  // Ties resolve in extras; split evenly (no market input).
  const moneyline_home = Math.min(1, Math.max(0, pHomeWin + 0.5 * pTie));
  return { moneyline_home, runline_home_minus_1_5: Math.min(1, Math.max(0, pHomeCover)) };
}

// P(≥1 run in the 1st inning) from per-inning Poisson means.
function yrfiProb(lambdaHome, lambdaAway) {
  const lamH = (lambdaHome / 9) * MODEL.FIRST_INNING_FACTOR;
  const lamA = (lambdaAway / 9) * MODEL.FIRST_INNING_FACTOR;
  const pNoRun = Math.exp(-lamH) * Math.exp(-lamA);
  return Math.min(1, Math.max(0, 1 - pNoRun));
}

// Expected starter strikeouts = batters_faced/start × K%. Distribution Poisson
// around that mean; rungs are survival probabilities.
function expectedStarterKs(pitcher) {
  const kPct = Number(pitcher?.k_pct ?? pitcher?.kPct);
  if (!Number.isFinite(kPct) || kPct <= 0) return null;
  const gs = Number(pitcher?.games_started);
  const bfTotal = Number(pitcher?.batters_faced);
  const bfPerStart = (Number.isFinite(bfTotal) && gs > 0) ? bfTotal / gs : MODEL.STARTER_DEFAULT_BF;
  return { expectedK: bfPerStart * kPct, bfPerStart, kPct };
}

function survivalAtLeast(dist, n) {
  let p = 0;
  for (const [k, v] of Object.entries(dist)) {
    if (parseInt(k, 10) >= n) p += v;
  }
  return Math.min(1, Math.max(0, p));
}

// --- Top-level: build all four contracts for one game ------------------------
export function buildGameProjections({
  record,
  leagueRPG,
  as_of,
  lineup_status = null,
  weather_status = null,
  hr_model = undefined,
  hr_batters = undefined,
  hr_evidence = undefined,
  hr_seed = 'cpc-hr-regular-game',
  hr_simulations = 10_000,
} = {}) {
  const game_id = String(record?.game_pk ?? record?.label ?? 'unknown');
  const stamp = as_of || `${record?.game_date || 'unknown-date'}T00:00:00Z`;
  const park = { id: String(record?.venue ?? record?.game_pk ?? 'unknown_park'), roof: null };
  const ap = record?.away_pitcher;
  const hp = record?.home_pitcher;
  const home_starter = hp?.mlb_id != null ? { player_id: hp.mlb_id } : null;
  const away_starter = ap?.mlb_id != null ? { player_id: ap.mlb_id } : null;

  const lg = Number.isFinite(leagueRPG) && leagueRPG > 0 ? leagueRPG : MODEL.FALLBACK_LEAGUE_RPG;
  const means = projectRunMeans(record, lg);

  // ---- Score engine: ML / run line / total / team runs ----
  let scoreOutputs = null;
  let yrfiOutputs = null;
  if (means) {
    const { lambdaHome, lambdaAway } = means;
    const { moneyline_home, runline_home_minus_1_5 } = gameOutcomeProbs(lambdaHome, lambdaAway);
    scoreOutputs = {
      moneyline_home,
      runline_home_minus_1_5,
      team_runs_distribution: {
        home: poissonDistribution(lambdaHome, 12),
        away: poissonDistribution(lambdaAway, 12),
      },
      total_runs_distribution: poissonDistribution(lambdaHome + lambdaAway, 20),
    };
    const yp = yrfiProb(lambdaHome, lambdaAway);
    yrfiOutputs = { yrfi_prob: yp, nrfi_prob: Math.min(1, Math.max(0, 1 - yp)) };
  }

  const score = buildScoreEngineProjection({
    game_id, as_of: stamp, lineup_status, weather_status,
    inputs: { home_starter, away_starter, park },
    outputs: scoreOutputs,
  });

  const yrfi = buildYrfiProjection({
    game_id, as_of: stamp, lineup_status, weather_status,
    inputs: { home_starter, away_starter, park },
    outputs: yrfiOutputs,
  });

  // ---- Strikeouts: per starter. Contract blocks unless lineup confirmed +
  // leash known, so these only carry numbers when those inputs exist. ----
  const ksFor = (pitcher, side) => {
    const est = expectedStarterKs(pitcher);
    let outputs = null;
    let explanation = {};
    if (est && lineup_status === 'confirmed') {
      const dist = poissonDistribution(est.expectedK, 14);
      outputs = {
        distribution: dist,
        derived_probs: {
          over_4_5: survivalAtLeast(dist, 5),
          over_5_5: survivalAtLeast(dist, 6),
          over_6_5: survivalAtLeast(dist, 7),
        },
      };
      explanation = { expected_batters_faced: Math.round(est.bfPerStart), expected_k_rate: est.kPct };
    }
    return buildKsProjection({
      game_id, as_of: stamp, player_id: pitcher?.mlb_id ?? null,
      lineup_status,
      // Pitch-count leash from real workload (IP/GS → ~BF) when lineup confirmed.
      inputs: { starter: pitcher?.mlb_id != null ? { player_id: pitcher.mlb_id } : null,
                pitch_count_leash: est && lineup_status === 'confirmed' ? Math.round(est.bfPerStart) : null },
      outputs,
      explanation,
    });
  };

  const ks_home = ksFor(hp, 'home');
  const ks_away = ksFor(ap, 'away');

  // HR is a separate fitted per-PA model. It receives only explicitly
  // allowlisted baseball evidence and fails closed when confirmed batter-level
  // lineup inputs are absent. Score/YRFI/K calculations above are unchanged.
  const resolvedHrModel = hr_model === undefined ? loadBundledHrModel() : hr_model;
  const batters = hr_batters ?? record?.hr_batters ?? record?.confirmed_batters ?? [];
  const evidence = hr_evidence ?? record?.hr_evidence ?? record?.batter_hr_evidence ?? [];
  const hr = resolvedHrModel
    ? buildGameHrProjections({
      model: resolvedHrModel,
      batters,
      evidence,
      opposing_pitchers: { away: ap, home: hp },
      park: record?.hr_park ?? {
        id: record?.home_team_abbrev ?? record?.home_team ?? null,
        roof: record?.roof ?? null,
        altitude: record?.altitude ?? null,
      },
      weather: record?.hr_weather ?? record?.weather ?? null,
      lineup_status,
      seed: hr_seed,
      simulations: hr_simulations,
      as_of: stamp,
    })
    : {
      schema_version: 'cpc_mlb_regular_game_hr_game_v1',
      status: 'blocked',
      model_status: 'MODEL_INSUFFICIENT',
      blocked_reasons: ['MODEL_ARTIFACT_MISSING_OR_INVALID'],
      outputs: [],
      audit: { market_inputs_used: false, ordering: 'descending modeled any-HR probability, then MLB ID' },
    };

  return { score, yrfi, ks_home, ks_away, hr, means };
}

// --- Loader + matcher --------------------------------------------------------
export function loadStatsRecords(stateRoot, date) {
  const p = join(stateRoot, 'mlb', date, 'discovery', 'stats_adapter.json');
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const records = Array.isArray(j?.records) ? j.records : [];
    const contextPath = join(stateRoot, 'mlb', date, 'discovery', 'context_adapter.json');
    if (!existsSync(contextPath)) return records;
    let contextPayload;
    try {
      contextPayload = JSON.parse(readFileSync(contextPath, 'utf8'));
    } catch {
      return records;
    }
    const contexts = Array.isArray(contextPayload?.records) ? contextPayload.records : [];
    return records.map((record) => {
      const context = contexts.find((candidate) => String(candidate?.game_pk ?? '') === String(record?.game_pk ?? ''))
        ?? contexts.find((candidate) => candidate?.away_team === record?.away_team && candidate?.home_team === record?.home_team)
        ?? null;
      if (!context) return record;
      const away = (context.away_batting_order ?? []).slice(0, 9).map((id, index) => ({
        mlb_id: id, batter_id: id, lineup_slot: index + 1, side: 'away', team: record.away_team_abbrev ?? record.away_team,
      }));
      const home = (context.home_batting_order ?? []).slice(0, 9).map((id, index) => ({
        mlb_id: id, batter_id: id, lineup_slot: index + 1, side: 'home', team: record.home_team_abbrev ?? record.home_team,
      }));
      const batters = [...away, ...home];
      return {
        ...record,
        hr_batters: batters,
        hr_evidence: batters,
        hr_lineup_source: context.source_id ?? 'lineup_injury_bullpen',
        lineup_status: String(context.lineup_status ?? '').startsWith('confirmed') ? 'confirmed' : 'unconfirmed',
      };
    });
  } catch { return []; }
}

// Match a stats record to a Kalshi event by the away+home abbrev code embedded
// in the event ticker (e.g. KXMLBGAME-...SFATL → SF+ATL).
export function matchStatsRecord(records = [], { eventTicker = '', awayName = '', homeName = '' } = {}) {
  const tick = String(eventTicker).toUpperCase();
  for (const r of records) {
    const code = `${r?.away_team_abbrev ?? ''}${r?.home_team_abbrev ?? ''}`.toUpperCase();
    if (code && tick.includes(code)) return r;
  }
  const norm = (s) => String(s).toLowerCase();
  if (awayName && homeName) {
    for (const r of records) {
      if (norm(r?.away_team).includes(norm(awayName)) && norm(r?.home_team).includes(norm(homeName))) return r;
    }
  }
  return null;
}
