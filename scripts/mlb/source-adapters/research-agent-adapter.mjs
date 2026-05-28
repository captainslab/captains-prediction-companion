// Research-agent adapter for the MLB composite model.
//
// Converts the structured output from a research agent (pitcher stats,
// team records, park/weather) into the four fundamental-layer envelopes
// that base-fundamentals.mjs expects.
//
// Input shape (from agent pick-card data):
//   {
//     game_pk, away_team, home_team,
//     away_pitcher: { name, era, fip, kPct, bbPct, recentQualityStarts, recentStarts, isBullpenGame },
//     home_pitcher: { ... same ... },
//     away_team_stats: { wins, losses, runDiff, ops, last10, last5 },
//     home_team_stats: { ... same ... },
//     away_bullpen: { era, recentLoadPct },
//     home_bullpen: { ... same ... },
//     park: { factor, venueName },
//     weather: { temperatureF, windMph, precipRisk },
//   }
//
// Returns: { pitcher_quality, team_offense, bullpen_quality, park_weather }
// — each a valid source-adapter envelope that base-fundamentals.mjs accepts.

import {
  ratingFromPitcherStats,
  ratingFromTeamStats,
  ratingFromBullpenStats,
  ratingFromParkWeather,
} from '../lib/base-fundamentals.mjs';

import {
  buildSeasonFormRecord,
  buildRecentFormRecord,
  buildPitcherSignalRecordSync,
  buildPitcherAtParkRecord,
  buildPitcherVsOpponentRecord,
  buildParkWeatherRecord,
  buildMatchupSplitsRecord,
  buildLineupInjuryRecord,
  buildBullpenFatigueRecord,
  buildLineupHandednessRecord,
  buildGameVolatilityRecord,
  buildUmpireBiasRecord,
} from '../lib/evidence-ledger.mjs';

function now() { return new Date().toISOString(); }

function makeEnvelope(source_id, status, records, notes = []) {
  return {
    source_id,
    status,
    source_status: status,
    checked_at_utc: now(),
    records,
    source_notes: notes,
    source_urls: [],
  };
}

function parseRecord(r) {
  if (!r) return null;
  if (typeof r === 'string') {
    const m = r.match(/^(\d+)-(\d+)/);
    return m ? { wins: Number(m[1]), losses: Number(m[2]) } : null;
  }
  return r;
}

// --- Pitcher quality envelope -----------------------------------------------

function buildPitcherQualityEnvelope(input) {
  const records = [];
  for (const side of ['away', 'home']) {
    const p = input[`${side}_pitcher`];
    if (!p) continue;
    const rating = ratingFromPitcherStats({
      era: p.era, fip: p.fip, kPct: p.kPct, bbPct: p.bbPct,
    });
    if (p.isBullpenGame) {
      records.push({
        side,
        team_name: input[`${side}_team`] ?? null,
        pitcher_name: 'BULLPEN GAME',
        pitcher_id: null,
        pitcher_quality_rating: 32,
        is_bullpen_game: true,
        era: null, fip: null, k_pct: null, bb_pct: null,
        source_notes: ['Bullpen game — no single starter confirmed'],
      });
    } else {
      records.push({
        side,
        team_name: input[`${side}_team`] ?? null,
        pitcher_name: p.name ?? null,
        pitcher_id:   p.id   ?? null,
        pitcher_quality_rating: rating,
        is_bullpen_game: false,
        era:   p.era   ?? null,
        fip:   p.fip   ?? null,
        k_pct: p.kPct  ?? null,
        bb_pct: p.bbPct ?? null,
        recent_quality_starts: p.recentQualityStarts ?? null,
        recent_starts:         p.recentStarts ?? null,
      });
    }
  }
  return makeEnvelope(
    'research_agent_pitcher_quality',
    records.length > 0 ? 'ok' : 'unavailable',
    records,
    ['Sourced from research-agent pick-card data'],
  );
}

// --- Team offense envelope --------------------------------------------------

function buildTeamOffenseEnvelope(input) {
  const records = [];
  for (const side of ['away', 'home']) {
    const ts = input[`${side}_team_stats`];
    if (!ts) continue;
    const wins   = ts.wins;
    const losses = ts.losses;
    const gp     = ts.gamesPlayed ?? (wins != null && losses != null ? wins + losses : null);
    const winPct = wins != null && gp ? wins / gp : null;
    const l10    = parseRecord(ts.last10);
    const last10WinPct = l10 ? l10.wins / (l10.wins + l10.losses) : null;
    const rating = ratingFromTeamStats({
      winPct,
      runDiff:     ts.runDiff    ?? ts.run_diff ?? null,
      ops:         ts.ops        ?? null,
      last10WinPct,
    });
    records.push({
      side,
      team_name:          input[`${side}_team`] ?? null,
      team_offense_rating: rating,
      wins, losses,
      win_pct:   winPct != null ? Math.round(winPct * 1000) / 1000 : null,
      run_diff:  ts.runDiff ?? ts.run_diff ?? null,
      ops:       ts.ops ?? null,
      last_10:   ts.last10 ?? null,
      last_5:    ts.last5  ?? null,
    });
  }
  return makeEnvelope(
    'research_agent_team_offense',
    records.length > 0 ? 'ok' : 'unavailable',
    records,
  );
}

