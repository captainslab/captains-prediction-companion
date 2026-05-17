// Stage 1 NASCAR race-market router (dry-run only).
// Mirrors the shape of scripts/mlb/router-core.mjs.
// Produces NO picks, prices, fair values, ceilings, trade recs, or live execution.

export const CANONICAL_LANES = Object.freeze([
  'win',
  'top3',
  'top5',
  'top10',
  'top20',
  'fastest_lap',
]);

export const ROUTE_STATUSES = Object.freeze([
  'ROUTED',
  'AMBIGUOUS',
  'BLOCKED',
  'OUT_OF_SCOPE',
  'NOT_NASCAR',
]);

// Statuses the router must NEVER emit (those belong to decision-logic / trading layers).
const NON_ROUTER_STATUSES = new Set([
  'CLEAR_PICK',
  'PASS',
  'WATCH_FOR_LISTING',
  'NOT_TRADEABLE',
  'RESEARCH_EDGE',
  'KALSHI_AVAILABLE',
  'NOT_OFFERED_NOW',
  'TRADE_YES',
  'TRADE_NO',
  'PLACE_PASSIVE_ORDER',
  'WAIT',
  'ESCALATE',
  'NO_TRADE',
]);

// Tokens/keys the router must NEVER include (price/pick/ceiling shapes).
const FORBIDDEN_FIELD_KEYS = new Set([
  'price',
  'prices',
  'fair_value',
  'fair_price',
  'pick',
  'picks',
  'recommendation',
  'recommendations',
  'driver_ceiling',
  'ceiling_market',
  'ceiling',
  'edge',
  'kelly',
  'stake',
  'order',
  'execute',
]);

// Series-futures tickers per docs/SPORTSAPP.md (deferred to nascarSeriesFuturesApp).
const SERIES_FUTURES_TICKERS = Object.freeze({
  'KXNASCARCUPSERIES-NCS26': 'NASCAR_CUP',
  'KXNASCARTRUCKSERIES-NTS26': 'NASCAR_TRUCKS',
  'KXNASCARAUTOPARTSSERIES-NAPS26': 'NASCAR_OREILLY',
});

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

function makeBaseResult(input) {
  return {
    route_status: 'BLOCKED',
    market_lane: null,
    candidate_lanes: [],
    market_scope: null,
    driver_name: input.driver_name ?? null,
    confidence: 0,
    matched_signals: [],
    reject_signals: [],
    needed_clarification: [],
    notes: [],
  };
}

// --- Detection helpers ---

