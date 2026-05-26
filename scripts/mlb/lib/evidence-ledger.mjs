// MLB evidence ledger — 13-layer composite per game side.
//
// Mirrors scripts/nascar/lib/final-ceiling.mjs for MLB games.
// Produces one evidence ledger per SIDE (away / home) of a matchup,
// then derives per-lane ceiling signals from the side differentials.
//
// Layers                          Weight  Source
//  1. baseline_fundamentals        0.12   base-fundamentals.mjs composite
//  2. season_form                  0.12   team W-L%, run diff percentile
//  3. recent_form                  0.10   L10 record + RS scoring trend
//  4. starting_pitcher_signal      0.12   ERA, FIP, K%, recent outing quality
//  5. pitcher_at_this_park         0.09   starter ERA/HR9 at this specific venue
//  6. pitcher_vs_this_opponent     0.09   starter record/K% vs this specific team
//  7. park_weather_context         0.07   park factor + temp/wind/precip
//  8. matchup_splits               0.08   pitcher vs lineup, H2H team splits
//  9. lineup_injury_state          0.04   IL depth, lineup confirmation
// 10. bullpen_fatigue_availability 0.07   consecutive-day usage, key reliever IL status
// 11. lineup_handedness_matchup    0.05   pitcher hand vs lineup L/R OPS splits
// 12. game_volatility_context      0.03   chaos score: weak starters + hitter's park + heat
// 13. umpire_bias                  0.02   home-plate umpire K-zone/run tendency (stub; always missing)
//
// Game-specific layers (5+6) total 0.18, handedness adds 0.05 — total game-specific 0.23.
// Umpire is expected missing; missing layers re-normalized out automatically.
//
// Data coverage caps (same as NASCAR):
//   0 layers → NO CLEAR PICK
//   1 layer  → max LEAN
//   2 layers → max EVIDENCE_LEAN
//   3+ layers → PICK eligible (still subject to data_quality cap)
//
// Pure ESM. No I/O. No live network.

export const LANE_STATUSES = Object.freeze([
  'PICK', 'EVIDENCE_LEAN', 'LEAN', 'WATCH', 'NO CLEAR PICK', 'MARKET_ONLY',
]);

const LAYER_DEFS = Object.freeze([
  { key: 'baseline_fundamentals',        weight: 0.12, label: 'Baseline pitcher + team + bullpen + park fundamentals composite' },
  { key: 'season_form',                  weight: 0.12, label: '2026 season W-L%, run differential percentile' },
  { key: 'recent_form',                  weight: 0.10, label: 'L10 record + run-scoring trend (hot/cold detection)' },
  { key: 'starting_pitcher_signal',      weight: 0.12, label: 'Starting pitcher ERA/FIP/K% + recent outing quality' },
  { key: 'pitcher_at_this_park',         weight: 0.09, label: 'Starter ERA/HR-per-9 at this specific venue (game-specific)' },
  { key: 'pitcher_vs_this_opponent',     weight: 0.09, label: 'Starter record/K%/ERA vs this specific opponent (game-specific)' },
  { key: 'park_weather_context',         weight: 0.07, label: 'Ballpark factor + temperature/wind/precipitation' },
  { key: 'matchup_splits',               weight: 0.08, label: 'Pitcher vs lineup platoon splits + H2H team history' },
  { key: 'lineup_injury_state',          weight: 0.04, label: 'Lineup confirmation + IL depth + bullpen availability' },
  { key: 'bullpen_fatigue_availability', weight: 0.07, label: 'Bullpen consecutive-day usage + key reliever IL status' },
  { key: 'lineup_handedness_matchup',    weight: 0.05, label: 'Pitcher hand vs lineup L/R OPS splits (handedness edge)' },
  { key: 'game_volatility_context',      weight: 0.03, label: 'Chaos score: weak starters + hitter park + heat + bullpen load' },
  { key: 'umpire_bias',                  weight: 0.02, label: 'Home-plate umpire K-zone/run tendency (source not yet wired)' },
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function gradeLabel(s) {
  if (s === null || s === undefined) return 'n/a';
  if (s >= 80) return 'A';
  if (s >= 70) return 'B';
  if (s >= 60) return 'C';
  if (s >= 45) return 'D';
  return 'F';
}

// --- Per-layer evaluators ---------------------------------------------------

function evalBaselineFundamentals(sideEntry) {
  const parts = [
    { field: 'pitcher_quality_rating', w: 0.40 },
    { field: 'team_offense_rating',    w: 0.35 },
    { field: 'bullpen_quality_rating', w: 0.15 },
    { field: 'park_weather_rating',    w: 0.10 },
  ];
  let num = 0, den = 0;
  const used = [];
  const missing = [];
  for (const p of parts) {
    const raw = sideEntry?.[p.field];
    const n = (raw === null || raw === undefined) ? null : Number(raw);
    if (n !== null && Number.isFinite(n)) {
      num += n * p.w; den += p.w;
      used.push({ field: p.field, value: n, weight: p.w });
    } else {
      missing.push(p.field);
    }
  }
  if (den === 0) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'base-fundamentals composite (pitcher_quality + team_offense + bullpen_quality + park_weather)',
      missing_note: `no fundamentals fields available (missing: ${missing.join(', ')})`,
      used_fields: [] };
  }
  const score = Math.round(clamp(num / den, 0, 100));
  return {
    present: true, score, grade: gradeLabel(score),
    basis: 'base-fundamentals composite (re-weighted over present sub-layers)',
    missing_note: missing.length ? `partial: missing ${missing.join(', ')}` : null,
    used_fields: used,
  };
}

