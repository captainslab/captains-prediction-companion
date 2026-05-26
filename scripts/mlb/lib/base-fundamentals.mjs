// MLB base fundamentals composer.
//
// Normalizes 4 source-adapter envelopes into per-side fundamentals for one
// game matchup. Mirrors scripts/nascar/lib/base-fundamentals.mjs exactly:
//   - 4 layers with defined criticality
//   - data_quality: ok | partial | degraded | unavailable
//   - allowed_max_posture: PICK | EVIDENCE_LEAN | WATCH | NO_CLEAR_PICK
//   - No fabricated values. Missing layers surface as null with explicit reasons.
//
// Layer              Criticality  Source
// pitcher_quality    CRITICAL     mlb-official (probable IDs) + baseball-savant
// team_offense       CRITICAL     team-stats (W-L, run diff, OPS)
// bullpen_quality    NON-CRITICAL context (bullpen ERA, recent IP load)
// park_weather       NON-CRITICAL weather + context (park factor, conditions)
//
// Output per side (away/home):
//   {
//     side, team_name, pitcher_name, pitcher_id,
//     pitcher_quality_rating,  // 0-100
//     team_offense_rating,     // 0-100
//     bullpen_quality_rating,  // 0-100
//     park_weather_rating,     // 0-100 (shared, same for both sides)
//     layer_status: { pitcher_quality, team_offense, bullpen_quality, park_weather },
//     data_quality: 'ok' | 'partial' | 'degraded' | 'unavailable',
//     downgrade_reasons: string[],
//   }

export const FUNDAMENTAL_LAYERS = Object.freeze([
  'pitcher_quality',
  'team_offense',
  'bullpen_quality',
  'park_weather',
]);

const CRITICAL_LAYERS   = Object.freeze(['pitcher_quality', 'team_offense']);
const NON_CRITICAL_LAYERS = Object.freeze(['bullpen_quality', 'park_weather']);

function layerStatusOf(env) {
  if (!env) return 'unavailable';
  return env.source_status ?? env.status ?? 'unavailable';
}

function pickNum(rec, field) {
  if (!rec) return null;
  const v = rec[field];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolveDataQuality(layerStatus) {
  const crit    = CRITICAL_LAYERS.map(l => layerStatus[l] ?? 'unavailable');
  const nonCrit = NON_CRITICAL_LAYERS.map(l => layerStatus[l] ?? 'unavailable');
  if ([...crit, ...nonCrit].every(s => s === 'unavailable')) return 'unavailable';
  if (crit.some(s => s === 'unavailable')) return 'degraded';
  if (crit.every(s => s === 'ok') && nonCrit.every(s => s === 'ok')) return 'ok';
  return 'partial';
}

function allowedMaxPosture(dq) {
  if (dq === 'ok')       return 'PICK';
  if (dq === 'partial')  return 'EVIDENCE_LEAN';
  if (dq === 'degraded') return 'WATCH';
  return 'NO_CLEAR_PICK';
}

// Each envelope contains records with { side: 'away'|'home', ... }.
// park_weather is venue-level (one record, side omitted or 'neutral').
function indexBySide(env) {
  const m = { away: null, home: null, neutral: null };
  if (!env || !Array.isArray(env.records)) return m;
  for (const r of env.records) {
    if (r.side === 'away')    m.away    = r;
    else if (r.side === 'home')   m.home    = r;
    else if (!r.side || r.side === 'neutral') m.neutral = r;
  }
  return m;
}

export function composeBaseFundamentals({ game, envelopes = {} } = {}) {
  if (!game) throw new Error('composeBaseFundamentals requires { game }');

  const layerStatus      = {};
  const layerSourceNotes = {};
  const indexed          = {};

  for (const layer of FUNDAMENTAL_LAYERS) {
    const env = envelopes[layer] ?? null;
    layerStatus[layer]      = layerStatusOf(env);
    layerSourceNotes[layer] = env?.source_notes ?? [];
    indexed[layer]          = indexBySide(env);
  }

  const overallDQ = resolveDataQuality(layerStatus);
  const downgrade_reasons = FUNDAMENTAL_LAYERS
    .filter(l => layerStatus[l] !== 'ok')
    .map(l => `${l}_${layerStatus[l]}`);

  // park_weather is shared — use neutral or fall back to away/home
  const parkRec = indexed.park_weather.neutral
    ?? indexed.park_weather.away
    ?? indexed.park_weather.home;

  const buildSide = (side) => {
    const pitcher = indexed.pitcher_quality[side];
    const offense = indexed.team_offense[side];
    const bullpen = indexed.bullpen_quality[side];

    const sideDowngrade = [];
    for (const layer of FUNDAMENTAL_LAYERS) {
      const rec = layer === 'park_weather' ? parkRec : indexed[layer][side];
      if (!rec) {
        sideDowngrade.push(`${layer}_missing_for_side`);
      } else if (layerStatus[layer] === 'degraded') {
        sideDowngrade.push(`${layer}_degraded_source`);
      } else if (layerStatus[layer] === 'unavailable') {
        sideDowngrade.push(`${layer}_unavailable`);
      }
    }

    const sideDQ = sideDowngrade.length === 0
      ? 'ok'
      : sideDowngrade.some(r => r.endsWith('_unavailable')) ? 'degraded' : 'partial';

    return {
      side,
      team_name: pitcher?.team_name ?? offense?.team_name
        ?? (side === 'away' ? game.away_team : game.home_team) ?? null,
      pitcher_name: pitcher?.pitcher_name ?? null,
      pitcher_id:   pitcher?.pitcher_id   ?? null,
      pitcher_quality_rating:  pickNum(pitcher, 'pitcher_quality_rating'),
      team_offense_rating:     pickNum(offense, 'team_offense_rating'),
      bullpen_quality_rating:  pickNum(bullpen, 'bullpen_quality_rating'),
      park_weather_rating:     pickNum(parkRec, 'park_weather_rating'),
      layer_status:    { ...layerStatus },
      data_quality:    sideDQ,
      downgrade_reasons: sideDowngrade,
    };
  };

  return {
    schema_version:        'mlb_base_fundamentals_v1',
    game_pk:               game.game_pk  ?? null,
    away_team:             game.away_team ?? null,
    home_team:             game.home_team ?? null,
    away:                  buildSide('away'),
    home:                  buildSide('home'),
    layer_status:          layerStatus,
    layer_source_notes:    layerSourceNotes,
    overall_data_quality:  overallDQ,
    allowed_max_posture:   allowedMaxPosture(overallDQ),
    downgrade_reasons,
    safety_notes: [
      'No fabricated ratings. Missing layers surface as null with explicit downgrade reasons.',
      'No price, volume, OI, or line-movement considered here.',
      'Fixture-mode envelopes produce degraded or unavailable layer statuses.',
    ],
  };
}

// Helpers for converting raw pitcher/team stats into 0-100 ratings.
// Used by source adapters and the research-agent adapter.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function ratingFromPitcherStats({ era, fip, kPct, bbPct } = {}) {
  const scores = [];
  if (era != null && Number.isFinite(era)) {
    scores.push({ score: clamp(100 - (era - 2.50) * 15, 0, 100), weight: 0.45 });
  }
  if (fip != null && Number.isFinite(fip)) {
    scores.push({ score: clamp(100 - (fip - 2.50) * 15, 0, 100), weight: 0.25 });
  }
  if (kPct != null && Number.isFinite(kPct)) {
    // 30% K → 90, 20% K → 60, 10% K → 30
    scores.push({ score: clamp(kPct * 300, 0, 100), weight: 0.20 });
  }
  if (bbPct != null && Number.isFinite(bbPct)) {
    // 5% BB → 75, 8% BB → 60, 12% BB → 40
    scores.push({ score: clamp(100 - bbPct * 500, 0, 100), weight: 0.10 });
  }
  if (!scores.length) return null;
  const den = scores.reduce((s, x) => s + x.weight, 0);
  return Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
}

