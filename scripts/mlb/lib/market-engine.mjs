// Phase A — Market-internal pick engine.
//
// Pure functions. No external API calls. No lineup/weather/starter/park context.
// We only look at the Kalshi price structure for a single game's markets and
// surface CLEAR / LEAN / WATCH / PASS based on:
//
//   - CLEAR: cross-side arbitrage on a 2-sided pair (YES_A_ask + YES_B_ask < 100¢)
//            or strict ladder violations exceeding noise threshold (e.g. a higher
//            strike priced strictly above a lower strike on the same ladder),
//            confirmed on rungs whose YES/NO quotes are NOT stale.
//   - LEAN : weak ladder inversion (>= 2¢) or wide-but-priced asymmetry that
//            survives a noise cushion. We do NOT call de-vig favoritism a LEAN.
//   - WATCH: ladder is monotone and spread is wide / liquidity is thin / market
//            posted but resolution context (which we deliberately ignore here)
//            would be required for a CLEAR — OR a candidate ladder was rejected
//            because we could not unambiguously bucket it.
//   - PASS : ladder is monotone and prices are unremarkable.
//   - NO CLEAR PICK: the market is missing/unquoted entirely.
//
// Hard rules enforced in this module:
//   1. "Favorite is favored" is NEVER a CLEAR or LEAN reason.
//   2. We never assume a fair probability from a Poisson model; the only "fair"
//      we touch is the no-vig re-normalization of an *observed* 2-sided pair.
//   3. Every CLEAR/LEAN reason string names the exact market-internal evidence
//      (which strikes, which prices, the inversion size in cents).
//   4. Bucketing of multi-rung ladders (spread by team, HR/K by player) MUST
//      use stable identifiers (market ticker suffix; event ticker away/home).
//      Free-text yes_sub_title is only a tiebreaker, never the primary key.
//   5. If a market cannot be confidently assigned to one side/team/player, the
//      bucket is flagged ambiguous and any signal it produces is downgraded
//      to WATCH with reason "ambiguous market grouping".
//   6. Stale rungs (yes_ask + no_ask > 100 + STALE_OVERROUND_CENTS) do not
//      count as ladder evidence — illiquid asks fabricate inversions.

import { parseMarketTickerTeam, MLB_TEAM_BY_ABBREV } from '../../packets/lib/mlb-teams.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, DECISION_STATUSES } from '../../shared/decision-process.mjs';
import { composeBaseFundamentals } from './base-fundamentals.mjs';
import { composeEvidenceLedgerForGame } from './evidence-ledger.mjs';
import { buildFundamentalEnvelopes, buildLayerRecords } from '../source-adapters/research-agent-adapter.mjs';
import { distributionFloorMean } from './projection-contracts.mjs';

// ---- helpers ----------------------------------------------------------------

function toCents(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Inversion noise threshold in cents — anything <= this is treated as quote
// noise, not signal.
const NOISE_CENTS = 1;
const LEAN_CENTS = 2;
const CLEAR_CENTS = 4;

// Wide spread threshold for WATCH (yes_ask - yes_bid).
const WIDE_SPREAD_CENTS = 8;

// Soft-LEAN thresholds (board-internal only — no external context).
// Used to promote PASS → LEAN when liquidity + a confirming ladder agree.
const SOFT_FAV_GAP_CENTS = 10;          // favorite YES_ask - dog YES_ask must be >= this
const SOFT_OI_RATIO = 1.5;              // favorite OI / dog OI must be >= this
const SOFT_SPREAD_FAV_15_MIN_CENTS = 30; // favorite -1.5 YES_ask must be >= this to confirm
const SOFT_SPREAD_DOG_15_MAX_CENTS = 50; // dog +1.5 implied (1 - dog -1.5 ask) NO_ask must support
const SOFT_TOTAL_TILT_CENTS = 3;         // total coin-flip rung asymmetry vs 50

// Stale-quote overround threshold. yes_ask + no_ask should sum to ~100-105¢
// on a healthy 2-sided market; anything > 110¢ is a stale/illiquid ask and
// must not count as ladder evidence (it routinely fabricates "inversions").
const STALE_OVERROUND_CENTS = 10;

function isStaleRung(yesAskCents, noAskCents) {
  if (yesAskCents == null) return true;
  if (noAskCents == null) return false; // no NO side known; can't judge stale, trust YES
  return (yesAskCents + noAskCents) - 100 > STALE_OVERROUND_CENTS;
}

// ---- ML ----------------------------------------------------------------------

/**
 * Analyze the ML pair for one game.
 * Inputs: array of two markets (or one — degenerate).
 * Output: { decision, reason, evidence }
 */
export function analyzeMl(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'ML market missing for this game.' };
  }
  if (markets.length === 1) {
    return { decision: 'WATCH', reason: 'Only one side of ML is posted; pair de-vig impossible.' };
  }
  // Pick the two ML markets (typically exactly 2).
  const a = markets[0];
  const b = markets[1];
  const aYesAsk = toCents(a.yes_ask_dollars);
  const bYesAsk = toCents(b.yes_ask_dollars);
  const aYesBid = toCents(a.yes_bid_dollars);
  const bYesBid = toCents(b.yes_bid_dollars);
  if (aYesAsk == null || bYesAsk == null) {
    return { decision: 'WATCH', reason: 'ML pair missing ask quotes; cannot de-vig.' };
  }
  const sumYesAsk = aYesAsk + bYesAsk;
  // Cross-side arbitrage: pay < 100¢ to own both YES legs.
  if (sumYesAsk < 100 - CLEAR_CENTS) {
    return {
      decision: 'CLEAR',
      reason: `ML cross-side arb: YES(${a.ticker})=${aYesAsk}¢ + YES(${b.ticker})=${bYesAsk}¢ = ${sumYesAsk}¢ < 100¢.`,
      evidence: { sumYesAsk, a: aYesAsk, b: bYesAsk },
    };
  }
  if (sumYesAsk < 100) {
    return {
      decision: 'LEAN',
      reason: `ML near-arb: YES asks total ${sumYesAsk}¢ (< 100¢, within noise band).`,
      evidence: { sumYesAsk },
    };
  }
  // Wide spread → WATCH.
  const spreadA = aYesAsk != null && aYesBid != null ? aYesAsk - aYesBid : null;
  const spreadB = bYesAsk != null && bYesBid != null ? bYesAsk - bYesBid : null;
  if ((spreadA != null && spreadA > WIDE_SPREAD_CENTS) || (spreadB != null && spreadB > WIDE_SPREAD_CENTS)) {
    return {
      decision: 'WATCH',
      reason: `ML quote spread wide: ${a.ticker} ${spreadA ?? '?'}¢ / ${b.ticker} ${spreadB ?? '?'}¢ — liquidity, not edge.`,
    };
  }
  return {
    decision: 'PASS',
    reason: `ML pair fair within market: YES asks total ${sumYesAsk}¢ (overround = ${sumYesAsk - 100}¢); favoritism alone is not a pick.`,
  };
}

// ---- soft LEAN (market-internal but cross-section) -------------------------

/**
 * Pure helper: returns a soft-LEAN signal for ML when:
 *   - ML PASS (fair within market) AND
 *   - one side is the clear favorite by >= SOFT_FAV_GAP_CENTS, AND
 *   - OI ratio (fav/dog) >= SOFT_OI_RATIO, AND
 *   - that team's -1.5 spread rung YES_ask >= SOFT_SPREAD_FAV_15_MIN_CENTS
 *     (i.e. the spread ladder is not contradicting the side).
 *
 * Inputs: array of two ML markets and the bucketed spread map { team => rungs[] }.
 * Output: { side, evidence, reason } or null.
 */
