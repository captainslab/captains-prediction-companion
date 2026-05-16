// MLB market scoring core.
// Classifies Kalshi markets based on evidence from all source adapters.
// No automated trade execution. No bet placement.

const WEATHER_SENSITIVE_LANES = new Set(['game_total', 'yrfi_nrfi', 'home_run_hitter']);

const VALID_STATUSES = new Set(['ok', 'degraded', 'blocked', 'skipped']);

/**
 * Returns envelope.status if it is one of ok/degraded/blocked/skipped, else 'blocked'.
 * @param {object} envelope
 * @returns {'ok'|'degraded'|'blocked'|'skipped'}
 */
export function sourceStatus(envelope) {
  const status = envelope?.status;
  return VALID_STATUSES.has(status) ? status : 'blocked';
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Returns true if any adapter envelope has a warning matching /fixture mode/i.
 */
function detectFixtureMode({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  const allEnvelopes = [kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context];
  return allEnvelopes.some(envelope =>
    safeArray(envelope?.warnings).some(warning => /fixture mode/i.test(warning)),
  );
}

/**
 * Find the sportsbook record that matches a Kalshi event record.
 * Tries exact team name match first, then case-insensitive substring matching.
 *
 * @param {{ away_team?: string, home_team?: string, matched_game?: string }} record
 * @param {object[]} sportsbookRecords
 * @returns {object|null}
 */
function findSportsbookRecord(record, sportsbookRecords) {
  if (!Array.isArray(sportsbookRecords) || sportsbookRecords.length === 0) return null;

  const awayTeam = record.away_team ?? '';
  const homeTeam = record.home_team ?? '';

  // Exact match first
  if (awayTeam || homeTeam) {
    const exact = sportsbookRecords.find(
      r => r.away_team === awayTeam && r.home_team === homeTeam,
    );
    if (exact) return exact;
  }

  // Case-insensitive substring match
  if (awayTeam || homeTeam) {
    const awayLower = awayTeam.toLowerCase();
    const homeLower = homeTeam.toLowerCase();
    const substr = sportsbookRecords.find(r => {
      const rAway = (r.away_team ?? '').toLowerCase();
      const rHome = (r.home_team ?? '').toLowerCase();
      return (
        (awayLower && (rAway.includes(awayLower) || awayLower.includes(rAway))) &&
        (homeLower && (rHome.includes(homeLower) || homeLower.includes(rHome)))
      );
    });
    if (substr) return substr;
  }

  // Fall back to matched_game string comparison
  const matchedGame = record.matched_game ?? '';
  if (matchedGame) {
    const gameLower = matchedGame.toLowerCase();
    const gameMatch = sportsbookRecords.find(r => {
      const rGame = (r.game ?? r.game_name ?? '').toLowerCase();
      return rGame && (rGame.includes(gameLower) || gameLower.includes(rGame));
    });
    if (gameMatch) return gameMatch;
  }

  return null;
}

/**
 * Calculate edge and fair value for moneyline markets.
 * Returns { edge_pp, fair_value } or { edge_pp: null, fair_value: null }.
 */
function calcMoneylineEdge(market, sbRecord) {
  if (!sbRecord) return { edge_pp: null, fair_value: null };

  let fair_value = null;
  const teamSide = market.team_side ?? inferTeamSide(market, sbRecord);

  if (teamSide === 'away') {
    fair_value = sbRecord.away_no_vig_fair ?? null;
  } else if (teamSide === 'home') {
    fair_value = sbRecord.home_no_vig_fair ?? null;
  }

  if (fair_value === null) return { edge_pp: null, fair_value: null };

  const kalshi_ask = market.yes_ask ?? null;
  if (kalshi_ask === null) return { edge_pp: null, fair_value };

  const edge_pp = (fair_value - kalshi_ask) * 100;
  return { edge_pp, fair_value };
}

/**
 * Infer team side ('away' | 'home' | null) from market metadata vs sportsbook names.
 */
function inferTeamSide(market, sbRecord) {
  const candidates = [market.team_name, market.team_code].filter(Boolean);
  if (candidates.length === 0) return null;

  const awayNames = [sbRecord.away_team, sbRecord.away_team_abbr].filter(Boolean).map(s => s.toLowerCase());
  const homeNames = [sbRecord.home_team, sbRecord.home_team_abbr].filter(Boolean).map(s => s.toLowerCase());

  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (awayNames.some(n => n.includes(cl) || cl.includes(n))) return 'away';
    if (homeNames.some(n => n.includes(cl) || cl.includes(n))) return 'home';
  }
  return null;
}

// --- Poisson CDF helpers ---
// log(k!) via direct summation — exact for integer k, avoids overflow
function logFactorial(k) {
  if (k <= 1) return 0;
  let sum = 0;
  for (let i = 2; i <= k; i++) sum += Math.log(i);
  return sum;
}

// P(X = k) for Poisson(lambda), computed in log-space
function poissonPmf(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0 || k < 0 || !Number.isInteger(k)) return 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}