function evalSeasonForm(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: '2026 season W-L% + run differential percentile',
      missing_note: rec?.missing_reason ?? 'no 2026 season stats row for this team',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? '2026 season W-L% + run differential',
    sample_quality: rec.sample_quality ?? null,
    detail: rec.detail ?? null,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.games_played} games)` : null,
  };
}

function evalRecentForm(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'L10 record + run-scoring trend',
      missing_note: rec?.missing_reason ?? 'no recent-form row for this team',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'L10 record + run-scoring trend',
    detail: rec.detail ?? null,
    missing_note: null,
  };
}

function evalStartingPitcherSignal(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Starting pitcher ERA/FIP/K% + recent outing quality',
      missing_note: rec?.missing_reason ?? 'no confirmed starter or no 2026 sample for this pitcher',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Starting pitcher ERA/FIP/K% composite',
    detail: rec.detail ?? null,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.starts} starts)` : null,
  };
}

function evalParkWeatherContext(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Ballpark factor + temperature/wind/precipitation',
      missing_note: rec?.missing_reason ?? 'no park/weather record for this game',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Park factor + weather conditions',
    detail: rec.detail ?? null,
    missing_note: null,
  };
}

function evalPitcherAtThisPark(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Starter ERA/HR-per-9 at this specific venue',
      missing_note: rec?.missing_reason ?? 'no venue-split data for this starter',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Starter venue splits',
    detail: rec.detail ?? null,
    missing_note: rec.sample_quality === 'thin' ? 'thin venue sample (<3 GS at this park)' : null,
  };
}

function evalPitcherVsThisOpponent(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Starter record/K%/ERA vs this specific opponent',
      missing_note: rec?.missing_reason ?? 'no opponent-split data for this starter',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Starter opponent splits',
    detail: rec.detail ?? null,
    missing_note: rec.sample_quality === 'thin' ? 'thin opponent sample (<4 GS vs this team)' : null,
  };
}

function evalMatchupSplits(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Pitcher vs lineup platoon splits + H2H team history',
      missing_note: rec?.missing_reason ?? 'no matchup splits available (requires confirmed starter + lineup)',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Pitcher vs lineup splits + H2H',
    detail: rec.detail ?? null,
    missing_note: rec.sample_quality === 'thin' ? `thin H2H or splits sample` : null,
  };
}

function evalBullpenFatigueAvailability(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Bullpen consecutive-day usage + key reliever IL status',
      missing_note: rec?.missing_reason ?? 'bullpen fatigue/availability data not provided',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Bullpen usage load + IL availability',
    detail: rec.detail ?? null,
    missing_note: rec.score < 45 ? 'Bullpen heavily taxed — reliability risk' : null,
  };
}

function evalLineupHandednessMatchup(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Pitcher hand vs lineup L/R OPS splits',
      missing_note: rec?.missing_reason ?? 'pitcher hand or lineup handedness data not provided',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Pitcher-hand vs lineup handedness splits',
    detail: rec.detail ?? null,
    missing_note: null,
  };
}

function evalGameVolatilityContext(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Game chaos score: starter quality + bullpen load + park + weather',
      missing_note: rec?.missing_reason ?? 'game volatility not derivable from available inputs',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Game volatility (run-environment chaos)',
    detail: rec.detail ?? null,
    missing_note: null,
  };
}

function evalUmpireBias(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Home-plate umpire K-zone/run tendency',
      missing_note: rec?.missing_reason ?? 'umpire source not yet wired to an adapter — always missing',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Umpire K-zone + run-scoring tendency',
    detail: rec.detail ?? null,
    missing_note: null,
  };
}

function evalLineupInjuryState(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Lineup confirmation + IL depth + bullpen availability',
      missing_note: rec?.missing_reason ?? 'lineup not yet confirmed; IL status pending',
      detail: null };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Lineup confirmation + IL depth',
    detail: rec.detail ?? null,
    missing_note: rec.lineup_status !== 'confirmed' ? `lineup status: ${rec.lineup_status ?? 'unknown'}` : null,
  };
}

// --- Composite builder for one side -----------------------------------------