export function softLeanMl(mlMarkets, spreadBuckets, eventTeams) {
  if (!mlMarkets || mlMarkets.length !== 2) return null;
  const a = mlMarkets[0]; const b = mlMarkets[1];
  const aYesAsk = toCents(a.yes_ask_dollars);
  const bYesAsk = toCents(b.yes_ask_dollars);
  if (aYesAsk == null || bYesAsk == null) return null;
  const aOi = num(a.open_interest_fp) ?? 0;
  const bOi = num(b.open_interest_fp) ?? 0;
  const fav = aYesAsk < bYesAsk ? 'b' : 'a';
  const favMk = fav === 'a' ? a : b;
  const dogMk = fav === 'a' ? b : a;
  const favAsk = fav === 'a' ? aYesAsk : bYesAsk;
  const dogAsk = fav === 'a' ? bYesAsk : aYesAsk;
  const favOi = fav === 'a' ? aOi : bOi;
  const dogOi = fav === 'a' ? bOi : aOi;
  const gap = favAsk - dogAsk;
  if (gap < SOFT_FAV_GAP_CENTS) return null;
  const oiRatio = dogOi > 0 ? favOi / dogOi : (favOi > 0 ? Infinity : 0);
  if (!Number.isFinite(oiRatio) ? favOi <= 0 : oiRatio < SOFT_OI_RATIO) return null;
  // Resolve fav team via ticker suffix (stable).
  const favTeam = parseMarketTickerTeam(favMk.ticker, favMk.event_ticker);
  if (!favTeam) return null;
  // Confirm with spread ladder: fav team's -1.5 rung YES_ask must be >= threshold.
  // We accept missing spread (cluster like ATH/LAA has no spread block at times)
  // only if OI ratio is comfortably above threshold (>= 2x) — otherwise require it.
  let spreadConfirm = 'absent';
  if (spreadBuckets && spreadBuckets.has(favTeam)) {
    const rungs = spreadBuckets.get(favTeam);
    const r15 = rungs.find((r) => r.strike === 1.5);
    if (r15 && r15.yesAsk != null) {
      if (r15.yesAsk < SOFT_SPREAD_FAV_15_MIN_CENTS) return null; // contradicts
      spreadConfirm = `${favTeam} -1.5 YES ${r15.yesAsk}¢ ≥ ${SOFT_SPREAD_FAV_15_MIN_CENTS}¢`;
    }
  } else if (oiRatio < 2) {
    return null;
  }
  return {
    side: favTeam,
    evidence: { gap, oiRatio: Number.isFinite(oiRatio) ? Math.round(oiRatio * 10) / 10 : 'inf', favOi, dogOi, spreadConfirm },
    reason: `Soft ML LEAN ${favTeam}: gap ${gap}¢ (${favAsk}¢ vs ${dogAsk}¢), OI ratio ${Number.isFinite(oiRatio) ? oiRatio.toFixed(1) : '∞'}x (${favOi.toFixed(0)} vs ${dogOi.toFixed(0)}), spread confirms (${spreadConfirm}).`,
  };
}

function maybeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function normalizeLineupStatus(status) {
  const raw = String(status ?? '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('confirmed') || raw.includes('boxscore')) return 'confirmed';
  if (raw.includes('pending')) return 'pending';
  if (raw.includes('incomplete')) return 'incomplete';
  return raw;
}

function mapPitcherSplits(pitcher) {
  if (!pitcher) return null;
  return {
    park: pitcher.at_park ? {
      era: pitcher.at_park.era ?? null,
      fip: null,
      hr9: null,
      games: pitcher.at_park.gs ?? null,
      source_path: pitcher.at_park.source_path ?? null,
    } : null,
    vsOpponent: pitcher.vs_opponent ? {
      era: pitcher.vs_opponent.era ?? null,
      fip: null,
      kPct: null,
      wins: null,
      losses: null,
      games: pitcher.vs_opponent.ip ?? null,
      span: pitcher.vs_opponent.span ?? null,
      source_path: pitcher.vs_opponent.source_path ?? null,
    } : null,
  };
}

function buildCompositeInputFromGame(game) {
  const stats = game?.stats_record ?? null;
  const weather = game?.weather_record ?? null;
  const context = game?.context_record ?? null;
  const starters = game?.starters ?? null;
  const recentForm = game?.recent_form ?? null;
  const bullpen = game?.bullpen_context ?? null;
  const matchup = game?.matchup_context ?? null;
  if (!(stats || weather || context || starters || recentForm || bullpen || matchup)) return null;

  const temperature = maybeNumber(weather?.temperature ?? weather?.temperatureF);
  const wind = maybeNumber(weather?.wind_speed ?? weather?.windMph);
  const precip = maybeNumber(weather?.precipitation_risk ?? weather?.precipRisk);
  const lineupStatus = normalizeLineupStatus(context?.lineup_status ?? game?.lineup_status ?? game?.lineup_notes);

  return {
    game_pk: game?.game_pk ?? stats?.game_pk ?? null,
    away_team: game?.away_full ?? game?.away ?? stats?.away_team ?? null,
    home_team: game?.home_full ?? game?.home ?? stats?.home_team ?? null,
    away_pitcher: starters?.away ?? stats?.away_pitcher ?? null,
    home_pitcher: starters?.home ?? stats?.home_pitcher ?? null,
    away_team_stats: recentForm?.away ?? stats?.away_team_stats ?? null,
    home_team_stats: recentForm?.home ?? stats?.home_team_stats ?? null,
    away_bullpen: bullpen?.away ?? stats?.away_bullpen ?? null,
    home_bullpen: bullpen?.home ?? stats?.home_bullpen ?? null,
    away_lineup: { status: lineupStatus, ilHealth: null },
    home_lineup: { status: lineupStatus, ilHealth: null },
    away_pitcher_splits: mapPitcherSplits(starters?.away ?? stats?.away_pitcher ?? null),
    home_pitcher_splits: mapPitcherSplits(starters?.home ?? stats?.home_pitcher ?? null),
    away_lineup_handedness: matchup?.away_handedness ?? stats?.away_lineup_handedness ?? null,
    home_lineup_handedness: matchup?.home_handedness ?? stats?.home_lineup_handedness ?? null,
    away_bullpen_fatigue: bullpen?.away ? { recentLoadPct: bullpen.away.recentLoadPct ?? null, keyRelieverAvailable: null } : null,
    home_bullpen_fatigue: bullpen?.home ? { recentLoadPct: bullpen.home.recentLoadPct ?? null, keyRelieverAvailable: null } : null,
    park: { factor: 100, name: weather?.venue ?? game?.venue ?? stats?.venue ?? null },
    weather: {
      temperatureF: temperature,
      windMph: wind,
      precipRisk: precip,
    },
    venue: weather?.venue ?? game?.venue ?? stats?.venue ?? null,
  };
}

function pickTopEvidenceRows(ledger, limit = 3) {
  return (ledger?.evidence_ledger ?? [])
    .filter((row) => row.present && row.value != null)
    .filter((row) => [
      'starting_pitcher_signal',
      'recent_form',
      'season_form',
      'park_weather_context',
      'lineup_injury_state',
      'bullpen_fatigue_availability',
      'lineup_handedness_matchup',
      'pitcher_at_this_park',
      'pitcher_vs_this_opponent',
      'matchup_splits',
      'game_volatility_context',
    ].includes(row.category))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, limit);
}

function summarizeLayer({ source, status, detail, note, availability }) {
  return {
    source,
    status,
    detail: detail ?? null,
    note: note ?? null,
    availability: availability ?? status,
  };
}