// P(X <= kMax) for Poisson(lambda)
function poissonCdf(kMax, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return kMax >= 0 ? 1 : 0;
  let cdf = 0;
  for (let k = 0; k <= kMax; k++) cdf += poissonPmf(k, lambda);
  return Math.min(1, cdf);
}

// P(total_runs > strike) for half-integer Kalshi strikes.
// YES on a Kalshi total market means total > strike.
// Since strikes are always x.5: P(total > 7.5) = P(X >= 8) = 1 - CDF(7).
// General: threshold = floor(strike), fair = 1 - CDF(threshold, lambda).
function poissonOverProbability(strike, lambda) {
  const threshold = Math.floor(strike); // floor(7.5)=7, P(X>7.5)=P(X>=8)=1-CDF(7)
  return Math.max(0, Math.min(1, 1 - poissonCdf(threshold, lambda)));
}
// --- end Poisson CDF helpers ---

/**
 * Calculate edge and fair value for game_total markets using Poisson CDF.
 * lambda = sportsbook over/under (DK 50/50 line ≈ expected total runs).
 * fair_value = P(total_runs > total_strike) via Poisson survival function.
 * Returns { edge_pp, fair_value } or { edge_pp: null, fair_value: null }.
 */
function calcGameTotalEdge(market, sbRecord) {
  if (!sbRecord) return { edge_pp: null, fair_value: null };

  const dk_line = sbRecord.over_under ?? null;
  const total_strike = market.total_strike ?? null;

  if (
    dk_line === null ||
    total_strike === null ||
    !Number.isFinite(dk_line) ||
    !Number.isFinite(total_strike) ||
    dk_line <= 0
  ) {
    return { edge_pp: null, fair_value: null };
  }

  const fair_value = poissonOverProbability(total_strike, dk_line);

  const kalshi_ask = market.yes_ask ?? null;
  if (kalshi_ask === null) return { edge_pp: null, fair_value };

  const edge_pp = (fair_value - kalshi_ask) * 100;
  return { edge_pp, fair_value };
}

/**
 * Calculate edge/fair_value for a market based on its lane.
 * Returns { edge_pp, fair_value }.
 */
function calcEdge(market, sbRecord) {
  const lane = market.market_lane ?? null;

  if (lane === 'moneyline') {
    return calcMoneylineEdge(market, sbRecord);
  }
  if (lane === 'game_total') {
    return calcGameTotalEdge(market, sbRecord);
  }
  // Other lanes: no edge calculation
  return { edge_pp: null, fair_value: null };
}

/**
 * Evaluate all gates for a single market.
 *
 * Returns:
 *   gatesPassed: string[]
 *   gatesFailed: string[]
 *   lineupStatus: 'confirmed' | 'pending'
 *   weatherRiskPct: number | null  (only meaningful for weather-sensitive lanes)
 */