export function composeEvidenceLedgerForSide({
  sideEntry,                       // from base-fundamentals.mjs
  seasonFormRecord              = null,
  recentFormRecord              = null,
  pitcherSignalRecord           = null,
  pitcherAtParkRecord           = null,
  pitcherVsOpponentRecord       = null,
  parkWeatherRecord             = null,
  matchupSplitsRecord           = null,
  lineupInjuryRecord            = null,
  bullpenFatigueRecord          = null,
  lineupHandednessRecord        = null,
  gameVolatilityRecord          = null,
  umpireBiasRecord              = null,
} = {}) {
  const layers = {
    baseline_fundamentals:        evalBaselineFundamentals(sideEntry),
    season_form:                  evalSeasonForm(seasonFormRecord),
    recent_form:                  evalRecentForm(recentFormRecord),
    starting_pitcher_signal:      evalStartingPitcherSignal(pitcherSignalRecord),
    pitcher_at_this_park:         evalPitcherAtThisPark(pitcherAtParkRecord),
    pitcher_vs_this_opponent:     evalPitcherVsThisOpponent(pitcherVsOpponentRecord),
    park_weather_context:         evalParkWeatherContext(parkWeatherRecord),
    matchup_splits:               evalMatchupSplits(matchupSplitsRecord),
    lineup_injury_state:          evalLineupInjuryState(lineupInjuryRecord),
    bullpen_fatigue_availability: evalBullpenFatigueAvailability(bullpenFatigueRecord),
    lineup_handedness_matchup:    evalLineupHandednessMatchup(lineupHandednessRecord),
    game_volatility_context:      evalGameVolatilityContext(gameVolatilityRecord),
    umpire_bias:                  evalUmpireBias(umpireBiasRecord),
  };

  let num = 0, den = 0;
  const ledger = [];

  for (const def of LAYER_DEFS) {
    const lo = layers[def.key];
    if (lo.present && lo.score !== null) {
      num += lo.score * def.weight;
      den += def.weight;
    }
    ledger.push({
      category:       def.key,
      label:          def.label,
      raw_weight:     def.weight,
      source_basis:   lo.basis,
      value:          lo.score,
      grade:          lo.grade,
      detail:         lo.detail   ?? null,
      used_fields:    lo.used_fields ?? undefined,
      present:        lo.present,
      missing_note:   lo.missing_note ?? null,
      normalized_weight: null,
      contribution:   null,
    });
  }

  for (const row of ledger) {
    if (row.present && row.value !== null && den > 0) {
      row.normalized_weight = +(row.raw_weight / den).toFixed(4);
      row.contribution      = +(row.value * (row.raw_weight / den)).toFixed(2);
    }
  }

  const composite      = den === 0 ? null : Math.round(clamp(num / den, 0, 100));
  const layersPresent  = ledger.filter(r => r.present).length;

  const contribsTxt = ledger
    .filter(r => r.present && r.contribution !== null)
    .map(r => `${r.category}=${r.value}×${r.normalized_weight}=${r.contribution}`)
    .join(' + ');
  const missingTxt = ledger.filter(r => !r.present).map(r => r.category).join(', ') || 'none';
  const reasoning_summary = composite === null
    ? `NO CLEAR PICK — no usable layers (missing: ${missingTxt}).`
    : `composite=${composite} from ${layersPresent} layer(s): ${contribsTxt}. Missing: ${missingTxt}.`;

  return {
    composite_score: composite,
    layers_present:  layersPresent,
    evidence_ledger: ledger,
    reasoning_summary,
  };
}

// --- Total / YRFI signal derivation -----------------------------------------
// These use BOTH sides' scores to produce a combined scoring-environment signal.

export function deriveTotalSignal({ awayLedger, homeLedger, parkWeatherRecord = null }) {
  const awayPitcher    = awayLedger?.evidence_ledger?.find(r => r.category === 'starting_pitcher_signal');
  const homePitcher    = homeLedger?.evidence_ledger?.find(r => r.category === 'starting_pitcher_signal');
  const awayOffense    = awayLedger?.evidence_ledger?.find(r => r.category === 'baseline_fundamentals');
  const homeOffense    = homeLedger?.evidence_ledger?.find(r => r.category === 'baseline_fundamentals');
  const awayVolatility = awayLedger?.evidence_ledger?.find(r => r.category === 'game_volatility_context');
  const homeVolatility = homeLedger?.evidence_ledger?.find(r => r.category === 'game_volatility_context');

  const pitcherScores = [awayPitcher, homePitcher]
    .filter(r => r?.present && r.value !== null)
    .map(r => r.value);
  const offenseScores = [awayOffense, homeOffense]
    .filter(r => r?.present && r.value !== null)
    .map(r => r.value);
  const parkScore  = parkWeatherRecord?.present ? parkWeatherRecord.score : null;

  // game_volatility_context: 50=neutral, >50=high run environment, <50=suppressed
  const volatilityScores = [awayVolatility, homeVolatility]
    .filter(r => r?.present && r.value !== null)
    .map(r => r.value);
  const avgVolatility = volatilityScores.length
    ? volatilityScores.reduce((s, x) => s + x, 0) / volatilityScores.length : null;

  if (!pitcherScores.length && !offenseScores.length) {
    return { over_signal: null, under_signal: null, layers_present: 0,
      missing_note: 'no pitcher or offense layers available for total derivation' };
  }

  const avgPitcher = pitcherScores.length
    ? pitcherScores.reduce((s, x) => s + x, 0) / pitcherScores.length : 50;
  const avgOffense = offenseScores.length
    ? offenseScores.reduce((s, x) => s + x, 0) / offenseScores.length : 50;

  // net_offense > 0 means offenses beat pitchers → lean over
  const netOffense = avgOffense - avgPitcher;

  // Park modifier: park_weather_rating 50 = neutral
  const parkMod = parkScore !== null ? (parkScore - 50) * 0.4 : 0;

  // Volatility modifier: 50=neutral; high volatility pushes over, low pushes under
  const volatilityMod = avgVolatility !== null ? (avgVolatility - 50) * 0.25 : 0;

  const over_signal  = Math.round(clamp(50 + (netOffense + parkMod + volatilityMod) * 0.5, 0, 100));
  const under_signal = 100 - over_signal;

  let layersPresent = pitcherScores.length + offenseScores.length;
  if (parkScore !== null) layersPresent += 1;
  if (volatilityScores.length) layersPresent += 1;

  return {
    over_signal,
    under_signal,
    avg_pitcher_score:    Math.round(avgPitcher),
    avg_offense_score:    Math.round(avgOffense),
    park_weather_score:   parkScore,
    avg_volatility_score: avgVolatility !== null ? Math.round(avgVolatility) : null,
    layers_present: layersPresent,
    missing_note: null,
  };
}