export function buildNonMarketContextBundle(game) {
  const input = buildCompositeInputFromGame(game);
  if (!input) return null;

  const envelopes = buildFundamentalEnvelopes(input);
  const fundamentals = composeBaseFundamentals({
    game: {
      game_pk: game.game_pk ?? null,
      away_team: input.away_team ?? game.away_full ?? game.away ?? null,
      home_team: input.home_team ?? game.home_full ?? game.home ?? null,
    },
    envelopes,
  });
  const layers = buildLayerRecords(input);
  const ledger = composeEvidenceLedgerForGame({
    game: {
      game_pk: game.game_pk ?? null,
      away_team: input.away_team ?? game.away_full ?? game.away ?? null,
      home_team: input.home_team ?? game.home_full ?? game.home ?? null,
    },
    awaySide: fundamentals.away,
    homeSide: fundamentals.home,
    awaySeasonForm: layers.away.seasonForm ?? null,
    homeSeasonForm: layers.home.seasonForm ?? null,
    awayRecentForm: layers.away.recentForm ?? null,
    homeRecentForm: layers.home.recentForm ?? null,
    awayPitcherSignal: layers.away.pitcherSignal ?? null,
    homePitcherSignal: layers.home.pitcherSignal ?? null,
    awayPitcherAtPark: layers.away.pitcherAtPark ?? null,
    homePitcherAtPark: layers.home.pitcherAtPark ?? null,
    awayPitcherVsOpponent: layers.away.pitcherVsOpponent ?? null,
    homePitcherVsOpponent: layers.home.pitcherVsOpponent ?? null,
    parkWeatherRecord: layers.away.parkWeather ?? null,
    awayMatchupSplits: layers.away.matchupSplits ?? null,
    homeMatchupSplits: layers.home.matchupSplits ?? null,
    awayLineupInjury: layers.away.lineupInjury ?? null,
    homeLineupInjury: layers.home.lineupInjury ?? null,
    awayBullpenFatigue: layers.away.bullpenFatigue ?? null,
    homeBullpenFatigue: layers.home.bullpenFatigue ?? null,
    awayLineupHandedness: layers.away.lineupHandedness ?? null,
    homeLineupHandedness: layers.home.lineupHandedness ?? null,
    gameVolatilityRecord: layers.away.gameVolatility ?? null,
    umpireBiasRecord: layers.away.umpireBias ?? null,
  });

  const awayScore = ledger.away?.composite_score ?? null;
  const homeScore = ledger.home?.composite_score ?? null;
  const supportSide = awayScore != null && homeScore != null
    ? (awayScore > homeScore ? 'away' : homeScore > awayScore ? 'home' : null)
    : null;
  const supportMargin = supportSide ? Math.abs(awayScore - homeScore) : null;
  const supportTeam = supportSide === 'away'
    ? (game.away_full || game.away || ledger.away?.team_name || null)
    : supportSide === 'home'
      ? (game.home_full || game.home || ledger.home?.team_name || null)
      : null;
  const topEvidence = supportSide === 'away'
    ? pickTopEvidenceRows(ledger.away)
    : supportSide === 'home'
      ? pickTopEvidenceRows(ledger.home)
      : [];
  const topEvidenceText = topEvidence.length
    ? topEvidence.map((row) => `${row.category}: ${row.detail ?? row.source_basis ?? 'n/a'}`).join('; ')
    : 'No non-market layer supplied a tested side advantage.';
  const supportReason = supportSide && supportMargin != null
    ? `Non-market evidence supports ${supportTeam} via ${topEvidenceText}`
    : 'No tested non-market side support cleared the context gate.';

  const startersPresent = Boolean(game.starters?.away || game.starters?.home);
  const lineupStatus = normalizeLineupStatus(input.away_lineup.status ?? input.home_lineup.status);
  const injuriesPresent = Boolean(game.injuries?.length || game.injury_status || game.context_record?.key_injuries?.length);
  const weatherRecord = game.weather_record ?? null;
  const contextWeather = game.context_record?.weather_from_mlb_feed ?? null;
  const roofStatus = String(
    weatherRecord?.roof_status
    ?? weatherRecord?.roof_type
    ?? game.context_record?.venue_roof_type
    ?? game.context_record?.roof_type
    ?? '',
  ).toLowerCase();
  const tempComplete = maybeNumber(weatherRecord?.temperature ?? weatherRecord?.temperatureF) != null
    && maybeNumber(weatherRecord?.wind_speed ?? weatherRecord?.windMph) != null
    && maybeNumber(weatherRecord?.precipitation_risk ?? weatherRecord?.precipRisk) != null;
  const explicitWeatherUnavailable = Boolean(
    game.context_record?.weather_status === 'unavailable'
    || (contextWeather && typeof contextWeather === 'object' && Object.keys(contextWeather).length === 0 && !weatherRecord),
  );
  const weatherStatus = tempComplete
    ? 'complete'
    : roofStatus.includes('dome') || roofStatus.includes('retractable') || roofStatus.includes('open_air')
      ? 'indoor/roof'
      : explicitWeatherUnavailable
        ? 'unavailable'
        : weatherRecord || contextWeather
        ? 'partial'
        : 'missing';
  const recentFormStatus = game.recent_form?.away && game.recent_form?.home
    ? 'complete'
    : game.recent_form
      ? 'partial'
      : 'missing';
  const bullpenStatus = game.bullpen_context?.away && game.bullpen_context?.home
    ? ((game.bullpen_context.away.recentLoadPct != null && game.bullpen_context.home.recentLoadPct != null) ? 'complete' : 'partial')
    : game.bullpen_context
      ? 'partial'
      : 'missing';
  const matchupStatus = game.matchup_context?.away_handedness || game.matchup_context?.home_handedness
    ? 'partial'
    : (game.starters?.away?.vs_opponent || game.starters?.home?.vs_opponent)
      ? 'partial'
      : 'missing';

  const contextProvenance = {
    starters: summarizeLayer({
      source: ['stats_adapter', 'mlb_official_adapter'],
      status: startersPresent
        ? (game.starters?.away?.era != null && game.starters?.home?.era != null ? 'complete' : 'partial')
        : 'missing',
      detail: startersPresent
        ? `${game.starters?.away?.name ?? 'away TBD'} vs ${game.starters?.home?.name ?? 'home TBD'}`
        : 'No starters sourced.',
    }),
    lineup: summarizeLayer({
      source: 'context_adapter',
      status: lineupStatus === 'confirmed' ? 'complete' : lineupStatus === 'pending' ? 'partial' : (lineupStatus ?? 'missing'),
      detail: lineupStatus ? `lineup_status=${lineupStatus}` : 'No lineup status sourced.',
    }),
    injuries: summarizeLayer({
      source: 'context_adapter',
      status: injuriesPresent
        ? (game.injuries?.length ? 'complete' : 'partial')
        : (game.injury_status ? 'unavailable' : 'missing'),
      detail: game.injury_status ? `injury_status=${game.injury_status}` : 'No injury news sourced.',
    }),
    weather: summarizeLayer({
      source: ['weather_adapter', 'context_adapter'],
      status: weatherStatus,
      detail: weatherRecord
        ? `${weatherRecord.temperature ?? 'n/a'}F, wind ${weatherRecord.wind_speed ?? 'n/a'}, precip ${weatherRecord.precipitation_risk ?? 'n/a'}`
        : 'No weather record sourced.',
      note: weatherRecord?.weather_note ?? null,
      availability: weatherRecord?.roof_status ?? weatherRecord?.roof_type ?? null,
    }),
    recent_form: summarizeLayer({
      source: 'stats_adapter',
      status: recentFormStatus,
      detail: game.recent_form
        ? `${game.away ?? 'away'} ${game.recent_form.away?.wins ?? '?'}-${game.recent_form.away?.losses ?? '?'} vs ${game.home ?? 'home'} ${game.recent_form.home?.wins ?? '?'}-${game.recent_form.home?.losses ?? '?'}`
        : 'No recent form sourced.',
    }),
    bullpen: summarizeLayer({
      source: 'stats_adapter',
      status: bullpenStatus,
      detail: game.bullpen_context
        ? `${game.away ?? 'away'} ERA ${game.bullpen_context.away?.era ?? '?'} / ${game.home ?? 'home'} ERA ${game.bullpen_context.home?.era ?? '?'}`
        : 'No bullpen context sourced.',
      availability: game.stats_record?.away_bullpen?.unavailable_fields?.includes('recentLoadPct') || game.stats_record?.home_bullpen?.unavailable_fields?.includes('recentLoadPct')
        ? 'partial'
        : bullpenStatus,
    }),
    matchup_model: summarizeLayer({
      source: 'stats_adapter',
      status: matchupStatus,
      detail: game.matchup_context
        ? 'Lineup handedness split sourced.'
        : (game.starters?.away?.vs_opponent || game.starters?.home?.vs_opponent)
          ? 'Pitcher vs-opponent split sourced.'
          : 'No matchup model context sourced.',
    }),
  };

  return {
    fundamentals,
    ledger,
    support_side: supportSide,
    support_team: supportTeam,
    support_margin: supportMargin,
    support_reason: supportReason,
    overall_data_quality: fundamentals.overall_data_quality,
    allowed_max_posture: fundamentals.allowed_max_posture,
    provenance: contextProvenance,
    side_scores: {
      away: awayScore,
      home: homeScore,
    },
  };
}