function evaluateGates({ market, record, kalshi, mlb, weather, sportsbook, context, fixtureMode, sbRecord }) {
  const passed = [];
  const failed = [];
  const lane = market.market_lane ?? null;

  // Gate 1: kalshi_tradable
  const kalshiRecords = safeArray(kalshi?.records);
  const hasYesAsk = market.yes_ask !== null && market.yes_ask !== undefined;
  if (kalshiRecords.length > 0 && hasYesAsk) {
    passed.push('kalshi_tradable: Records present with valid yes_ask');
  } else if (kalshiRecords.length === 0) {
    failed.push('kalshi_tradable: No Kalshi records available');
  } else {
    failed.push('kalshi_tradable: Market yes_ask is null or missing');
  }

  // Gate 2: mlb_game_match
  const mlbRecords = safeArray(mlb?.records);
  const hasGamePk = !!record.matched_game_pk;
  if (mlbRecords.length > 0 && hasGamePk) {
    passed.push(`mlb_game_match: MLB records present, matched_game_pk=${record.matched_game_pk}`);
  } else if (mlbRecords.length === 0) {
    failed.push('mlb_game_match: MLB records empty or blocked');
  } else {
    failed.push('mlb_game_match: No matched_game_pk on Kalshi record');
  }

  // Gate 3: reference_price
  const sbRecords = safeArray(sportsbook?.records);
  if (sbRecord && (sbRecord.away_no_vig_fair !== null && sbRecord.away_no_vig_fair !== undefined ||
      sbRecord.home_no_vig_fair !== null && sbRecord.home_no_vig_fair !== undefined)) {
    passed.push('reference_price: Sportsbook record found with fair value data');
  } else if (!sbRecord && sbRecords.length === 0) {
    failed.push('reference_price: No sportsbook records available');
  } else if (!sbRecord) {
    failed.push('reference_price: No sportsbook record matches this game');
  } else {
    failed.push('reference_price: Sportsbook record found but no_vig_fair values are null');
  }

  // Gate 4: weather
  const weatherRecords = safeArray(weather?.records);
  if (WEATHER_SENSITIVE_LANES.has(lane)) {
    if (weatherRecords.length > 0) {
      passed.push(`weather: Weather records present for weather-sensitive lane (${lane})`);
    } else {
      failed.push(`weather: No weather records for weather-sensitive lane (${lane}), status=${sourceStatus(weather)}`);
    }
  } else {
    passed.push(`weather: Not weather-sensitive (lane=${lane ?? 'unknown'})`);
  }

  // Gate 5: lineup_context (soft gate — does not hard-fail)
  const contextRecords = safeArray(context?.records);
  let lineupStatus = 'pending';
  const gameAway = record.away_team ?? '';
  const gameHome = record.home_team ?? '';
  const gamePk = record.matched_game_pk;
  const ctxRecord = contextRecords.find(r =>
    (gamePk && r.game_pk === gamePk) ||
    (gameAway && gameHome && r.away_team === gameAway && r.home_team === gameHome),
  );
  if (ctxRecord && ctxRecord.lineup_status === 'confirmed_or_boxscore_available') {
    lineupStatus = 'confirmed';
    passed.push('lineup_context: Lineup confirmed or boxscore available');
  } else if (!ctxRecord) {
    passed.push('lineup_context: Context missing — treated as pending (soft gate)');
  } else {
    passed.push(`lineup_context: Lineup pending (status=${ctxRecord.lineup_status ?? 'unknown'}) — soft gate`);
  }

  // Gate 6: not_fixture
  if (!fixtureMode) {
    passed.push('not_fixture: No fixture mode detected');
  } else {
    failed.push('not_fixture: Fixture mode detected across one or more adapters');
  }

  // Estimate weather risk pct for total lanes (simple heuristic from wind/precip if available)
  let weatherRiskPct = null;
  if (WEATHER_SENSITIVE_LANES.has(lane) && weatherRecords.length > 0) {
    // Look for a weather record matching this game
    const wRecord = weatherRecords.find(r =>
      (gamePk && r.game_pk === gamePk) ||
      (gameAway && gameHome && r.away_team === gameAway && r.home_team === gameHome),
    ) ?? weatherRecords[0];
    if (wRecord) {
      const precip = wRecord.precip_probability ?? wRecord.precip_pct ?? null;
      weatherRiskPct = typeof precip === 'number' ? precip * 100 : null;
    }
  }

  return { passed, failed, lineupStatus, weatherRiskPct };
}