// --- Bullpen quality envelope -----------------------------------------------

function buildBullpenQualityEnvelope(input) {
  const records = [];
  for (const side of ['away', 'home']) {
    const b = input[`${side}_bullpen`];
    if (!b) continue;
    const rating = ratingFromBullpenStats({
      bullpenEra:        b.era ?? null,
      recentIpLoadPct:   b.recentLoadPct ?? null,
    });
    if (rating === null) continue;
    records.push({
      side,
      team_name:             input[`${side}_team`] ?? null,
      bullpen_quality_rating: rating,
      bullpen_era:            b.era ?? null,
      recent_load_pct:        b.recentLoadPct ?? null,
    });
  }
  const status = records.length > 0 ? 'ok' : 'unavailable';
  return makeEnvelope('research_agent_bullpen_quality', status, records);
}

// --- Park / weather envelope ------------------------------------------------

function buildParkWeatherEnvelope(input) {
  const park    = input.park    ?? {};
  const weather = input.weather ?? {};
  const parkFactor  = park.factor   ?? 100;
  const venueName   = park.name ?? park.venueName ?? input.venue ?? null;
  const tempF       = weather.temperatureF ?? weather.temp_f ?? null;
  const windMph     = weather.windMph  ?? weather.wind_mph   ?? null;
  const precipRisk  = weather.precipRisk ?? weather.precip_risk ?? 0;
  const rating = ratingFromParkWeather({ parkFactor, temperatureF: tempF, windMph, precipRisk });
  const records = [{
    side: 'neutral',
    venue_name:        venueName,
    park_factor:       parkFactor,
    park_weather_rating: rating,
    temperature_f:     tempF,
    wind_mph:          windMph,
    precip_risk:       precipRisk,
  }];
  return makeEnvelope('research_agent_park_weather', 'ok', records);
}

// --- Layer record builders (for evidence-ledger.mjs) ------------------------