// ---- ladder analysis --------------------------------------------------------

/**
 * Given a list of {strike, yesAsk, ticker, label} sorted by strike ascending,
 * detect any inversion where YES rises with strike on a YES-Over style ladder.
 * Returns the worst inversion or null.
 */
export function findLadderInversion(rungs) {
  if (!rungs || rungs.length < 2) return null;
  let worst = null;
  for (let i = 1; i < rungs.length; i += 1) {
    const lo = rungs[i - 1];
    const hi = rungs[i];
    if (lo.yesAsk == null || hi.yesAsk == null) continue;
    // For YES = "OVER strike", higher strike must have YES <= lower strike YES.
    const delta = hi.yesAsk - lo.yesAsk;
    if (delta > NOISE_CENTS && (!worst || delta > worst.delta)) {
      worst = { lo, hi, delta };
    }
  }
  return worst;
}

function classifyInversion(delta) {
  if (delta >= CLEAR_CENTS) return 'CLEAR';
  if (delta >= LEAN_CENTS) return 'LEAN';
  return null;
}

// Strip stale rungs from a ladder; preserves order.
function dropStaleRungs(rungs) {
  const live = [];
  const dropped = [];
  for (const r of rungs) {
    if (isStaleRung(r.yesAsk, r.noAsk)) dropped.push(r);
    else live.push(r);
  }
  return { live, dropped };
}

// ---- stable team bucketing for spread ---------------------------------------

/**
 * Resolve a market's team abbrev using STABLE identifiers only:
 *   1. market ticker suffix (e.g. "...-PHI") via parseMarketTickerTeam
 *   2. leading uppercase letters of yes_sub_title matched against the event's
 *      known away/home abbrevs (covers "Phillies wins by..." → first letters
 *      "PHILLIES" → check prefix matches known abbrev for the event teams,
 *      then map nickname → abbrev via known full-name lookup)
 *   3. otherwise null (ambiguous)
 * `eventTeams` is { away, home } abbrevs from the joined game.
 */
function resolveSpreadTeamAbbrev(market, eventTeams) {
  // 1. stable ticker suffix
  const fromTicker = parseMarketTickerTeam(market.ticker, market.event_ticker);
  if (fromTicker) return fromTicker;
  if (!eventTeams || !eventTeams.away || !eventTeams.home) return null;
  const candidates = [eventTeams.away, eventTeams.home].filter((x) => MLB_TEAM_BY_ABBREV[x]);
  if (!candidates.length) return null;
  const text = String(market.yes_sub_title || market.title || '').toLowerCase();
  if (!text) return null;
  // 2. text fallback — match against the FULL team name OR city OR nickname
  //    for each candidate. We only accept the bucket when EXACTLY ONE
  //    candidate matches; otherwise it is ambiguous.
  const NICKNAMES = {
    ARI: ['arizona', 'diamondbacks', 'dbacks', 'd-backs'],
    AZ:  ['arizona', 'diamondbacks'],
    ATL: ['atlanta', 'braves'],
    BAL: ['baltimore', 'orioles'],
    BOS: ['boston', 'red sox', 'redsox'],
    CHC: ['chicago c', 'cubs'],
    CWS: ['chicago w', 'white sox', 'whitesox'],
    CHW: ['chicago w', 'white sox'],
    CIN: ['cincinnati', 'reds'],
    CLE: ['cleveland', 'guardians'],
    COL: ['colorado', 'rockies'],
    DET: ['detroit', 'tigers'],
    HOU: ['houston', 'astros'],
    KC:  ['kansas city', 'royals'],
    KCR: ['kansas city', 'royals'],
    LAA: ['los angeles a', 'angels', 'la angels'],
    LAD: ['los angeles d', 'dodgers', 'la dodgers'],
    MIA: ['miami', 'marlins'],
    MIL: ['milwaukee', 'brewers'],
    MIN: ['minnesota', 'twins'],
    NYM: ['new york m', 'mets'],
    NYY: ['new york y', 'yankees'],
    ATH: ['athletics', 'oakland'],
    OAK: ['oakland', 'athletics'],
    PHI: ['philadelphia', 'phillies'],
    PIT: ['pittsburgh', 'pirates'],
    SD:  ['san diego', 'padres'],
    SDP: ['san diego', 'padres'],
    SEA: ['seattle', 'mariners'],
    SF:  ['san francisco', 'giants'],
    SFG: ['san francisco', 'giants'],
    STL: ['st. louis', 'st louis', 'cardinals'],
    TB:  ['tampa bay', 'rays'],
    TBR: ['tampa bay', 'rays'],
    TEX: ['texas', 'rangers'],
    TOR: ['toronto', 'blue jays', 'bluejays'],
    WSH: ['washington', 'nationals'],
    WAS: ['washington', 'nationals'],
  };
  let matches = [];
  for (const ab of candidates) {
    const keys = NICKNAMES[ab] || [];
    if (keys.some((k) => text.includes(k))) matches.push(ab);
  }
  if (matches.length === 1) return matches[0];
  return null; // ambiguous
}

function bucketSpreadByTeam(markets, eventTeams) {
  // Returns { buckets: Map<abbrev, rungs[]>, ambiguousCount }
  const buckets = new Map();
  let ambiguous = 0;
  for (const m of markets) {
    const label = (m.yes_sub_title || m.title || m.ticker || '').trim();
    const lower = label.toLowerCase();
    const match = lower.match(/by over (\d+(?:\.\d+)?)/);
    if (!match) continue; // not a strike rung
    const strike = Number(match[1]);
    const team = resolveSpreadTeamAbbrev(m, eventTeams);
    if (!team) { ambiguous += 1; continue; }
    if (!buckets.has(team)) buckets.set(team, []);
    buckets.get(team).push({
      strike,
      yesAsk: toCents(m.yes_ask_dollars),
      noAsk: toCents(m.no_ask_dollars),
      ticker: m.ticker,
      label,
    });
  }
  for (const arr of buckets.values()) arr.sort((a, b) => a.strike - b.strike);
  return { buckets, ambiguous };
}

export function analyzeSpread(markets, gameMeta = {}) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'Spread market missing for this game.', buckets: new Map() };
  }
  const eventTeams = { away: gameMeta.away || null, home: gameMeta.home || null };
  const { buckets, ambiguous } = bucketSpreadByTeam(markets, eventTeams);
  let bestInversion = null;
  let bestTeam = null;
  let bestDropped = [];
  for (const [team, allRungs] of buckets) {
    const { live, dropped } = dropStaleRungs(allRungs);
    const inv = findLadderInversion(live);
    if (inv && (!bestInversion || inv.delta > bestInversion.delta)) {
      bestInversion = inv;
      bestTeam = team;
      bestDropped = dropped;
    }
  }
  if (bestInversion) {
    const cls = classifyInversion(bestInversion.delta);
    if (cls) {
      // If any market for this game could not be bucketed, downgrade.
      if (ambiguous > 0) {
        return {
          decision: 'WATCH',
          reason: `Spread candidate inversion for ${bestTeam} of ${bestInversion.delta}¢ downgraded: ambiguous market grouping (${ambiguous} spread market(s) could not be tied to a known team via ticker suffix or event abbrevs).`,
          evidence: { bestInversion, bestTeam, ambiguous },
          buckets,
        };
      }
      return {
        decision: cls,
        reason: `Spread ladder inverted for ${bestTeam}: ${bestInversion.hi.label} (${bestInversion.hi.yesAsk}¢) priced above ${bestInversion.lo.label} (${bestInversion.lo.yesAsk}¢) by ${bestInversion.delta}¢ — fade YES on the higher strike or buy NO.`,
        evidence: { ...bestInversion, droppedStaleCount: bestDropped.length },
        buckets,
      };
    }
  }
  if (ambiguous > 0) {
    return {
      decision: 'WATCH',
      reason: `Spread ladders monotone on stable-bucketed rungs but ${ambiguous} market(s) failed to bucket cleanly — ambiguous market grouping prevents claiming PASS.`,
      buckets,
    };
  }
  return {
    decision: 'PASS',
    reason: 'Spread ladders monotone within noise on stable-bucketed, non-stale rungs; no market-internal edge.',
    buckets,
  };
}