function gateNamesFailed(gatesFailed) {
  return gatesFailed.map(entry => entry.split(':')[0].trim());
}

/**
 * Classify a single market based on gate results and edge calculation.
 *
 * @returns {{ classification, target_entry, missing_confirmations, notes }}
 */
function classifyMarket({
  gatesPassed,
  gatesFailed,
  edge_pp,
  fair_value,
  kalshi_ask,
  fixtureMode,
  lineupStatus,
  weatherRiskPct,
  lane,
}) {
  const failed = gateNamesFailed(gatesFailed);
  const missing = [];
  const notes = [];
  let classification;
  let target_entry = null;

  // Fixture mode with core data present → WATCH_FOR_LISTING
  if (failed.includes('not_fixture') && !failed.includes('kalshi_tradable') && !failed.includes('mlb_game_match')) {
    if (fixtureMode) {
      classification = 'WATCH_FOR_LISTING';
      notes.push('Fixture mode: market not yet live. Check back when schedule opens.');
      return { classification, target_entry, missing_confirmations: missing, notes };
    }
  }

  // Hard block: core data missing
  if (
    failed.includes('kalshi_tradable') ||
    failed.includes('mlb_game_match') ||
    failed.includes('reference_price')
  ) {
    classification = 'BLOCKED_SOURCE_GAP';
    if (failed.includes('kalshi_tradable')) missing.push('kalshi_tradable');
    if (failed.includes('mlb_game_match')) missing.push('mlb_game_match');
    if (failed.includes('reference_price')) missing.push('reference_price');
    notes.push('One or more critical source gates failed; cannot evaluate edge.');
    return { classification, target_entry, missing_confirmations: missing, notes };
  }

  // Weather gate hard block for weather-sensitive lanes
  if (failed.includes('weather')) {
    classification = 'BLOCKED_SOURCE_GAP';
    missing.push('weather');
    notes.push(`Weather data required for lane=${lane} but not available.`);
    return { classification, target_entry, missing_confirmations: missing, notes };
  }

  // Fixture mode for other gate failures → WATCH_FOR_LISTING
  if (fixtureMode) {
    classification = 'WATCH_FOR_LISTING';
    notes.push('Fixture mode active: live classification blocked. Discovery only.');
    return { classification, target_entry, missing_confirmations: missing, notes };
  }

  // No edge calculable
  if (edge_pp === null) {
    classification = 'BLOCKED_SOURCE_GAP';
    missing.push('edge_calculation');
    notes.push('Edge could not be calculated (missing total_strike or fair value data).');
    return { classification, target_entry, missing_confirmations: missing, notes };
  }

  // PASS: edge at or below zero
  if (edge_pp <= 0) {
    classification = 'PASS';
    notes.push('Kalshi ask >= fair value; no edge detected.');
    return { classification, target_entry, missing_confirmations: missing, notes };
  }

  // CLEAR_PICK: all gates pass, lineup confirmed, edge >= 2.0
  if (
    gatesFailed.length === 0 &&
    edge_pp >= 2.0 &&
    lineupStatus === 'confirmed'
  ) {
    classification = 'CLEAR_PICK';
    notes.push('All gates passed, lineup confirmed, edge >= 2pp. Discovery signal only — no trade placed.');
    return { classification, target_entry, missing_confirmations: missing, notes };
  }

  // LEAN: core gates pass, edge >= 1.5, not_fixture passes
  if (
    !failed.includes('kalshi_tradable') &&
    !failed.includes('mlb_game_match') &&
    !failed.includes('reference_price') &&
    !failed.includes('not_fixture') &&
    edge_pp >= 1.5
  ) {
    // Check if lineup is pending or weather unconfirmed (conditions for LEAN)
    const lineupPending = lineupStatus === 'pending';
    const weatherUnconfirmed = WEATHER_SENSITIVE_LANES.has(lane) && weatherRiskPct === null;
    const contextMissing = lineupStatus === 'pending'; // proxies context missing

    if (lineupPending || weatherUnconfirmed || contextMissing) {
      classification = 'LEAN';
      if (lineupPending) missing.push('lineup_confirmation');
      if (weatherUnconfirmed) missing.push('weather_confirmation');
      notes.push('Edge >= 1.5pp but confirmations pending. Monitor before acting.');
      return { classification, target_entry, missing_confirmations: missing, notes };
    }

    // All confirmations present but below CLEAR_PICK threshold (edge >= 1.5 but < 2.0, or lineup not CONFIRMED)
    if (lineupStatus !== 'confirmed') {
      classification = 'LEAN';
      missing.push('lineup_confirmation');
      notes.push('Edge >= 1.5pp but lineup not yet confirmed.');
      return { classification, target_entry, missing_confirmations: missing, notes };
    }

    // Edge >= 1.5 with confirmed lineup but gatesFailed non-empty (other non-blocking gates)
    classification = 'LEAN';
    notes.push('Edge >= 1.5pp. Some non-critical gates pending.');
    return { classification, target_entry, missing_confirmations: missing, notes };
  }

  // WATCH_FOR_PRICE: positive edge but below LEAN threshold, or lineup block + weather risk
  if (edge_pp > 0) {
    const highWeatherRisk = WEATHER_SENSITIVE_LANES.has(lane) && (weatherRiskPct ?? 0) > 30;
    const lineupNotConfirmed = lineupStatus !== 'confirmed';

    if (
      edge_pp < 1.5 ||
      (edge_pp >= 1.5 && lineupNotConfirmed && highWeatherRisk)
    ) {
      classification = 'WATCH_FOR_PRICE';
      target_entry = kalshi_ask !== null ? Math.round(kalshi_ask * 0.98 * 1000) / 1000 : null;
      if (edge_pp < 1.5) missing.push('stronger_edge');
      if (lineupNotConfirmed) missing.push('lineup_confirmation');
      if (highWeatherRisk) missing.push('weather_improvement');
      notes.push(
        `Edge ${edge_pp.toFixed(2)}pp positive but below threshold. ` +
        (target_entry !== null ? `Target entry: ${target_entry} (2% below current ask).` : ''),
      );
      return { classification, target_entry, missing_confirmations: missing, notes };
    }
  }

  // Fallback: treat as PASS
  classification = 'PASS';
  notes.push('No actionable edge or classification condition met.');
  return { classification, target_entry, missing_confirmations: missing, notes };
}

