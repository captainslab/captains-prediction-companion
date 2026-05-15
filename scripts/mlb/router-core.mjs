export const CANONICAL_LANES = Object.freeze([
  'moneyline',
  'run_line',
  'game_total',
  'yrfi_nrfi',
  'home_run_hitter',
  'pitcher_strikeouts',
]);

export const ROUTE_STATUSES = Object.freeze(['ROUTED', 'AMBIGUOUS', 'BLOCKED', 'OUT_OF_SCOPE']);

const NEXT_WORKFLOW = 'runbooks/mlb-prediction-process.md';

const NON_ROUTER_STATUSES = new Set([
  'CLEAR_PICK',
  'PASS',
  'WATCH_FOR_LISTING',
  'NOT_TRADEABLE',
  'RESEARCH_EDGE',
  'KALSHI_AVAILABLE',
  'NOT_OFFERED_NOW',
]);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[?]/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function has(text, pattern) {
  return pattern.test(text);
}

function firstThreshold(text) {
  const match = text.match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : match[0];
}

function inferSideHint(text, lane) {
  if (has(text, /\bover\b/)) return 'OVER';
  if (has(text, /\bunder\b/)) return 'UNDER';
  if (lane === 'home_run_hitter') return 'PLAYER';
  if (lane === 'moneyline' || lane === 'run_line') return 'TEAM';
  if (lane === 'yrfi_nrfi') {
    if (has(text, /\bnrfi\b|no run/)) return 'NO';
    return 'YES';
  }
  return null;
}

function makeBaseResult(input, text) {
  return {
    route_status: 'BLOCKED',
    market_lane: null,
    candidate_lanes: [],
    kalshi_url: input.kalshi_url ?? null,
    event_ticker: input.event_ticker ?? null,
    market_ticker: input.market_ticker ?? null,
    event_title: input.event_title ?? null,
    market_title: input.market_title ?? input.title ?? null,
    contract_title: input.contract_title ?? null,
    game_date: input.game_date ?? null,
    teams: {
      away: input.teams?.away ?? null,
      home: input.teams?.home ?? null,
    },
    player_name: input.player_name ?? null,
    threshold: input.threshold ?? firstThreshold(text),
    side_hint: null,
    confidence: 0,
    matched_signals: [],
    reject_signals: [],
    needed_clarification: [],
    next_workflow: NEXT_WORKFLOW,
    notes: [],
  };
}

function addCandidate(candidates, lane, signal) {
  if (!candidates.has(lane)) {
    candidates.set(lane, []);
  }
  candidates.get(lane).push(signal);
}

function detectCandidates(text) {
  const candidates = new Map();
  const rejectSignals = [];

  const hasNumber = has(text, /[+-]?\d+(?:\.\d+)?/);
  const hasOverUnder = has(text, /\b(over|under)\b/);
  const firstInning = has(text, /\byrfi\b|\bnrfi\b|first inning|1st inning|run scored in the first/);
  const unsupportedFirstFive = has(text, /\bfirst five\b|\bf5\b|first 5/);
  const unsupportedTeamTotal = has(text, /\bteam total\b/);
  const unsupportedFutures = has(
    text,
    /\b(world series|pennant|division|playoff|mvp|cy young|rookie of the year|season[- ]long|standings|futures)\b/,
  );

  if (has(text, /\b(team strikeouts|team strikeout|batter strikeouts|total strikeouts by)\b/)) {
    rejectSignals.push('unsupported strikeout market');
  } else if (has(text, /\b(strikeout|strikeouts|ks?)\b/)) {
    addCandidate(candidates, 'pitcher_strikeouts', 'pitcher strikeout wording');
    if (hasOverUnder || hasNumber) addCandidate(candidates, 'pitcher_strikeouts', 'strikeout threshold');
  }

  if (has(text, /\b(home run derby|total home runs|team home runs)\b/)) {
    rejectSignals.push('unsupported home run market');
  } else if (has(text, /\b(home run|homer|hr)\b|hit a home run/)) {
    addCandidate(candidates, 'home_run_hitter', 'player home run wording');
  }

  if (unsupportedFirstFive) {
    rejectSignals.push('unsupported first-five market');
  } else if (firstInning) {
    addCandidate(candidates, 'yrfi_nrfi', 'first-inning run wording');
  }

  if (unsupportedTeamTotal) {
    rejectSignals.push('unsupported team total market');
  } else if (
    !firstInning &&
    !has(text, /\b(strikeout|strikeouts|home run|homer|hr)\b/) &&
    (has(text, /\btotal runs\b|\bcombined runs\b/) ||
      has(text, /\b(over|under)\s+[+-]?\d+(?:\.\d+)?\s+(?:total\s+)?runs\b/))
  ) {
    addCandidate(candidates, 'game_total', 'combined full-game runs wording');
  }

  if (
    !has(text, /\b(total runs|combined runs|strikeout|strikeouts|home run|homer|hr|first inning|1st inning)\b/) &&
    (has(text, /\brun line\b|\bspread\b|\bcover\b/) ||
      has(text, /[+-]\d+(?:\.\d+)?\s*runs?\b/) ||
      has(text, /\bwin by \d+|win by two|lose by 1 or win|lose by one or win\b/))
  ) {
    addCandidate(candidates, 'run_line', 'run line or spread wording');
  }

  const ambiguousOverNumberOnly =
    hasOverUnder &&
    hasNumber &&
    has(text, /\b(vs|versus|at)\b/) &&
    !has(text, /\b(total runs|combined runs|run line|spread|home run|homer|strikeout|first inning|1st inning)\b/);

  if (ambiguousOverNumberOnly) {
    addCandidate(candidates, 'game_total', 'numeric over/under could be total');
    addCandidate(candidates, 'run_line', 'numeric over/under could be spread');
  }

  if (
    !hasNumber &&
    !has(text, /\b(strikeout|strikeouts|home run|homer|hr|first inning|1st inning|total runs|combined runs|run line|spread)\b/) &&
    (has(text, /\bwinner\b|\bwin the game\b/) || has(text, /\bwill\b.+\bbeat\b/) || has(text, /\bbeat\b.+\b(vs|at|the)\b/))
  ) {
    addCandidate(candidates, 'moneyline', 'binary full-game winner wording');
  }

  if (unsupportedFutures) {
    rejectSignals.push('unsupported futures or season-long market');
  }

  return { candidates, rejectSignals };
}