// --- Game board composer (both sides) ---------------------------------------

export function composeEvidenceLedgerForGame({
  game,
  awaySide,
  homeSide,
  awaySeasonForm            = null,
  homeSeasonForm            = null,
  awayRecentForm            = null,
  homeRecentForm            = null,
  awayPitcherSignal         = null,
  homePitcherSignal         = null,
  awayPitcherAtPark         = null,
  homePitcherAtPark         = null,
  awayPitcherVsOpponent     = null,
  homePitcherVsOpponent     = null,
  parkWeatherRecord         = null,
  awayMatchupSplits         = null,
  homeMatchupSplits         = null,
  awayLineupInjury          = null,
  homeLineupInjury          = null,
  awayBullpenFatigue        = null,
  homeBullpenFatigue        = null,
  awayLineupHandedness      = null,
  homeLineupHandedness      = null,
  gameVolatilityRecord      = null,   // shared/neutral — same for both sides
  umpireBiasRecord          = null,   // shared/neutral — same for both sides
} = {}) {
  const awayLedger = composeEvidenceLedgerForSide({
    sideEntry:               awaySide,
    seasonFormRecord:        awaySeasonForm,
    recentFormRecord:        awayRecentForm,
    pitcherSignalRecord:     awayPitcherSignal,
    pitcherAtParkRecord:     awayPitcherAtPark,
    pitcherVsOpponentRecord: awayPitcherVsOpponent,
    parkWeatherRecord,
    matchupSplitsRecord:     awayMatchupSplits,
    lineupInjuryRecord:      awayLineupInjury,
    bullpenFatigueRecord:    awayBullpenFatigue,
    lineupHandednessRecord:  awayLineupHandedness,
    gameVolatilityRecord,
    umpireBiasRecord,
  });

  const homeLedger = composeEvidenceLedgerForSide({
    sideEntry:               homeSide,
    seasonFormRecord:        homeSeasonForm,
    recentFormRecord:        homeRecentForm,
    pitcherSignalRecord:     homePitcherSignal,
    pitcherAtParkRecord:     homePitcherAtPark,
    pitcherVsOpponentRecord: homePitcherVsOpponent,
    parkWeatherRecord,
    matchupSplitsRecord:     homeMatchupSplits,
    lineupInjuryRecord:      homeLineupInjury,
    bullpenFatigueRecord:    homeBullpenFatigue,
    lineupHandednessRecord:  homeLineupHandedness,
    gameVolatilityRecord,
    umpireBiasRecord,
  });

  const totalSignal = deriveTotalSignal({ awayLedger, homeLedger, parkWeatherRecord });

  return {
    schema_version: 'mlb_evidence_ledger_v1',
    game_pk:    game?.game_pk  ?? null,
    away_team:  game?.away_team ?? awaySide?.team_name ?? null,
    home_team:  game?.home_team ?? homeSide?.team_name ?? null,
    away: { ...awayLedger, team_name: game?.away_team ?? awaySide?.team_name ?? null },
    home: { ...homeLedger, team_name: game?.home_team ?? homeSide?.team_name ?? null },
    total_signal: totalSignal,
  };
}

// --- From-record helpers (for research-agent-adapter) -----------------------