function incrementCount(counts, classification) {
  const key = classification.toLowerCase();
  if (key in counts) {
    counts[key] += 1;
  }
  counts.total += 1;
}

/**
 * Score all Kalshi markets against all available source adapter envelopes.
 *
 * @param {{ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }} adapters
 * @returns {{ fixture_mode, candidates, counts, notes }}
 */
export function scoreMarkets({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  // Normalise optional adapters
  const sbEnvelope = sportsbook ?? { status: 'blocked', records: [] };
  const ctxEnvelope = context ?? { status: 'blocked', records: [] };

  const fixtureMode = detectFixtureMode({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook: sbEnvelope, context: ctxEnvelope });
  const kalshiRecords = safeArray(kalshi?.records);
  const sbRecords = safeArray(sbEnvelope.records);

  const counts = {
    total: 0,
    clear_pick: 0,
    lean: 0,
    watch_for_price: 0,
    watch_for_listing: 0,
    pass: 0,
    blocked_source_gap: 0,
    correlated_alternate: 0,
  };

  const notes = [];
  const candidates = [];

  if (kalshiRecords.length === 0) {
    const candidate = {
      market_ticker: null,
      event_ticker: null,
      market_title: null,
      market_lane: null,
      game: null,
      classification: 'BLOCKED_SOURCE_GAP',
      edge_pp: null,
      fair_value: null,
      kalshi_ask: null,
      target_entry: null,
      missing_confirmations: ['kalshi_tradable'],
      gates_passed: [],
      gates_failed: ['kalshi_tradable: No Kalshi records available'],
      fixture_mode: fixtureMode,
      notes: ['No Kalshi records found; cannot evaluate any market.'],
    };
    candidates.push(candidate);
    incrementCount(counts, 'BLOCKED_SOURCE_GAP');
    notes.push('No Kalshi records found; all markets blocked.');
    notes.push('No automated trades. No bet placement. Discovery only.');
    return { fixture_mode: fixtureMode, candidates, counts, notes };
  }

  for (const record of kalshiRecords) {
    const markets = safeArray(record.markets);
    const sbRecord = findSportsbookRecord(record, sbRecords);
    const gameLabel = buildGameLabel(record);

    for (const market of markets) {
      const lane = market.market_lane ?? null;
      const kalshi_ask = market.yes_ask ?? null;

      const { passed, failed, lineupStatus, weatherRiskPct } = evaluateGates({
        market,
        record,
        kalshi,
        mlb,
        weather,
        sportsbook: sbEnvelope,
        context: ctxEnvelope,
        fixtureMode,
        sbRecord,
      });

      const { edge_pp, fair_value } = calcEdge(market, sbRecord);

      const { classification, target_entry, missing_confirmations, notes: marketNotes } = classifyMarket({
        gatesPassed: passed,
        gatesFailed: failed,
        edge_pp,
        fair_value,
        kalshi_ask,
        fixtureMode,
        lineupStatus,
        weatherRiskPct,
        lane,
      });

      if (fixtureMode && classification !== 'WATCH_FOR_LISTING' && classification !== 'BLOCKED_SOURCE_GAP') {
        marketNotes.push('Fixture mode active: CLEAR_PICK and LEAN are blocked in fixture runs. Discovery only.');
      }

      const candidate = {
        market_ticker: market.market_ticker ?? null,
        event_ticker: record.event_ticker ?? null,
        market_title: market.market_title ?? null,
        market_lane: lane,
        game: gameLabel,
        classification,
        total_strike: market.total_strike ?? null,
        dk_line: lane === 'game_total' ? (sbRecord?.over_under ?? null) : null,
        correlation_group: buildCorrelationGroup(record, market),
        primary_pick: false,
        edge_pp: edge_pp !== null ? Math.round(edge_pp * 1000) / 1000 : null,
        fair_value: fair_value !== null ? Math.round(fair_value * 10000) / 10000 : null,
        kalshi_ask,
        target_entry,
        missing_confirmations,
        gates_passed: passed,
        gates_failed: failed,
        fixture_mode: fixtureMode,
        notes: marketNotes,
      };

      candidates.push(candidate);
      incrementCount(counts, classification);
    }
  }

  // Promote one primary CLEAR_PICK per correlation group; demote the rest to CORRELATED_ALTERNATE
  selectPrimaryPicks(candidates, counts);

  // Sort by edge_pp descending, nulls last
  candidates.sort((a, b) => {
    if (a.edge_pp === null && b.edge_pp === null) return 0;
    if (a.edge_pp === null) return 1;
    if (b.edge_pp === null) return -1;
    return b.edge_pp - a.edge_pp;
  });

  if (fixtureMode) {
    notes.push('Fixture mode detected. CLEAR_PICK and LEAN are blocked across all markets.');
  }

  if (counts.clear_pick > 0) {
    notes.push(`${counts.clear_pick} CLEAR_PICK candidate(s) found. Verify sources before acting.`);
  }

  if (counts.lean > 0) {
    notes.push(`${counts.lean} LEAN candidate(s) found. Awaiting confirmations.`);
  }

  notes.push('No automated trades. No bet placement. Discovery only.');

  return { fixture_mode: fixtureMode, candidates, counts, notes };
}

/**
 * Build a human-readable game label from a Kalshi event record.
 */
function buildGameLabel(record) {
  const away = record.away_team ?? record.matched_game ?? null;
  const home = record.home_team ?? null;
  if (away && home) return `${away} at ${home}`;
  if (away) return away;
  return record.event_ticker ?? null;
}

/**
 * Build a correlation group key.
 * All game_total overs from the same event share a group; same for unders and moneylines.
 */
function buildCorrelationGroup(record, market) {
  const lane = market.market_lane ?? 'unknown';
  const eventTicker = record.event_ticker ?? `game_${record.matched_game_pk ?? 'unknown'}`;
  if (lane === 'game_total') {
    const title = (market.contract_title ?? '').toLowerCase();
    const dir = title.includes('under') ? 'under' : 'over';
    return `${eventTicker}_total_${dir}`;
  }
  if (lane === 'moneyline') {
    return `${eventTicker}_ml`;
  }
  return `${eventTicker}_${lane}`;
}

/**
 * Selects one primary CLEAR_PICK per correlation group; demotes the rest to CORRELATED_ALTERNATE.
 *
 * Primary selection score = edge_pp × (1 − ask) / (1 + |strike − dk_line| × 0.5)
 * Candidates with ask > 0.85 are excluded from primary contention (low upside) unless they
 * are the only eligible pick in the group.
 *
 * Mutates `candidates` and `counts` in place.
 */
function selectPrimaryPicks(candidates, counts) {
  const groups = new Map();
  for (const c of candidates) {
    if (c.classification !== 'CLEAR_PICK') continue;
    const g = c.correlation_group ?? 'ungrouped';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }

  for (const [, members] of groups) {
    if (members.length === 1) {
      members[0].primary_pick = true;
      continue;
    }

    // Exclude low-upside candidates (ask > 0.85) unless all are above threshold
    const eligible = members.filter(c => (c.kalshi_ask ?? 1) <= 0.85);
    const pool = eligible.length > 0 ? eligible : members;

    let best = null;
    let bestScore = -Infinity;
    for (const c of pool) {
      const edgePp = c.edge_pp ?? 0;
      const ask = c.kalshi_ask ?? 0.5;
      const strike = c.total_strike ?? 0;
      const dkLine = c.dk_line ?? strike;
      const upside = 1 - ask;
      // Penalise strikes far from the sportsbook total line
      const proximityFactor = 1 / (1 + Math.abs(strike - dkLine) * 0.5);
      const score = edgePp * upside * proximityFactor;
      if (score > bestScore || (score === bestScore && ask < (best?.kalshi_ask ?? 1))) {
        bestScore = score;
        best = c;
      }
    }

    for (const c of members) {
      if (c === best) {
        c.primary_pick = true;
      } else {
        c.classification = 'CORRELATED_ALTERNATE';
        c.primary_pick = false;
        c.notes = [
          ...(c.notes ?? []),
          `Correlated alternate: primary pick for group ${c.correlation_group} selected elsewhere. Listed for reference only.`,
        ];
        counts.clear_pick = Math.max(0, counts.clear_pick - 1);
        counts.correlated_alternate = (counts.correlated_alternate ?? 0) + 1;
      }
    }
  }
}
