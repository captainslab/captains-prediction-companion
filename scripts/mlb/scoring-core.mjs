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
function detectFixtureMode({ kalshi, mlb, baseballSavant, weather, liquidity }) {
  const allEnvelopes = [kalshi, mlb, baseballSavant, weather, liquidity];
  return allEnvelopes.some(envelope =>
    safeArray(envelope?.warnings).some(warning => /fixture mode/i.test(warning)),
  );
}

/**
 * Evaluate gates for a single market.
 * Returns { passed: string[], failed: string[] } where each item is "gate_name: reason".
 */
function evaluateGates({ market, kalshi, mlb, baseballSavant, weather, liquidity, fixtureMode }) {
  const passed = [];
  const failed = [];
  const lane = market.market_lane ?? null;

  // Gate 1: kalshi_tradable
  if (sourceStatus(kalshi) === 'ok' && safeArray(kalshi.records).length > 0) {
    passed.push('kalshi_tradable: Kalshi status ok and records present');
  } else {
    failed.push(`kalshi_tradable: Kalshi status=${sourceStatus(kalshi)}, records=${safeArray(kalshi.records).length}`);
  }

  // Gate 2: mlb_game_match
  if (sourceStatus(mlb) === 'ok' && safeArray(mlb.records).length > 0) {
    passed.push('mlb_game_match: MLB status ok and records present');
  } else {
    failed.push(`mlb_game_match: MLB status=${sourceStatus(mlb)}, records=${safeArray(mlb.records).length}`);
  }

  // Gate 3: savant_evidence
  if (sourceStatus(baseballSavant) === 'ok' && safeArray(baseballSavant.records).length > 0) {
    passed.push('savant_evidence: Baseball Savant status ok and records present');
  } else {
    failed.push(`savant_evidence: Savant status=${sourceStatus(baseballSavant)}, records=${safeArray(baseballSavant.records).length}`);
  }

  // Gate 4: weather — only required for certain lanes
  if (WEATHER_SENSITIVE_LANES.has(lane)) {
    if (sourceStatus(weather) === 'ok' && safeArray(weather.records).length > 0) {
      passed.push('weather: Weather status ok and records present');
    } else {
      failed.push(`weather: Weather status=${sourceStatus(weather)}, records=${safeArray(weather.records).length}`);
    }
  } else {
    passed.push(`weather: skipped (lane=${lane ?? 'unknown'} is not weather-sensitive)`);
  }

  // Gate 5: liquidity
  if (sourceStatus(liquidity) !== 'blocked') {
    passed.push(`liquidity: Liquidity status=${sourceStatus(liquidity)}`);
  } else {
    failed.push(`liquidity: Liquidity status=blocked`);
  }

  // Gate 6: not_fixture
  if (!fixtureMode) {
    passed.push('not_fixture: No fixture mode detected');
  } else {
    failed.push('not_fixture: Fixture mode detected across one or more adapters');
  }

  return { passed, failed };
}

function gateNamesFailed(gatesFailed) {
  return gatesFailed.map(entry => entry.split(':')[0].trim());
}

/**
 * Classify a single market based on which gates passed/failed.
 */
function classifyMarket({ gatesPassed, gatesFailed }) {
  const failed = gateNamesFailed(gatesFailed);

  // All gates pass
  if (gatesFailed.length === 0) {
    return 'CLEAR_PICK';
  }

  // Fixture mode detected but core data is present → watch for real listing
  if (failed.includes('not_fixture') && !failed.includes('kalshi_tradable') && !failed.includes('mlb_game_match')) {
    return 'WATCH_FOR_LISTING';
  }

  // Core market data missing
  if (failed.includes('kalshi_tradable') || failed.includes('mlb_game_match')) {
    return 'BLOCKED';
  }

  // Liquidity gate failed
  if (failed.includes('liquidity')) {
    return 'NOT_TRADEABLE';
  }

  // Evidence gaps
  if (failed.includes('savant_evidence') || failed.includes('weather')) {
    return 'LEAN';
  }

  return 'PASS';
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
 * @param {{ kalshi, mlb, baseballSavant, weather, liquidity }} adapters
 * @returns {{ fixture_mode, candidates, counts, notes }}
 */
export function scoreMarkets({ kalshi, mlb, baseballSavant, weather, liquidity }) {
  const fixtureMode = detectFixtureMode({ kalshi, mlb, baseballSavant, weather, liquidity });
  const kalshiRecords = safeArray(kalshi?.records);

  const counts = {
    total: 0,
    clear_pick: 0,
    lean: 0,
    watch_for_listing: 0,
    pass: 0,
    blocked: 0,
    not_tradeable: 0,
  };

  const notes = [];
  const candidates = [];

  if (kalshiRecords.length === 0) {
    const candidate = {
      market_ticker: null,
      event_ticker: null,
      market_title: null,
      market_lane: null,
      classification: 'BLOCKED',
      fixture_mode: fixtureMode,
      gates_passed: [],
      gates_failed: ['kalshi_tradable: No Kalshi records available'],
      notes: ['No Kalshi records found; cannot evaluate any market.'],
    };
    candidates.push(candidate);
    incrementCount(counts, 'BLOCKED');
    notes.push('No Kalshi records found; all markets blocked.');
    return { fixture_mode: fixtureMode, candidates, counts, notes };
  }

  for (const record of kalshiRecords) {
    const markets = safeArray(record.markets);
    for (const market of markets) {
      const { passed, failed } = evaluateGates({
        market,
        kalshi,
        mlb,
        baseballSavant,
        weather,
        liquidity,
        fixtureMode,
      });

      const classification = classifyMarket({ gatesPassed: passed, gatesFailed: failed });
      const candidate = {
        market_ticker: market.market_ticker ?? null,
        event_ticker: record.event_ticker ?? null,
        market_title: market.market_title ?? null,
        market_lane: market.market_lane ?? null,
        classification,
        fixture_mode: fixtureMode,
        gates_passed: passed,
        gates_failed: failed,
        notes: [],
      };

      if (fixtureMode) {
        candidate.notes.push('Fixture mode active: CLEAR_PICK is blocked. Use live-readonly run for real classifications.');
      }

      candidates.push(candidate);
      incrementCount(counts, classification);
    }
  }

  if (fixtureMode) {
    notes.push('Fixture mode detected. CLEAR_PICK is blocked across all markets.');
  }

  if (counts.clear_pick > 0) {
    notes.push(`${counts.clear_pick} CLEAR_PICK candidate(s) found. Verify sources before acting.`);
  }

  notes.push('No automated trades. No bet placement. Discovery only.');

  return { fixture_mode: fixtureMode, candidates, counts, notes };
}