export function buildSeasonFormRecord({ wins, losses, runDiff, gamesPlayed } = {}) {
  if (wins == null || losses == null) return { present: false, score: null, missing_reason: 'wins/losses not provided' };
  const gp = gamesPlayed ?? (wins + losses);
  if (gp < 5) return { present: false, score: null, sample_quality: 'thin', games_played: gp, missing_reason: `thin sample (${gp} games)` };
  const winPct  = wins / gp;
  const rdScore = runDiff != null ? clamp(50 + runDiff * 0.35, 0, 100) : null;
  const wpScore = clamp(winPct * 100 + 25, 0, 100);
  const score   = rdScore !== null
    ? Math.round(wpScore * 0.55 + rdScore * 0.45)
    : Math.round(wpScore);
  const sampleQuality = gp < 15 ? 'thin' : 'ok';
  return {
    present: true, score,
    source_basis: `${wins}-${losses} record (${Math.round(winPct * 100)}% win pct)${runDiff != null ? `, run diff ${runDiff > 0 ? '+' : ''}${runDiff}` : ''}`,
    sample_quality: sampleQuality,
    games_played: gp,
    detail: `${wins}W-${losses}L${runDiff != null ? `, RD${runDiff > 0 ? '+' : ''}${runDiff}` : ''}`,
  };
}

export function buildRecentFormRecord({ last10Record, last5Record, runScoringTrend } = {}) {
  // last10Record: '7-3' string or { wins, losses }
  const parseRecord = (r) => {
    if (!r) return null;
    if (typeof r === 'string') {
      const m = r.match(/^(\d+)-(\d+)/);
      return m ? { wins: Number(m[1]), losses: Number(m[2]) } : null;
    }
    return r;
  };
  const l10 = parseRecord(last10Record);
  const l5  = parseRecord(last5Record);
  if (!l10 && !l5) return { present: false, score: null, missing_reason: 'no recent form record provided' };
  const primary = l10 ?? l5;
  const gp  = primary.wins + primary.losses;
  const wp  = primary.wins / gp;
  let score = Math.round(clamp(wp * 100 + 20, 0, 100));
  // Trend modifier: if L5 and L10 both present and L5 is much better → hot streak bonus
  if (l5 && l10) {
    const l5wp  = l5.wins  / (l5.wins  + l5.losses);
    const l10wp = l10.wins / (l10.wins + l10.losses);
    if (l5wp - l10wp > 0.25) score = Math.min(100, score + 5);
    if (l10wp - l5wp > 0.25) score = Math.max(0,   score - 5);
  }
  const trendLabel = runScoringTrend ?? (wp >= 0.70 ? 'hot' : wp <= 0.30 ? 'cold' : 'neutral');
  return {
    present: true, score,
    source_basis: `L10 record: ${l10 ? `${l10.wins}-${l10.losses}` : 'n/a'}${l5 ? ` (L5: ${l5.wins}-${l5.losses})` : ''}`,
    detail: `${l10 ? `L10 ${l10.wins}-${l10.losses}` : ''} trend: ${trendLabel}`,
  };
}

export function buildPitcherSignalRecord(args = {}) {
  return buildPitcherSignalRecordSync(args);
}

// Sync version (no dynamic import) — used internally and by adapter
export function buildPitcherSignalRecordSync({
  era, fip, kPct, bbPct,
  recentQualityStarts, recentStarts,
  starterName, isBullpenGame = false,
} = {}) {
  if (isBullpenGame) {
    return { present: true, score: 32, grade: 'F',
      source_basis: 'Bullpen game confirmed — no single starter; suppression floor significantly reduced',
      detail: 'BULLPEN GAME', sample_quality: 'ok' };
  }
  if (era == null && fip == null) {
    return { present: false, score: null, missing_reason: `no ERA or FIP data${starterName ? ` for ${starterName}` : ''}` };
  }
  const scores = [];
  if (era != null) scores.push({ score: clamp(100 - (era - 2.5) * 15, 0, 100), weight: 0.45 });
  if (fip != null) scores.push({ score: clamp(100 - (fip - 2.5) * 15, 0, 100), weight: 0.25 });
  if (kPct != null) scores.push({ score: clamp(kPct * 300, 0, 100), weight: 0.20 });
  if (bbPct != null) scores.push({ score: clamp(100 - bbPct * 500, 0, 100), weight: 0.10 });
  if (!scores.length) return { present: false, score: null, missing_reason: 'pitcher stats not numeric' };
  const den = scores.reduce((s, x) => s + x.weight, 0);
  let score = Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
  if (recentQualityStarts != null && recentStarts != null && recentStarts >= 2) {
    const qsPct = recentQualityStarts / recentStarts;
    if (qsPct >= 0.80) score = Math.min(100, score + 4);
    if (qsPct <= 0.25) score = Math.max(0,   score - 6);
  }
  return {
    present: true, score,
    source_basis: `Pitcher ERA/FIP/K%/BB% composite${starterName ? ` — ${starterName}` : ''}`,
    detail: [
      starterName ?? null,
      era  != null ? `ERA ${era}` : null,
      fip  != null ? `FIP ${fip}` : null,
      kPct != null ? `K% ${Math.round(kPct * 100)}%` : null,
    ].filter(Boolean).join(', '),
    sample_quality: (recentStarts ?? 0) < 4 ? 'thin' : 'ok',
    starts: recentStarts,
  };
}