// ---- total / game ceiling ----------------------------------------------------

function parseTotalRungs(markets) {
  const rungs = [];
  for (const m of markets) {
    const label = (m.yes_sub_title || m.title || m.ticker || '').trim();
    const match = label.toLowerCase().match(/over (\d+(?:\.\d+)?)\s+runs?/);
    if (!match) continue;
    rungs.push({
      strike: Number(match[1]),
      yesAsk: toCents(m.yes_ask_dollars),
      noAsk: toCents(m.no_ask_dollars),
      ticker: m.ticker,
      label,
    });
  }
  rungs.sort((a, b) => a.strike - b.strike);
  return rungs;
}

export function analyzeTotal(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'Total market missing for this game.' };
  }
  const rungs = parseTotalRungs(markets);
  const { live } = dropStaleRungs(rungs);
  const inv = findLadderInversion(live);
  if (inv) {
    const cls = classifyInversion(inv.delta);
    if (cls) {
      return {
        decision: cls,
        reason: `Total ladder inverted: ${inv.hi.label} (${inv.hi.yesAsk}¢) above ${inv.lo.label} (${inv.lo.yesAsk}¢) by ${inv.delta}¢ — fade YES on the higher Over.`,
        evidence: inv,
      };
    }
  }
  return {
    decision: 'PASS',
    reason: `Total ladder monotone across ${live.length} non-stale rungs; no inversion above ${LEAN_CENTS}¢ noise.`,
  };
}

// Game total "ceiling" — purely market-internal: find the highest Over strike
// still trading >= 10¢ YES ask. This is descriptive, not predictive.
export function analyzeTotalCeiling(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', ceiling: null, reason: 'Total market missing.' };
  }
  const rungs = parseTotalRungs(markets);
  const live = rungs.filter((r) => r.yesAsk != null && r.yesAsk >= 10);
  const ceiling = live.length ? live[live.length - 1] : null;
  return {
    decision: 'PASS',
    ceiling,
    reason: ceiling
      ? `Market-implied ceiling rung: Over ${ceiling.strike} still bid at ${ceiling.yesAsk}¢ YES; above that, market prices it as tail.`
      : 'No Over rung trades >= 10¢ YES; market expects a low-scoring environment.',
  };
}

// ---- HR / K props (player ladders) -----------------------------------------

/**
 * Parse player token from a market ticker. Convention:
 *   KXMLBHR-<gameKey>-<PLAYERTOK>-<strikeOrIdx>
 *   KXMLBKS-<gameKey>-<PLAYERTOK>-<strikeOrIdx>
 * Player token is the second-to-last hyphen segment. Returns null if the
 * ticker doesn't decompose cleanly.
 */
function playerTokenFromTicker(ticker) {
  if (typeof ticker !== 'string') return null;
  const parts = ticker.split('-');
  if (parts.length < 4) return null;
  const tok = parts[parts.length - 2];
  if (!tok || !/^[A-Z]/.test(tok)) return null;
  return tok;
}

/**
 * Leading uppercase letters of the player token = the team abbreviation
 * prefix Kalshi attaches. e.g. "AZZGALLEN23" → "AZ" or "AZZ"... we extract
 * the LONGEST known abbrev that prefixes the token and matches one of the
 * event's known team abbrevs. Returns abbrev or null.
 */
function playerTokTeam(tok, eventTeams) {
  if (!tok) return null;
  const m = tok.match(/^([A-Z]+)/);
  if (!m) return null;
  const lead = m[1];
  const candidates = [eventTeams?.away, eventTeams?.home].filter(Boolean);
  // Prefer the longest candidate that prefixes the leading letters.
  let best = null;
  for (const ab of candidates) {
    if (!MLB_TEAM_BY_ABBREV[ab]) continue;
    if (lead.startsWith(ab) && (!best || ab.length > best.length)) best = ab;
  }
  return best;
}

function groupPlayerMarkets(markets, eventTeams) {
  // Returns { groups: Map<tok, {team, mks: []}>, ambiguous: number }
  const groups = new Map();
  let ambiguous = 0;
  for (const m of markets) {
    const tok = playerTokenFromTicker(m.ticker);
    if (!tok) { ambiguous += 1; continue; }
    const team = playerTokTeam(tok, eventTeams);
    if (!team) { ambiguous += 1; continue; }
    if (!groups.has(tok)) groups.set(tok, { team, mks: [] });
    groups.get(tok).mks.push(m);
  }
  return { groups, ambiguous };
}

function playerName(m) {
  const t = m.title || m.yes_sub_title || '';
  const idx = t.indexOf(':');
  if (idx > 0) return t.slice(0, idx).trim();
  return null;
}

export function analyzeHr(markets, gameMeta = {}) {
  if (!markets || markets.length === 0) {
    return { perPlayer: [], decision: 'NO CLEAR PICK', reason: 'HR market missing for this game.' };
  }
  const eventTeams = { away: gameMeta.away || null, home: gameMeta.home || null };
  const { groups, ambiguous } = groupPlayerMarkets(markets, eventTeams);
  const perPlayer = [];
  let bestLean = null;
  for (const [tok, { mks }] of groups) {
    const name = playerName(mks[0]) || tok;
    const rungs = mks
      .map((m) => ({
        strike: num(m.floor_strike),
        yesAsk: toCents(m.yes_ask_dollars),
        noAsk: toCents(m.no_ask_dollars),
        ticker: m.ticker,
        label: m.floor_strike != null ? `${m.floor_strike}+ HR` : 'HR',
      }))
      .filter((r) => r.strike != null)
      .sort((a, b) => a.strike - b.strike);
    const { live } = dropStaleRungs(rungs);
    const inv = findLadderInversion(live);
    const cls = inv ? classifyInversion(inv.delta) : null;
    if (cls) {
      const entry = {
        name, decision: cls,
        reason: `HR ladder inverted: ${inv.hi.label} ${inv.hi.yesAsk}¢ > ${inv.lo.label} ${inv.lo.yesAsk}¢ by ${inv.delta}¢.`,
      };
      perPlayer.push(entry);
      if (!bestLean || (inv.delta > (bestLean._delta ?? 0))) {
        bestLean = { ...entry, _delta: inv.delta };
      }
    } else {
      perPlayer.push({
        name, decision: 'NO CLEAR PICK',
        reason: 'HR ladder monotone on non-stale rungs; lineup/park/weather/handedness context required for any LEAN — not modeled here.',
      });
    }
  }
  // If we have a candidate signal but ambiguous markets exist, downgrade.
  if (bestLean && ambiguous > 0) {
    return {
      perPlayer,
      decision: 'WATCH',
      reason: `HR candidate signal ${bestLean.name} (${bestLean.reason}) downgraded: ambiguous market grouping (${ambiguous} HR market(s) could not be tied to a player/team via ticker).`,
    };
  }
  return {
    perPlayer,
    decision: bestLean ? bestLean.decision : 'NO CLEAR PICK',
    reason: bestLean ? `HR section best signal: ${bestLean.name} — ${bestLean.reason}` : 'No HR ladder inversion exceeds noise; no market-internal pick.',
  };
}