export function buildLayerRecords(input) {
  const result = { away: {}, home: {} };

  for (const side of ['away', 'home']) {
    const ts = input[`${side}_team_stats`];
    const p  = input[`${side}_pitcher`];
    const b  = input[`${side}_bullpen`];
    const sp = input[`${side}_splits`] ?? null;
    const li = input[`${side}_lineup`] ?? null;

    // Season form
    if (ts) {
      result[side].seasonForm = buildSeasonFormRecord({
        wins:        ts.wins,
        losses:      ts.losses,
        runDiff:     ts.runDiff ?? ts.run_diff,
        gamesPlayed: ts.gamesPlayed,
      });
    }

    // Recent form
    if (ts) {
      result[side].recentForm = buildRecentFormRecord({
        last10Record: ts.last10,
        last5Record:  ts.last5,
        runScoringTrend: ts.trend ?? null,
      });
    }

    // Pitcher signal
    if (p) {
      result[side].pitcherSignal = buildPitcherSignalRecordSync({
        era:                  p.era,
        fip:                  p.fip,
        kPct:                 p.kPct,
        bbPct:                p.bbPct,
        recentQualityStarts:  p.recentQualityStarts,
        recentStarts:         p.recentStarts,
        starterName:          p.name,
        isBullpenGame:        p.isBullpenGame ?? false,
        fipSource:            p.fip_source ?? null,
        eraSource:            p.era_source ?? null,
      });
    }

    // Game-specific pitcher layers
    const ps = input[`${side}_pitcher_splits`] ?? null;
    if (ps?.park) {
      result[side].pitcherAtPark = buildPitcherAtParkRecord({
        parkEra:     ps.park.era,
        parkFip:     ps.park.fip,
        parkHr9:     ps.park.hr9,
        gamesAtPark: ps.park.games,
        venueName:   input.park?.name ?? input.venue ?? null,
        starterName: p?.name ?? null,
        sourcePath:  ps.park.source_path ?? null,
      });
    }
    if (ps?.vsOpponent) {
      result[side].pitcherVsOpponent = buildPitcherVsOpponentRecord({
        vsEra:           ps.vsOpponent.era,
        vsFip:           ps.vsOpponent.fip,
        vsKPct:          ps.vsOpponent.kPct,
        wins:            ps.vsOpponent.wins,
        losses:          ps.vsOpponent.losses,
        gamesVsOpponent: ps.vsOpponent.games,
        opponentName:    side === 'away' ? input.home_team : input.away_team,
        starterName:     p?.name ?? null,
        sourcePath:      ps.vsOpponent.source_path ?? null,
        span:            ps.vsOpponent.span ?? null,
      });
    }

    // Matchup splits
    if (sp) {
      result[side].matchupSplits = buildMatchupSplitsRecord({
        pitcherVsLineupOps: sp.pitcherVsLineupOps,
        h2hWins:            sp.h2hWins,
        h2hGames:           sp.h2hGames,
        platoonAdvantage:   sp.platoonAdvantage,
      });
    }

    // Lineup / injury state
    if (li) {
      result[side].lineupInjury = buildLineupInjuryRecord({
        lineupStatus:     li.status    ?? 'pending',
        ilImpactScore:    li.ilHealth  ?? null,
        bullpenDepthScore: b ? ratingFromBullpenStats({ bullpenEra: b.era }) : null,
      });
    }

    // Bullpen fatigue / availability (layer 10)
    if (b) {
      const bf = input[`${side}_bullpen_fatigue`] ?? null;
      result[side].bullpenFatigue = buildBullpenFatigueRecord({
        bullpenEra:                   b.era              ?? null,
        recentLoadPct:                b.recentLoadPct    ?? null,
        consecutiveHighLeverageDays:  bf?.consecutiveHLDays ?? null,
        keyRelieverAvailable:         bf?.keyRelieverAvailable ?? null,
        teamName:                     input[`${side}_team`] ?? null,
      });
    }

    // Lineup handedness matchup (layer 11)
    const lh = input[`${side}_lineup_handedness`] ?? null;
    if (p && lh) {
      result[side].lineupHandedness = buildLineupHandednessRecord({
        pitcherHand:    p.hand ?? null,
        lineupVsRhpOps: lh.vsRhpOps ?? null,
        lineupVsLhpOps: lh.vsLhpOps ?? null,
        lineupRhbPct:   lh.rhbPct   ?? null,
        lineupLhbPct:   lh.lhbPct   ?? null,
      });
    }
  }

  // Park / weather (shared)
  const pw = input.park ?? input.weather ? {
    ...(input.park    ? { factor: input.park.factor, venueName: input.park.name } : {}),
    ...(input.weather ? input.weather : {}),
  } : null;
  if (pw) {
    const rec = buildParkWeatherRecord({
      parkFactor:    pw.factor  ?? 100,
      temperatureF:  pw.temperatureF ?? pw.temp_f,
      windMph:       pw.windMph ?? pw.wind_mph,
      precipRisk:    pw.precipRisk ?? pw.precip_risk ?? 0,
      venueName:     pw.venueName ?? pw.name,
    });
    result.away.parkWeather = rec;
    result.home.parkWeather = rec;
  }

  // Game volatility (layer 12) — derived from both pitchers + bullpen + park + temp
  // Automatically computed when pitcher signals and park info are available.
  const awayPS = result.away.pitcherSignal;
  const homePS = result.home.pitcherSignal;
  const awayB  = input.away_bullpen;
  const homeB  = input.home_bullpen;
  const gvRec = buildGameVolatilityRecord({
    awayPitcherScore: awayPS?.score ?? null,
    homePitcherScore: homePS?.score ?? null,
    awayBullpenLoad:  awayB?.recentLoadPct ?? null,
    homeBullpenLoad:  homeB?.recentLoadPct ?? null,
    parkFactor:       input.park?.factor ?? 100,
    temperatureF:     input.weather?.temperatureF ?? input.weather?.temp_f ?? null,
  });
  result.away.gameVolatility = gvRec;
  result.home.gameVolatility = gvRec;

  // Umpire bias (layer 13) — always missing stub
  const umpireRec = buildUmpireBiasRecord({ umpireId: input.umpire_id ?? null });
  result.away.umpireBias = umpireRec;
  result.home.umpireBias = umpireRec;

  return result;
}

// --- Main export ------------------------------------------------------------

export function buildFundamentalEnvelopes(input) {
  return {
    pitcher_quality: buildPitcherQualityEnvelope(input),
    team_offense:    buildTeamOffenseEnvelope(input),
    bullpen_quality: buildBullpenQualityEnvelope(input),
    park_weather:    buildParkWeatherEnvelope(input),
  };
}