export function buildParkWeatherRecord({ parkFactor = 100, temperatureF, windMph, precipRisk = 0, venueName } = {}) {
  const { ratingFromParkWeather } = (() => {
    const clampInner = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      ratingFromParkWeather: ({ parkFactor: pf = 100, temperatureF: t, windMph: w, precipRisk: p = 0 } = {}) => {
        const park = clampInner(50 + (pf - 100) * 0.8, 0, 100);
        const scores = [{ score: park, weight: 0.55 }];
        if (t != null) scores.push({ score: clampInner(30 + (t - 55) * 0.7, 0, 100), weight: 0.25 });
        if (w != null) scores.push({ score: clampInner(50 + w * 0.3, 0, 100), weight: 0.10 });
        if (p != null) scores.push({ score: clampInner(100 - p * 80, 0, 100), weight: 0.10 });
        const den2 = scores.reduce((s, x) => s + x.weight, 0);
        return Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den2);
      },
    };
  })();
  const score = ratingFromParkWeather({ parkFactor, temperatureF, windMph, precipRisk });
  return {
    present: true, score,
    source_basis: `Park factor ${parkFactor}${venueName ? ` (${venueName})` : ''}${temperatureF != null ? `, ${temperatureF}°F` : ''}${windMph != null ? `, ${windMph}mph wind` : ''}`,
    detail: `park_factor=${parkFactor}${temperatureF != null ? `, temp=${temperatureF}°F` : ''}${windMph != null ? `, wind=${windMph}mph` : ''}${precipRisk ? `, precip=${Math.round(precipRisk * 100)}%` : ''}`,
  };
}

export function buildMatchupSplitsRecord({ pitcherVsLineupOps, h2hWins, h2hGames, platoonAdvantage } = {}) {
  const scores = [];
  if (pitcherVsLineupOps != null) {
    // Pitcher suppressing lineup: low OPS against is good for the pitching side
    // We score from the BATTING side (higher OPS against pitcher → better for hitters)
    scores.push({ score: clamp((pitcherVsLineupOps - 0.600) * 250, 0, 100), weight: 0.50 });
  }
  if (h2hWins != null && h2hGames != null && h2hGames >= 5) {
    scores.push({ score: clamp((h2hWins / h2hGames) * 100 + 10, 0, 100), weight: 0.35 });
  }
  if (platoonAdvantage != null) {
    scores.push({ score: platoonAdvantage > 0 ? 65 : 40, weight: 0.15 });
  }
  if (!scores.length) return { present: false, score: null, missing_reason: 'no matchup split data available' };
  const den = scores.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
  return {
    present: true, score,
    source_basis: 'Pitcher-vs-lineup OPS + H2H team record + platoon',
    detail: [
      pitcherVsLineupOps != null ? `OPS-against ${pitcherVsLineupOps}` : null,
      h2hWins != null && h2hGames != null ? `H2H ${h2hWins}-${h2hGames - h2hWins}` : null,
    ].filter(Boolean).join(', '),
    sample_quality: (h2hGames ?? 0) < 8 || pitcherVsLineupOps == null ? 'thin' : 'ok',
  };
}

export function buildPitcherAtParkRecord({ parkEra, parkFip, parkHr9, gamesAtPark, venueName, starterName } = {}) {
  if (parkEra == null && parkFip == null) {
    return { present: false, score: null, missing_reason: `no venue split data${starterName ? ` for ${starterName}` : ''}${venueName ? ` at ${venueName}` : ''}` };
  }
  const scores = [];
  if (parkEra != null) scores.push({ score: clamp(100 - (parkEra - 2.5) * 15, 0, 100), weight: 0.55 });
  if (parkFip != null) scores.push({ score: clamp(100 - (parkFip - 2.5) * 15, 0, 100), weight: 0.25 });
  if (parkHr9 != null) scores.push({ score: clamp(100 - parkHr9 * 40, 0, 100), weight: 0.20 });
  if (!scores.length) return { present: false, score: null, missing_reason: 'venue split stats not numeric' };
  const den = scores.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
  return {
    present: true, score,
    source_basis: `${starterName ?? 'Starter'} at ${venueName ?? 'this venue'}: ERA ${parkEra ?? 'n/a'}${parkFip != null ? `, FIP ${parkFip}` : ''}`,
    detail: [
      venueName ?? null,
      parkEra  != null ? `ERA ${parkEra}` : null,
      parkFip  != null ? `FIP ${parkFip}` : null,
      parkHr9  != null ? `HR/9 ${parkHr9}` : null,
      gamesAtPark != null ? `${gamesAtPark} GS here` : null,
    ].filter(Boolean).join(', '),
    sample_quality: (gamesAtPark ?? 0) < 3 ? 'thin' : 'ok',
  };
}