export function analyzeKs(markets, sideAbbrev, gameMeta = {}) {
  if (!markets || markets.length === 0) {
    return { perPitcher: [], decision: 'NO CLEAR PICK', reason: 'K-prop market missing for this game.' };
  }
  const eventTeams = { away: gameMeta.away || null, home: gameMeta.home || null };
  // Stable-side filter: only keep markets whose ticker player token maps to
  // sideAbbrev. Any market we can't bucket bumps the ambiguous counter.
  const sideMks = [];
  let ambiguous = 0;
  for (const m of markets) {
    const tok = playerTokenFromTicker(m.ticker);
    if (!tok) { ambiguous += 1; continue; }
    const team = playerTokTeam(tok, eventTeams);
    if (!team) { ambiguous += 1; continue; }
    if (team === sideAbbrev) sideMks.push(m);
  }
  if (!sideMks.length) {
    return { perPitcher: [], decision: 'NO CLEAR PICK', reason: 'Starter K ladder not posted at report time for this side.' };
  }
  const { groups } = groupPlayerMarkets(sideMks, eventTeams);
  const perPitcher = [];
  let bestLean = null;
  for (const [tok, { mks }] of groups) {
    const name = playerName(mks[0]) || tok;
    const rungs = mks
      .map((m) => ({
        strike: num(m.floor_strike),
        yesAsk: toCents(m.yes_ask_dollars),
        noAsk: toCents(m.no_ask_dollars),
        ticker: m.ticker,
        label: m.floor_strike != null ? `${m.floor_strike + 0.5}+` : 'K',
      }))
      .filter((r) => r.strike != null)
      .sort((a, b) => a.strike - b.strike);
    const { live, dropped } = dropStaleRungs(rungs);
    const inv = findLadderInversion(live);
    const cls = inv ? classifyInversion(inv.delta) : null;
    if (cls) {
      const entry = {
        name, decision: cls,
        reason: `K ladder inverted: ${inv.hi.label} ${inv.hi.yesAsk}¢ > ${inv.lo.label} ${inv.lo.yesAsk}¢ by ${inv.delta}¢ — fade YES on the higher rung.`,
        droppedStaleCount: dropped.length,
      };
      perPitcher.push(entry);
      if (!bestLean || inv.delta > (bestLean._delta ?? 0)) bestLean = { ...entry, _delta: inv.delta };
    } else {
      perPitcher.push({
        name, decision: 'WATCH',
        reason: 'K ladder monotone on non-stale rungs; projected IP, opp K% vs handedness, park, ump/weather NOT checked — required before any LEAN.',
      });
    }
  }
  if (bestLean && ambiguous > 0) {
    return {
      perPitcher,
      decision: 'WATCH',
      reason: `K candidate signal ${bestLean.name} downgraded: ambiguous market grouping (${ambiguous} K market(s) could not be tied to a player/team via ticker).`,
    };
  }
  return {
    perPitcher,
    decision: bestLean ? bestLean.decision : 'WATCH',
    reason: bestLean ? `Best K signal: ${bestLean.name} — ${bestLean.reason}` : 'K ladders monotone on non-stale rungs; context gates unchecked.',
  };
}

// ---- YFRI/NFRI --------------------------------------------------------------

export function analyzeYfri(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'YFRI/NFRI market missing.' };
  }
  const m = markets[0];
  const yesAsk = toCents(m.yes_ask_dollars);
  const noAsk = toCents(m.no_ask_dollars);
  if (yesAsk == null || noAsk == null) {
    return { decision: 'WATCH', reason: 'YFRI/NFRI quotes incomplete; cannot evaluate.' };
  }
  const sum = yesAsk + noAsk;
  if (sum < 100 - CLEAR_CENTS) {
    return {
      decision: 'CLEAR',
      reason: `YFRI/NFRI cross-side arb: YES ${yesAsk}¢ + NO ${noAsk}¢ = ${sum}¢ < 100¢.`,
    };
  }
  return {
    decision: 'PASS',
    reason: 'YFRI/NFRI single 2-sided market; without 1st-inning xWOBA, lineup top-3 hand, weather, park 1st-inning factor, no market-internal edge.',
  };
}

const FAMILY_COVERAGE_STATUSES = Object.freeze({
  NON_MARKET_COMPOSITE_READY: 'NON_MARKET_COMPOSITE_READY',
  BOARD_ANALYZER_ONLY: 'BOARD_ANALYZER_ONLY',
  BLOCKED_MODEL_LAYER_MISSING: 'BLOCKED_MODEL_LAYER_MISSING',
  PARTIAL_NEEDS_PATCH: 'PARTIAL_NEEDS_PATCH',
});

function hasNonMarketContext(bundle) {
  const provenance = bundle?.provenance ?? null;
  if (!provenance) return false;
  return Object.values(provenance).some((layer) => layer?.status && layer.status !== 'missing');
}

function familyCoverageLine(name, status, detail) {
  return `${name}: ${status}${detail ? ` — ${detail}` : ''}`;
}

function coverageDetailForModel(status, hasContext) {
  if (status === DECISION_STATUSES.EVIDENCE_LEAN || status === DECISION_STATUSES.STRONG_EVIDENCE_LEAN) {
    return 'true non-market composite is ready';
  }
  if (hasContext) {
    return 'some non-market context is sourced, but the composite is not ready yet';
  }
  return 'display-only board read; no non-market composite exists';
}

// ---------------------------------------------------------------------------
// Projection-engine wiring (price-free).
//
// The board analyzers above read market shape and are display-only. The real
// non-market composites for spread / total / YRFI / Ks come from the shared
// projection engine (scripts/mlb/lib/projection-engine.mjs), which reads ONLY
// baseball inputs and is price-guarded by the projection contracts. When a
// family's projection is non-blocked AND carries model outputs, that family is
// promoted to a modeled composite; otherwise it stays board-only/blocked.
//
// Architecture: docs/Optimal MLB Projection Architecture for CPC.pdf — ML/
// spread/total share one score engine; YRFI/Ks/HR are specialized. Provisional
// (pre-lineup) ML/spread/total/YRFI are still real modeled reads, surfaced with
// the provisional caveat. Ks blocks until starter + leash + confirmed lineup;
// HR blocks until a confirmed lineup with a per-PA rate (not in this feed), so
// HR is never promoted here.
function projHasModel(proj) {
  return Boolean(proj && proj.status !== 'blocked' && proj.outputs != null);
}

function provisionalCaveat(proj) {
  if (proj?.status !== 'provisional') return '';
  const why = [];
  if (proj.lineup_status && proj.lineup_status !== 'confirmed') why.push('lineup unconfirmed');
  if (proj.weather_status && proj.weather_status !== 'complete') why.push('weather incomplete');
  return ` (provisional${why.length ? ` — ${why.join(', ')}` : ''})`;
}

function pctText(p) {
  return (typeof p === 'number' && Number.isFinite(p)) ? `${(p * 100).toFixed(0)}%` : null;
}

// Build the override block for a family that has a real modeled composite, or
// null to fall back to the existing board-only/blocked status. Details carry
// ONLY model-derived numbers — never a market price, odds, or board line.
function modeledFamilyOverride(kind, projections) {
  if (!projections) return null;
  const mk = (detail) => ({
    status: FAMILY_COVERAGE_STATUSES.NON_MARKET_COMPOSITE_READY,
    detail,
    board_only: false,
    modeled: true,
  });
  if (kind === 'spread') {
    const s = projections.score;
    if (!projHasModel(s)) return null;
    const p = pctText(s.outputs?.runline_home_minus_1_5);
    return mk(`modeled run-line composite — home -1.5 cover ${p ?? 'n/a'} from the shared score engine; board ladder display-only, NOT IN SCORE${provisionalCaveat(s)}`);
  }
  if (kind === 'total') {
    const s = projections.score;
    if (!projHasModel(s)) return null;
    const mean = distributionFloorMean(s.outputs?.total_runs_distribution);
    const meanText = (typeof mean === 'number') ? `~${mean.toFixed(1)} projected total runs` : 'projected run environment';
    return mk(`modeled total composite — ${meanText} from the shared score engine; board ladder display-only, NOT IN SCORE${provisionalCaveat(s)}`);
  }
  if (kind === 'yfri') {
    const y = projections.yrfi;
    if (!projHasModel(y)) return null;
    const yp = pctText(y.outputs?.yrfi_prob);
    const np = pctText(y.outputs?.nrfi_prob);
    return mk(`modeled first-inning composite — YRFI ${yp ?? 'n/a'} / NRFI ${np ?? 'n/a'} (top-of-order vs starter); board display-only, NOT IN SCORE${provisionalCaveat(y)}`);
  }
  if (kind === 'ks') {
    // Promote if EITHER starter has a modeled K projection.
    const candidates = [projections.ks_home, projections.ks_away].filter(projHasModel);
    if (!candidates.length) return null;
    const means = candidates
      .map((k) => distributionFloorMean(k.outputs?.distribution))
      .filter((m) => typeof m === 'number');
    const meanText = means.length ? `~${Math.max(...means).toFixed(1)} projected Ks (top starter)` : 'projected strikeout count';
    return mk(`modeled strikeout composite — ${meanText} from the BF×K% count model; board ladder display-only, NOT IN SCORE`);
  }
  return null;
}