export function ratingFromTeamStats({ winPct, runDiff, ops, last10WinPct } = {}) {
  const scores = [];
  if (winPct != null && Number.isFinite(winPct)) {
    // .600 → 70, .500 → 50, .400 → 30
    scores.push({ score: clamp(winPct * 100 + 20, 0, 100), weight: 0.35 });
  }
  if (runDiff != null && Number.isFinite(runDiff)) {
    // +100 → 90, 0 → 50, -100 → 10
    scores.push({ score: clamp(50 + runDiff * 0.4, 0, 100), weight: 0.25 });
  }
  if (ops != null && Number.isFinite(ops)) {
    // .800 OPS → 70, .750 → 55, .700 → 40
    scores.push({ score: clamp((ops - 0.600) * 250, 0, 100), weight: 0.25 });
  }
  if (last10WinPct != null && Number.isFinite(last10WinPct)) {
    scores.push({ score: clamp(last10WinPct * 100 + 20, 0, 100), weight: 0.15 });
  }
  if (!scores.length) return null;
  const den = scores.reduce((s, x) => s + x.weight, 0);
  return Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
}

export function ratingFromBullpenStats({ bullpenEra, recentIpLoadPct } = {}) {
  const scores = [];
  if (bullpenEra != null && Number.isFinite(bullpenEra)) {
    // ERA 3.00 → 85, 4.00 → 70, 5.00 → 55
    scores.push({ score: clamp(100 - (bullpenEra - 2.50) * 12, 0, 100), weight: 0.70 });
  }
  if (recentIpLoadPct != null && Number.isFinite(recentIpLoadPct)) {
    // 0% recent load → 100 (fresh), 100% overloaded → 0
    scores.push({ score: clamp(100 - recentIpLoadPct, 0, 100), weight: 0.30 });
  }
  if (!scores.length) return null;
  const den = scores.reduce((s, x) => s + x.weight, 0);
  return Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
}

export function ratingFromParkWeather({ parkFactor = 100, temperatureF, windMph, precipRisk = 0 } = {}) {
  // Neutral = 50. Higher = more scoring-friendly environment.
  // parkFactor: 100 neutral, 110 hitter-friendly, 90 pitcher-friendly
  const parkContrib = clamp(50 + (parkFactor - 100) * 0.8, 0, 100);
  const scores = [{ score: parkContrib, weight: 0.55 }];
  if (temperatureF != null && Number.isFinite(temperatureF)) {
    // 72°F → 55, 55°F → 40, 85°F → 65 (warmer = more offense)
    scores.push({ score: clamp(30 + (temperatureF - 55) * 0.7, 0, 100), weight: 0.25 });
  }
  if (windMph != null && Number.isFinite(windMph)) {
    // Wind out ≈ scoring boost. Wind in ≈ suppress. Neutral = 0 mph.
    // We treat all wind as roughly neutral unless direction is known.
    scores.push({ score: clamp(50 + windMph * 0.3, 0, 100), weight: 0.10 });
  }
  if (precipRisk != null && Number.isFinite(precipRisk)) {
    // High precip risk suppresses scoring (wet ball, potential delays)
    scores.push({ score: clamp(100 - precipRisk * 80, 0, 100), weight: 0.10 });
  }
  const den = scores.reduce((s, x) => s + x.weight, 0);
  return Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
}