export function buildPitcherVsOpponentRecord({ vsEra, vsFip, vsKPct, wins, losses, gamesVsOpponent, opponentName, starterName } = {}) {
  if (vsEra == null && vsFip == null && vsKPct == null) {
    return { present: false, score: null, missing_reason: `no opponent split data${starterName ? ` for ${starterName}` : ''}${opponentName ? ` vs ${opponentName}` : ''}` };
  }
  const scores = [];
  if (vsEra != null)  scores.push({ score: clamp(100 - (vsEra - 2.5) * 15, 0, 100), weight: 0.40 });
  if (vsFip != null)  scores.push({ score: clamp(100 - (vsFip - 2.5) * 15, 0, 100), weight: 0.25 });
  if (vsKPct != null) scores.push({ score: clamp(vsKPct * 300, 0, 100), weight: 0.20 });
  if (wins != null && losses != null && (wins + losses) >= 3) {
    const wp = wins / (wins + losses);
    scores.push({ score: clamp(wp * 100 + 10, 0, 100), weight: 0.15 });
  }
  if (!scores.length) return { present: false, score: null, missing_reason: 'opponent split stats not numeric' };
  const den = scores.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
  return {
    present: true, score,
    source_basis: `${starterName ?? 'Starter'} vs ${opponentName ?? 'this opponent'}: ERA ${vsEra ?? 'n/a'}`,
    detail: [
      opponentName ?? null,
      vsEra  != null ? `ERA ${vsEra}` : null,
      vsFip  != null ? `FIP ${vsFip}` : null,
      vsKPct != null ? `K% ${Math.round(vsKPct * 100)}%` : null,
      wins != null && losses != null ? `${wins}-${losses} W-L` : null,
      gamesVsOpponent != null ? `${gamesVsOpponent} GS vs them` : null,
    ].filter(Boolean).join(', '),
    sample_quality: (gamesVsOpponent ?? 0) < 4 ? 'thin' : 'ok',
  };
}

// --- New layer record builders (layers 10-13) --------------------------------

export function buildBullpenFatigueRecord({
  bullpenEra, recentLoadPct,
  consecutiveHighLeverageDays = null,
  keyRelieverId = null, keyRelieverAvailable = null,
  teamName = null,
} = {}) {
  if (bullpenEra == null && recentLoadPct == null) {
    return { present: false, score: null, missing_reason: 'no bullpen fatigue data provided' };
  }
  const scores = [];
  // ERA component — low ERA = good
  if (bullpenEra != null) {
    scores.push({ score: clamp(100 - (bullpenEra - 2.5) * 14, 0, 100), weight: 0.40 });
  }
  // Load component — high recent IP load = tired bullpen = lower score
  if (recentLoadPct != null) {
    // recentLoadPct: 0-100, 0=fully rested, 100=heavily used
    scores.push({ score: clamp(100 - recentLoadPct, 0, 100), weight: 0.40 });
  }
  // Consecutive high-leverage day penalty
  if (consecutiveHighLeverageDays != null) {
    const penalty = clamp(consecutiveHighLeverageDays * 12, 0, 40);
    scores.push({ score: clamp(70 - penalty, 0, 100), weight: 0.20 });
  }
  if (!scores.length) return { present: false, score: null, missing_reason: 'bullpen stats not numeric' };
  const den = scores.reduce((s, x) => s + x.weight, 0);
  let score = Math.round(scores.reduce((s, x) => s + x.score * x.weight, 0) / den);
  // Key reliever availability: if unavailable → cap at 60
  if (keyRelieverAvailable === false) score = Math.min(score, 60);
  return {
    present: true, score,
    source_basis: `Bullpen ERA ${bullpenEra ?? 'n/a'}, load ${recentLoadPct ?? 'n/a'}%${consecutiveHighLeverageDays != null ? `, ${consecutiveHighLeverageDays} consecutive HL days` : ''}`,
    detail: [
      bullpenEra != null ? `ERA ${bullpenEra}` : null,
      recentLoadPct != null ? `load ${recentLoadPct}%` : null,
      consecutiveHighLeverageDays != null ? `HL-days ${consecutiveHighLeverageDays}` : null,
      keyRelieverAvailable === false ? 'key reliever UNAVAILABLE' : null,
    ].filter(Boolean).join(', '),
  };
}

export function buildLineupHandednessRecord({
  pitcherHand,                // 'L' | 'R' | 'S' (switch)
  lineupVsRhpOps = null,      // batting team's OPS vs RHP
  lineupVsLhpOps = null,      // batting team's OPS vs LHP
  lineupRhbPct = null,        // % of lineup right-handed batters
  lineupLhbPct = null,        // % of lineup left-handed batters
} = {}) {
  if (!pitcherHand || (lineupVsRhpOps == null && lineupVsLhpOps == null)) {
    return { present: false, score: null, missing_reason: 'pitcher hand or lineup L/R OPS splits not provided' };
  }
  // Determine which OPS splits apply to this matchup
  const relevantOps = pitcherHand === 'L' ? lineupVsLhpOps
    : pitcherHand === 'R' ? lineupVsRhpOps
    : null; // switch pitcher — use the worse of the two for safety
  const altOps = pitcherHand === 'L' ? lineupVsRhpOps : lineupVsLhpOps;

  // Score from BATTING side: higher OPS against this pitcher's hand = better for batting team
  let opsScore = null;
  if (relevantOps != null) {
    // OPS .600 → 0, .850 → 100 (linear)
    opsScore = clamp((relevantOps - 0.600) * 400, 0, 100);
  } else if (altOps != null) {
    opsScore = clamp((altOps - 0.600) * 400, 0, 100);
  }
  if (opsScore === null) return { present: false, score: null, missing_reason: 'cannot compute handedness OPS score' };
  const score = Math.round(opsScore);
  return {
    present: true, score,
    source_basis: `${pitcherHand}HP pitcher vs lineup: OPS ${relevantOps ?? altOps ?? 'n/a'} against this hand`,
    detail: [
      `pitcher=${pitcherHand}HP`,
      relevantOps != null ? `lineup-vs-${pitcherHand}HP OPS ${relevantOps}` : null,
      lineupRhbPct != null ? `RHB ${Math.round(lineupRhbPct * 100)}%` : null,
      lineupLhbPct != null ? `LHB ${Math.round(lineupLhbPct * 100)}%` : null,
    ].filter(Boolean).join(', '),
    sample_quality: (relevantOps != null || altOps != null) ? 'ok' : 'thin',
  };
}