export function buildMarketFamilyCoverage(game, analysis = null) {
  const final = analysis?.final ?? {};
  const contextBundle = final.context_bundle ?? null;
  const hasContext = hasNonMarketContext(contextBundle);
  const mlMarkets = game?.series?.ml?.markets ?? [];
  const spreadMarkets = game?.series?.spread?.markets ?? [];
  const totalMarkets = game?.series?.total?.markets ?? [];
  const yfriMarkets = game?.series?.rfi?.markets ?? [];
  const ksMarkets = game?.series?.ks?.markets ?? [];
  const hrMarkets = game?.series?.hr?.markets ?? [];
  const mlReady = final.decision_status === DECISION_STATUSES.EVIDENCE_LEAN
    || final.decision_status === DECISION_STATUSES.STRONG_EVIDENCE_LEAN;

  const mlStatus = !mlMarkets.length
    ? FAMILY_COVERAGE_STATUSES.BLOCKED_MODEL_LAYER_MISSING
    : mlReady
      ? FAMILY_COVERAGE_STATUSES.NON_MARKET_COMPOSITE_READY
      : hasContext
        ? FAMILY_COVERAGE_STATUSES.PARTIAL_NEEDS_PATCH
        : FAMILY_COVERAGE_STATUSES.BOARD_ANALYZER_ONLY;

  const boardOnlyStatus = (markets) => (markets.length
    ? FAMILY_COVERAGE_STATUSES.BOARD_ANALYZER_ONLY
    : FAMILY_COVERAGE_STATUSES.BLOCKED_MODEL_LAYER_MISSING);

  const families = {
    ml: {
      status: mlStatus,
      label: 'ML/game-side',
      detail: coverageDetailForModel(mlReady ? DECISION_STATUSES.EVIDENCE_LEAN : final.decision_status, hasContext),
      board_only: mlStatus !== FAMILY_COVERAGE_STATUSES.NON_MARKET_COMPOSITE_READY,
      modeled: mlStatus === FAMILY_COVERAGE_STATUSES.NON_MARKET_COMPOSITE_READY,
    },
    spread: {
      status: boardOnlyStatus(spreadMarkets),
      label: 'Spread',
      detail: spreadMarkets.length
        ? 'spread ladder analyzer only; display-only board context, not a non-market composite'
        : 'spread markets missing; no board analyzer to render',
      board_only: Boolean(spreadMarkets.length),
      modeled: false,
    },
    total: {
      status: boardOnlyStatus(totalMarkets),
      label: 'Total',
      detail: totalMarkets.length
        ? 'total ladder analyzer only; display-only board context, not a non-market composite'
        : 'total markets missing; no board analyzer to render',
      board_only: Boolean(totalMarkets.length),
      modeled: false,
    },
    yfri: {
      status: boardOnlyStatus(yfriMarkets),
      label: 'YFRI/NRFI',
      detail: yfriMarkets.length
        ? 'first-inning board analyzer only; display-only board context, not a non-market composite'
        : 'first-inning market missing; no board analyzer to render',
      board_only: Boolean(yfriMarkets.length),
      modeled: false,
    },
    ks: {
      status: boardOnlyStatus(ksMarkets),
      label: 'Ks props',
      detail: ksMarkets.length
        ? 'K ladder analyzer only; display-only board context, not a non-market composite'
        : 'K markets missing; no board analyzer to render',
      board_only: Boolean(ksMarkets.length),
      modeled: false,
    },
    hr: {
      status: boardOnlyStatus(hrMarkets),
      label: 'HR props',
      detail: hrMarkets.length
        ? 'HR ladder analyzer only; display-only board context, not a non-market composite'
        : 'HR markets missing; no board analyzer to render',
      board_only: Boolean(hrMarkets.length),
      modeled: false,
    },
  };

  // Promote families that carry a real modeled (non-market) composite from the
  // projection engine. Board analyzers stay display-only behind them. ML is
  // intentionally left to its own decision_status path; HR is never promoted
  // here (no per-PA rate input in this feed → stays honestly blocked).
  const projections = final.projections ?? null;
  if (projections) {
    for (const kind of ['spread', 'total', 'yfri', 'ks']) {
      const override = modeledFamilyOverride(kind, projections);
      if (override) families[kind] = { ...families[kind], ...override };
    }
  }

  const hasFullCoverage = Object.values(families).every((family) => family.status === FAMILY_COVERAGE_STATUSES.NON_MARKET_COMPOSITE_READY);
  const coverageMode = hasFullCoverage ? 'FULL' : 'LIMITED';
  const summary = [
    familyCoverageLine(families.ml.label, families.ml.status, families.ml.detail),
    familyCoverageLine(families.spread.label, families.spread.status, families.spread.detail),
    familyCoverageLine(families.total.label, families.total.status, families.total.detail),
    familyCoverageLine(families.yfri.label, families.yfri.status, families.yfri.detail),
    familyCoverageLine(families.ks.label, families.ks.status, families.ks.detail),
    familyCoverageLine(families.hr.label, families.hr.status, families.hr.detail),
  ].join('; ');

  return {
    mode: coverageMode,
    has_full_coverage: hasFullCoverage,
    families,
    summary,
  };
}

// ---- whole-game aggregation -------------------------------------------------