function looksClearlyNonMlb(text) {
  return has(
    text,
    /\b(nfl|nba|nhl|soccer|football|basketball|hockey|tennis|golf|ufc|nascar|election|president|pope|senate|congress|bitcoin|stock|weather temperature)\b/,
  );
}

function looksBaseballRelated(text) {
  return has(
    text,
    /\b(mlb|baseball|run|runs|inning|pitcher|strikeout|strikeouts|home run|homer|hr|aces|bears|vs|versus)\b/,
  );
}

function buildResult(input, status, lane, candidates, text, matchedSignals, rejectSignals, clarification, confidence) {
  const result = makeBaseResult(input, text);
  result.route_status = status;
  result.market_lane = lane;
  result.candidate_lanes = candidates;
  result.side_hint = lane ? inferSideHint(text, lane) : null;
  result.confidence = confidence;
  result.matched_signals = matchedSignals;
  result.reject_signals = rejectSignals;
  result.needed_clarification = clarification;
  return result;
}

export function routeMlbMarket(input = {}) {
  const title = cleanText(input.market_title ?? input.title ?? '');
  const rules = cleanText(input.rules_summary ?? input.rules ?? '');
  const eventTitle = cleanText(input.event_title ?? '');
  const contractTitle = cleanText(input.contract_title ?? '');
  const text = normalizeText([title, rules, eventTitle, contractTitle].filter(Boolean).join(' '));

  if (!text) {
    return buildResult(input, 'BLOCKED', null, [], text, [], [], ['Need market title or rules text'], 0);
  }

  const { candidates, rejectSignals } = detectCandidates(text);
  const candidateLanes = CANONICAL_LANES.filter(lane => candidates.has(lane));

  if (rejectSignals.length > 0) {
    return buildResult(input, 'OUT_OF_SCOPE', null, candidateLanes, text, [], rejectSignals, [], 20);
  }

  if (looksClearlyNonMlb(text) && candidateLanes.length === 0) {
    return buildResult(input, 'OUT_OF_SCOPE', null, [], text, [], ['not an MLB market'], [], 10);
  }

  if (candidateLanes.length === 1) {
    const lane = candidateLanes[0];
    return buildResult(input, 'ROUTED', lane, [lane], text, candidates.get(lane), [], [], lane === 'moneyline' ? 92 : 90);
  }

  if (candidateLanes.length > 1) {
    return buildResult(
      input,
      'AMBIGUOUS',
      null,
      candidateLanes,
      text,
      candidateLanes.flatMap(lane => candidates.get(lane)),
      ['multiple plausible lanes'],
      ['Need Kalshi rules or full market title to distinguish the market lane'],
      40,
    );
  }

  if (looksBaseballRelated(text)) {
    return buildResult(
      input,
      'BLOCKED',
      null,
      [],
      text,
      [],
      [],
      ['Market appears MLB-related but title/rules do not identify one supported lane'],
      25,
    );
  }

  return buildResult(input, 'OUT_OF_SCOPE', null, [], text, [], ['not an MLB market'], [], 10);
}

export function assertNoTradeDecisionStatus(result) {
  const serialized = JSON.stringify(result);
  for (const status of NON_ROUTER_STATUSES) {
    if (serialized.includes(status)) {
      throw new Error(`Router result contains non-router status: ${status}`);
    }
  }
  return true;
}