export function buildGameVolatilityRecord({
  awayPitcherScore = null,  // from starting_pitcher_signal
  homePitcherScore = null,
  awayBullpenLoad  = null,  // recentLoadPct 0-100
  homeBullpenLoad  = null,
  parkFactor       = 100,
  temperatureF     = null,
} = {}) {
  const pitcherScores = [awayPitcherScore, homePitcherScore].filter(v => v != null);
  if (!pitcherScores.length && awayBullpenLoad == null && homeBullpenLoad == null) {
    return { present: false, score: null, missing_reason: 'no inputs available for game volatility derivation' };
  }
  // Lower pitcher quality → higher volatility
  const avgPitcher = pitcherScores.length
    ? pitcherScores.reduce((s, x) => s + x, 0) / pitcherScores.length : 50;
  const pitcherMod = clamp((50 - avgPitcher) * 0.5, -25, 25); // weak pitchers → +chaos

  // Bullpen load: high combined load → more volatile late-game
  const bullpenLoads = [awayBullpenLoad, homeBullpenLoad].filter(v => v != null);
  const avgLoad = bullpenLoads.length
    ? bullpenLoads.reduce((s, x) => s + x, 0) / bullpenLoads.length : 30;
  const bullpenMod = clamp((avgLoad - 30) * 0.15, -5, 10); // 30%=neutral, 70%=+6

  // Park: hitter-friendly pushes toward high-scoring environment
  const parkMod = clamp((parkFactor - 100) * 0.35, -15, 15);

  // Temperature: warm weather → livelier ball → more chaos
  const tempMod = temperatureF != null ? clamp((temperatureF - 70) * 0.25, -5, 8) : 0;

  const score = Math.round(clamp(50 + pitcherMod + bullpenMod + parkMod + tempMod, 0, 100));
  return {
    present: true, score,
    source_basis: `Game volatility: avg pitcher score ${Math.round(avgPitcher)}, park factor ${parkFactor}${temperatureF != null ? `, ${temperatureF}°F` : ''}`,
    detail: [
      `avg_pitcher=${Math.round(avgPitcher)}`,
      parkFactor !== 100 ? `park_factor=${parkFactor}` : null,
      temperatureF != null ? `temp=${temperatureF}°F` : null,
      bullpenLoads.length ? `avg_load=${Math.round(avgLoad)}%` : null,
    ].filter(Boolean).join(', '),
  };
}

export function buildUmpireBiasRecord({ umpireId = null } = {}) {
  // Umpire K-zone/run tendency data source not yet wired.
  // Always returns missing. Umpire data must come from an approved source adapter.
  return {
    present: false, score: null,
    missing_reason: `umpire source not wired${umpireId ? ` (umpire_id=${umpireId})` : ''} — will activate when adapter available`,
  };
}

export function buildLineupInjuryRecord({ lineupStatus, ilImpactScore, bullpenDepthScore } = {}) {
  // lineupStatus: 'confirmed' | 'pending' | 'incomplete'
  // ilImpactScore: 0-100 (100 = healthy, 0 = key players missing)
  // bullpenDepthScore: 0-100 (100 = full depth)
  if (lineupStatus == null && ilImpactScore == null) {
    return { present: false, score: null, missing_reason: 'lineup not confirmed; IL status unknown' };
  }
  const statusBonus = lineupStatus === 'confirmed' ? 5 : lineupStatus === 'pending' ? 0 : -5;
  const scores = [];
  if (ilImpactScore != null) scores.push({ score: ilImpactScore, weight: 0.55 });
  if (bullpenDepthScore != null) scores.push({ score: bullpenDepthScore, weight: 0.30 });
  scores.push({ score: clamp(50 + statusBonus * 5, 0, 100), weight: 0.15 });
  const den = scores.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(clamp(scores.reduce((s, x) => s + x.score * x.weight, 0) / den, 0, 100));
  return {
    present: true, score, lineup_status: lineupStatus ?? 'pending',
    source_basis: 'Lineup confirmation + IL impact + bullpen depth',
    detail: `lineup=${lineupStatus ?? 'pending'}, IL_health=${ilImpactScore ?? 'n/a'}, pen_depth=${bullpenDepthScore ?? 'n/a'}`,
  };
}