export function analyzeGame(game, { projections = null } = {}) {
  const gameMeta = { away: game.away, home: game.home };
  const mlAnalysis = analyzeMl(game.series.ml?.markets || []);
  const spreadAnalysis = analyzeSpread(game.series.spread?.markets || [], gameMeta);
  const totalAnalysis = analyzeTotal(game.series.total?.markets || []);
  const ceilingAnalysis = analyzeTotalCeiling(game.series.total?.markets || []);
  const hrAnalysis = analyzeHr(game.series.hr?.markets || [], gameMeta);
  const ksAwayAnalysis = analyzeKs(game.series.ks?.markets || [], game.away, gameMeta);
  const ksHomeAnalysis = analyzeKs(game.series.ks?.markets || [], game.home, gameMeta);
  const yfriAnalysis = analyzeYfri(game.series.rfi?.markets || []);
  const contextBundle = buildNonMarketContextBundle(game);

  // Soft-LEAN promotion: if ML is PASS, check liquidity+spread confirmation.
  // K/HR are intentionally NOT promoted — they require external context gates.
  if (mlAnalysis.decision === 'PASS') {
    const soft = softLeanMl(game.series.ml?.markets || [], spreadAnalysis.buckets, gameMeta);
    if (soft) {
      mlAnalysis.decision = 'LEAN';
      mlAnalysis.reason = soft.reason;
      mlAnalysis.tier = 'soft';
      mlAnalysis.side = soft.side;
      mlAnalysis.evidence = soft.evidence;
    }
  }

  // Game-level sections drive the headline pick. HR/K ladder anomalies are
  // *not* game picks — they require lineup/usage/handedness/park gates we do
  // not pull, so they always land in prop_watchlist regardless of CLEAR/LEAN
  // strength.
  const gameLevelSections = [
    { name: 'ML', sec: mlAnalysis },
    { name: 'Spread', sec: spreadAnalysis },
    { name: 'Total', sec: totalAnalysis },
    { name: 'YFRI', sec: yfriAnalysis },
  ];
  const gameClearLean = gameLevelSections.filter((s) => s.sec.decision === 'CLEAR' || s.sec.decision === 'LEAN');
  const gameClears = gameClearLean.filter((s) => s.sec.decision === 'CLEAR');
  const gameLeans = gameClearLean.filter((s) => s.sec.decision === 'LEAN');

  let finalDecision = 'NO CLEAR PICK';
  let finalReason = 'No game-level section (ML / spread / total / YFRI) produced a market-internal CLEAR or LEAN; modeled fair-value / lineup / weather / starter context required for further calls.';
  let bestAngle = 'NO CLEAR PICK';
  let bestSource = null;
  if (gameClears.length) {
    finalDecision = 'CLEAR';
    finalReason = gameClears[0].sec.reason;
    bestAngle = gameClears[0].sec.reason;
    bestSource = gameClears[0].name;
  } else if (gameLeans.length) {
    finalDecision = 'LEAN';
    finalReason = gameLeans[0].sec.reason;
    bestAngle = gameLeans[0].sec.reason;
    bestSource = gameLeans[0].name;
  }

  const marketSideTeam = mlAnalysis.side ?? null;
  const supportTeam = contextBundle?.support_team ?? null;
  const supportMatchesMarket = Boolean(
    contextBundle?.support_side
    && contextBundle.support_margin != null
    && contextBundle.support_margin >= 5
    && contextBundle.overall_data_quality === 'ok'
    && marketSideTeam
    && (
      (contextBundle.support_side === 'away' && marketSideTeam === (game.away ?? game.away_full))
      || (contextBundle.support_side === 'home' && marketSideTeam === (game.home ?? game.home_full))
    ),
  );
  const marketSignalReason = gameLeans.length
    ? gameLeans[0].sec.reason
    : gameClears.length
      ? gameClears[0].sec.reason
      : 'No game-level CLEAR/LEAN from board structure.';

  if (finalDecision === 'CLEAR' || finalDecision === 'LEAN') {
    finalReason = supportMatchesMarket
      ? contextBundle.support_reason
      : 'Board signal only, not evidence, not a pick.';
    bestAngle = finalReason;
  }

  // Prop watchlist: HR/K CLEAR/LEAN entries are demoted to WATCH-tier alerts.
  // They never count toward game-level CLEAR/LEAN totals or the slate
  // headline. They surface as "MARKET ANOMALY" reads requiring further gates.
  const propAlerts = [];
  for (const p of hrAnalysis.perPlayer || []) {
    if (p.decision === 'CLEAR' || p.decision === 'LEAN') {
      propAlerts.push({ kind: 'HR', name: p.name, raw_decision: p.decision, decision: 'WATCH', reason: p.reason });
    }
  }
  for (const side of [{ side: 'away', a: ksAwayAnalysis }, { side: 'home', a: ksHomeAnalysis }]) {
    for (const p of side.a.perPitcher || []) {
      if (p.decision === 'CLEAR' || p.decision === 'LEAN') {
        propAlerts.push({ kind: 'K', side: side.side, name: p.name, raw_decision: p.decision, decision: 'WATCH', reason: p.reason });
      }
    }
  }

  const hasMarketBoard = Object.values(game.series || {}).some((series) => Array.isArray(series?.markets) && series.markets.length > 0);
  const hasLineupNews = Boolean(
    (contextBundle?.provenance?.lineup?.status && contextBundle.provenance.lineup.status !== 'missing')
      || (contextBundle?.provenance?.injuries?.status && contextBundle.provenance.injuries.status !== 'missing')
      || game.lineups || game.lineup_notes || game.injuries || game.injury_notes || game.news_context,
  );
  const hasVenueContext = Boolean(
    (contextBundle?.provenance?.weather?.status && contextBundle.provenance.weather.status !== 'missing')
      || game.weather || game.venue || game.park_context || game.weather_context,
  );
  const hasRecentMatchup = Boolean(
    (contextBundle?.provenance?.recent_form?.status && contextBundle.provenance.recent_form.status !== 'missing')
      || (contextBundle?.provenance?.matchup_model?.status && contextBundle.provenance.matchup_model.status !== 'missing')
      || (contextBundle?.provenance?.bullpen?.status && contextBundle.provenance.bullpen.status !== 'missing')
      || game.recent_form || game.matchup_context || game.bullpen_context || game.history_context,
  );
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: finalDecision,
    checked: {
      projected_participants: Boolean(game.away && game.home),
      lineup_injury_news: hasLineupNews,
      venue_context: hasVenueContext,
      recent_form_matchup: hasRecentMatchup,
      market_board_context: hasMarketBoard,
      evidence_supported_side: supportMatchesMarket,
    },
    hasMarketSignal: gameClearLean.length > 0,
    topEvidence: finalDecision === 'CLEAR' || finalDecision === 'LEAN'
      ? [finalReason]
      : [],
    marketSignalText: gameClearLean.length ? marketSignalReason : 'No game-level CLEAR/LEAN from board structure.',
    verifiedFacts: [
      game.away && game.home ? `${game.away} at ${game.home}` : null,
      contextBundle?.support_team ? `Non-market context reviewed: ${contextBundle.support_reason}` : null,
      hasLineupNews ? `Lineup/news provenance: ${contextBundle?.provenance?.lineup?.status ?? 'missing'}` : null,
      hasVenueContext ? `Venue/weather provenance: ${contextBundle?.provenance?.weather?.status ?? 'missing'}` : null,
      hasRecentMatchup ? `Recent-form/matchup provenance: ${contextBundle?.provenance?.recent_form?.status ?? 'missing'}` : null,
    ].filter(Boolean),
    settlementRules: 'MLB game settlement rules not independently pulled by this report.',
    inference: (finalDecision === 'CLEAR' || finalDecision === 'LEAN')
      ? (supportMatchesMarket
        ? 'Non-market evidence and board signal agree on the same side.'
        : 'Board signal only unless lineup, starter, venue, and matchup context are all checked.')
      : 'No board signal strong enough to elevate.',
    skepticReview: hasLineupNews && hasVenueContext && hasRecentMatchup
      ? (supportMatchesMarket
        ? 'Context inputs present and non-market support cleared the gate.'
        : 'Context inputs present, but they did not test into the same side as the market signal.')
      : 'MISSING: report does not pull lineup, starter, venue/weather, or recent form context.',
    finalJudgment: (finalDecision === 'CLEAR' || finalDecision === 'LEAN')
      ? (supportMatchesMarket
        ? `Real-world MLB context supports ${supportTeam}; market signal stays display-only.`
        : 'Downgrade raw CLEAR/LEAN to MARKET-ONLY LEAN until real-world MLB context supports the same side.')
      : 'NO CLEAR PICK.',
    wouldChangeView: [
      'Confirmed lineups and starters support the same side.',
      'Weather/park and recent matchup context support the same side.',
      'Board signal disappears or contradicts updated domain context.',
    ],
  });
  const coverage = buildMarketFamilyCoverage(game, {
    final: {
      decision_status: process.decisionStatus,
      context_bundle: contextBundle,
      projections,
    },
  });
  if (finalDecision === 'NO CLEAR PICK') {
    finalReason = coverage.mode === 'LIMITED'
      ? 'Limited coverage: only the ML/game-side family has a modeled composite; spread, total, YFRI/NRFI, Ks, and HR remain board-only or blocked.'
      : finalReason;
  }

  return {
    sections: {
      ml: mlAnalysis,
      spread: spreadAnalysis,
      total: totalAnalysis,
      ceiling: ceilingAnalysis,
      hr: hrAnalysis,
      ks_away: ksAwayAnalysis,
      ks_home: ksHomeAnalysis,
      yfri: yfriAnalysis,
    },
    final: {
      decision: finalDecision,            // game-level only (back-compat)
      decision_status: process.decisionStatus,
      decision_process: process,
      reason: finalReason,
      market_reason: marketSignalReason,
      best_angle: bestAngle,
      best_source: bestSource,
      game_pick_decision: finalDecision,
      prop_watchlist: propAlerts,
      context_bundle: contextBundle,
      projections,
      coverage,
    },
    clear_lean_count: gameClearLean.length, // game-level only
    prop_alert_count: propAlerts.length,
  };
}

export function aggregateClusterAnalyses(gameAnalyses) {
  let total = 0;
  const items = [];
  for (const ga of gameAnalyses) {
    total += ga.analysis.clear_lean_count;
    if (ga.analysis.clear_lean_count > 0) {
      items.push({ matchup: ga.matchup, final: ga.analysis.final, sections: ga.analysis.sections });
    }
  }
  return { clear_lean_total: total, items };
}

export const _internal = {
  NOISE_CENTS, LEAN_CENTS, CLEAR_CENTS, WIDE_SPREAD_CENTS, STALE_OVERROUND_CENTS,
  isStaleRung, resolveSpreadTeamAbbrev, playerTokenFromTicker, playerTokTeam,
};