const NASCAR_KEYWORDS =
  /\b(nascar|cup series|xfinity|truck series|trucks series|o'?reilly|daytona|talladega|bristol|martinsville|charlotte motor|kansas speedway|texas motor|atlanta motor|las vegas motor|homestead|phoenix raceway|pole position|caution|stage \d|lap|laps|driver|drivers|pit road)\b/;

const NON_NASCAR_KEYWORDS =
  /\b(nfl|nba|mlb|nhl|soccer|basketball|hockey|tennis|golf|ufc|mma|boxing|election|president|senate|congress|pope|bitcoin|stock|cricket|wnba|formula 1|f1|indycar|moto ?gp)\b/;

const SERIES_FUTURES_KEYWORDS =
  /\b(championship|season[- ]long|series winner|win the (cup|trucks|xfinity|o'?reilly)\s+series\s+championship)\b/;

const DRIVER_NAME_RE = /\b([A-Z][a-z'’\-]+(?:\s+[A-Z][a-z'’\-]+){1,2})\b/;

function detectSeriesFutures(rawText, normalized) {
  const upper = rawText.toUpperCase();
  for (const ticker of Object.keys(SERIES_FUTURES_TICKERS)) {
    if (upper.includes(ticker)) {
      return { kind: 'ticker', ticker, series: SERIES_FUTURES_TICKERS[ticker] };
    }
  }
  if (has(normalized, SERIES_FUTURES_KEYWORDS)) {
    return { kind: 'keyword', ticker: null, series: null };
  }
  return null;
}

function detectDriverName(rawTitle, rawRules) {
  // Look in original (capitalization-preserving) text.
  const sources = [rawTitle, rawRules].filter(s => typeof s === 'string' && s.length > 0);
  for (const src of sources) {
    const stripped = src
      .replace(/\bNASCAR\b/g, '')
      .replace(/\bCup\b|\bSeries\b|\bTrucks?\b|\bXfinity\b|\bO'?Reilly\b/g, '')
      .replace(/\bDaytona\b|\bTalladega\b|\bBristol\b|\bMartinsville\b/g, '');
    const m = stripped.match(DRIVER_NAME_RE);
    if (m) return m[1].trim();
  }
  return null;
}

function detectLane(text) {
  const candidates = new Map();
  const signals = [];

  const hasFinish = has(text, /\bfinish(?:es|ing)?\b/);
  const hasPosition = has(text, /\bposition\b/);

  // fastest_lap
  if (has(text, /\bfastest\s+lap\b/)) {
    candidates.set('fastest_lap', ['fastest lap wording']);
    signals.push('fastest lap');
  }

  // win — outright race win, NOT "win the championship" (caller pre-filters series futures).
  if (
    has(text, /\bwin\s+(the\s+)?race\b/) ||
    has(text, /\brace\s+winner\b/) ||
    has(text, /\bto\s+win\b/) ||
    has(text, /\bwins\s+(the\s+)?race\b/) ||
    (has(text, /\bwin\b/) && !has(text, /\btop\s*\d+\b/) && !has(text, /\bfastest\s+lap\b/))
  ) {
    candidates.set('win', ['race winner wording']);
    signals.push('win');
  }

  // top-N lanes (finishing position markets)
  const topNRe = /\btop[\s\-]?(\d{1,2})\b/g;
  let m;
  const tops = new Set();
  while ((m = topNRe.exec(text)) !== null) {
    const n = Number(m[1]);
    if ([3, 5, 10, 20].includes(n)) tops.add(n);
  }
  for (const n of tops) {
    const lane = `top${n}`;
    candidates.set(lane, [`top-${n} finishing-position wording`]);
    signals.push(lane);
  }
  // If we matched top-20 AND wording is clearly about points/standings, that's a candidate-pool rule, not a market.
  if (tops.has(20) && has(text, /\bin\s+(current\s+)?(points|standings|championship\s+standings)\b/)) {
    candidates.delete('top20');
    signals.push('top20 points-pool wording suppressed (not a market lane)');
  }

  // If "top" appears with no number, that is ambiguous wording on its own.
  const lonelyTop =
    has(text, /\btop\b/) && !has(text, /\btop[\s\-]?\d+\b/) && !has(text, /\bfastest\s+lap\b/);

  return { candidates, signals, lonelyTop, hasFinish, hasPosition };
}

// --- Result builders ---

function finalize(result) {
  // Hard guard: strip anything that looks like a price/pick/ceiling field if a future
  // change ever sneaks one in.
  for (const key of Object.keys(result)) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) delete result[key];
  }
  return result;
}

export function routeNascarMarket(input = {}) {
  const title = cleanText(input.market_title ?? input.title ?? '');
  const rules = cleanText(input.rules_summary ?? input.rules ?? '');
  const rawCombined = [title, rules].filter(Boolean).join(' ');
  const text = normalizeText(rawCombined);
  const result = makeBaseResult(input);

  if (!text) {
    result.route_status = 'BLOCKED';
    result.needed_clarification = ['Need market title or rules text'];
    return finalize(result);
  }

  // Try to attach a detected driver name early (purely informational).
  const driverName = result.driver_name ?? detectDriverName(title, rules);
  if (driverName) result.driver_name = driverName;

  // 1. Series futures detection (ticker or strong championship wording).
  const seriesFutures = detectSeriesFutures(rawCombined, text);
  if (seriesFutures) {
    result.route_status = 'OUT_OF_SCOPE';
    result.market_scope = 'series';
    result.reject_signals.push(
      seriesFutures.ticker
        ? `series futures ticker ${seriesFutures.ticker} (deferred to nascarSeriesFuturesApp)`
        : 'season-long championship wording (deferred to nascarSeriesFuturesApp)',
    );
    if (seriesFutures.ticker) {
      result.matched_signals.push(`series_ticker:${seriesFutures.ticker}`);
      if (seriesFutures.series) result.matched_signals.push(`series:${seriesFutures.series}`);
    }
    result.notes.push('Series futures are not a Stage 1 race-market lane.');
    result.confidence = 80;
    return finalize(result);
  }

  // 2. Clearly non-NASCAR markets.
  if (has(text, NON_NASCAR_KEYWORDS) && !has(text, NASCAR_KEYWORDS)) {
    result.route_status = 'NOT_NASCAR';
    result.reject_signals.push('non-NASCAR sport or market keywords detected');
    result.confidence = 10;
    return finalize(result);
  }

  // 3. Detect race-market lane candidates.
  const { candidates, signals, lonelyTop, hasFinish, hasPosition } = detectLane(text);
  const candidateLanes = CANONICAL_LANES.filter(lane => candidates.has(lane));

  const looksNascar = has(text, NASCAR_KEYWORDS) || Boolean(driverName);

  // 4. Ambiguous wording: "Driver top" with no number, or "Driver finishing position" with no number.
  if (lonelyTop || (hasFinish && hasPosition && candidateLanes.length === 0)) {
    result.route_status = 'AMBIGUOUS';
    result.candidate_lanes = ['top3', 'top5', 'top10', 'top20'];
    result.matched_signals.push('finishing-position wording without explicit threshold');
    result.needed_clarification.push(
      'Specify which top-N finishing-position market (top3 / top5 / top10 / top20) or whether this is a win/fastest_lap market',
    );
    result.confidence = 35;
    return finalize(result);
  }

  // 5. Single canonical lane match → ROUTED.
  if (candidateLanes.length === 1) {
    const lane = candidateLanes[0];
    result.route_status = 'ROUTED';
    result.market_lane = lane;
    result.candidate_lanes = [lane];
    result.market_scope = 'race';
    result.matched_signals = candidates.get(lane);
    result.confidence = 90;
    return finalize(result);
  }

  // 6. Multiple candidate lanes → AMBIGUOUS.
  if (candidateLanes.length > 1) {
    result.route_status = 'AMBIGUOUS';
    result.candidate_lanes = candidateLanes;
    result.matched_signals = candidateLanes.flatMap(l => candidates.get(l));
    result.needed_clarification.push(
      'Multiple lane signals matched — confirm whether market is win, a specific top-N finish, or fastest_lap',
    );
    result.confidence = 40;
    return finalize(result);
  }

  // 7. No lane matched but looks NASCAR-ish → BLOCKED with clarification.
  if (looksNascar) {
    result.route_status = 'BLOCKED';
    result.needed_clarification.push(
      'NASCAR-related market but title/rules do not identify a supported race-market lane (win / top3 / top5 / top10 / top20 / fastest_lap)',
    );
    result.confidence = 25;
    if (signals.length) result.matched_signals = signals;
    return finalize(result);
  }

  // 8. Otherwise out of scope.
  result.route_status = 'OUT_OF_SCOPE';
  result.reject_signals.push('no NASCAR race-market signals detected');
  result.confidence = 10;
  return finalize(result);
}

export function assertNoTradeDecisionStatus(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Router result is not an object');
  }
  // Status must be one of the allowed router statuses.
  if (!ROUTE_STATUSES.includes(result.route_status)) {
    throw new Error(`Router emitted non-router route_status: ${result.route_status}`);
  }
  // Top-level keys must not include forbidden price/pick/ceiling fields.
  for (const key of Object.keys(result)) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      throw new Error(`Router result contains forbidden field: ${key}`);
    }
  }
  // Serialized form must not include any trading-decision status string.
  const serialized = JSON.stringify(result);
  for (const status of NON_ROUTER_STATUSES) {
    // Match as a whole token to avoid false positives on substrings.
    const re = new RegExp(`"${status}"`);
    if (re.test(serialized)) {
      throw new Error(`Router result contains non-router status: ${status}`);
    }
  }
  return true;
}
