import { routeMlbMarket } from '../router-core.mjs';

export const KALSHI_BASEBALL_CALENDAR_URL = 'https://kalshi.com/calendar/sports/baseball';
export const KALSHI_READONLY_EVENT_URLS = Object.freeze([
  'https://api.elections.kalshi.com/trade-api/v2/events',
  'https://external-api.kalshi.com/trade-api/v2/events',
]);
export const KALSHI_MLB_SERIES = Object.freeze(['KXMLBGAME', 'KXMLBTOTAL']);

const EXCLUDED_MARKET_PATTERNS = [
  /entertainment/i,
  /pirates of the caribbean/i,
  /\bdebut date\b/i,
  /\bmlb debut\b/i,
  /play in a game for any team in the mlb before/i,
  /\bworld series\b/i,
  /\bpennant\b/i,
  /\bdivision\b/i,
  /\bcy young\b/i,
  /\bmvp\b/i,
  /\brookie of the year\b/i,
  /\bseason[- ]long\b/i,
  /\bstandings\b/i,
  /\bfutures?\b/i,
];

const TEAM_NICKNAME_OVERRIDES = new Map([
  ['Arizona Diamondbacks', 'diamondbacks'],
  ['Athletics', 'athletics'],
  ['Atlanta Braves', 'braves'],
  ['Baltimore Orioles', 'orioles'],
  ['Boston Red Sox', 'red sox'],
  ['Chicago Cubs', 'cubs'],
  ['Chicago White Sox', 'white sox'],
  ['Cincinnati Reds', 'reds'],
  ['Cleveland Guardians', 'guardians'],
  ['Colorado Rockies', 'rockies'],
  ['Detroit Tigers', 'tigers'],
  ['Houston Astros', 'astros'],
  ['Kansas City Royals', 'royals'],
  ['Los Angeles Angels', 'angels'],
  ['Los Angeles Dodgers', 'dodgers'],
  ['Miami Marlins', 'marlins'],
  ['Milwaukee Brewers', 'brewers'],
  ['Minnesota Twins', 'twins'],
  ['New York Mets', 'mets'],
  ['New York Yankees', 'yankees'],
  ['Philadelphia Phillies', 'phillies'],
  ['Pittsburgh Pirates', 'pirates'],
  ['San Diego Padres', 'padres'],
  ['San Francisco Giants', 'giants'],
  ['Seattle Mariners', 'mariners'],
  ['St. Louis Cardinals', 'cardinals'],
  ['Tampa Bay Rays', 'rays'],
  ['Texas Rangers', 'rangers'],
  ['Toronto Blue Jays', 'blue jays'],
  ['Washington Nationals', 'nationals'],
]);

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function makeEnvelope({
  status,
  checkedAtUtc,
  cachePath,
  records = [],
  rejectedRecords = [],
  warnings = [],
  errors = [],
  sourceUrls = [],
}) {
  return {
    source_id: 'kalshi',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `kalshi_baseball_discovery_${checkedAtUtc}`,
    cache_path: cachePath,
    required: true,
    records,
    rejected_records: rejectedRecords,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(text);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function teamAliases(teamName, { includeLocation = false } = {}) {
  const normalized = normalizeText(teamName);
  const nickname = normalizeText(TEAM_NICKNAME_OVERRIDES.get(teamName) ?? normalized.split(' ').at(-1));
  const location = normalizeText(normalized.replace(new RegExp(`${nickname}$`), ''));
  return [
    ...new Set(
      [
        normalized,
        nickname,
        ...(includeLocation ? [location] : []),
      ].filter(alias => alias.length >= 3),
    ),
  ];
}

function hasBaseballContext(event = {}) {
  const text = normalizeText(eventText(event));
  return (
    /\b(mlb|baseball|major league baseball)\b/.test(text) ||
    /\bkxmlb\b/.test(text) ||
    /\bbaseball\b/.test(normalizeText(event.category))
  );
}

function gameMatchesText(game, text, { includeLocation = false } = {}) {
  const normalized = normalizeText(text);
  const awayMatches = teamAliases(game.away_team, { includeLocation }).some(alias => containsPhrase(normalized, alias));
  const homeMatches = teamAliases(game.home_team, { includeLocation }).some(alias => containsPhrase(normalized, alias));
  return awayMatches && homeMatches;
}

function eventText(event = {}) {
  const markets = Array.isArray(event.markets) ? event.markets : [];
  return [
    event.title,
    event.sub_title,
    event.category,
    event.series_ticker,
    event.event_ticker,
    ...markets.flatMap(market => [
      market.title,
      market.yes_sub_title,
      market.subtitle,
      market.rules_primary,
      market.rules_summary,
      market.ticker,
    ]),
  ]
    .filter(Boolean)
    .join(' ');
}

function eventDateFromTicker(ticker) {
  const match = String(ticker ?? '').match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!match) return null;
  const [, yy, mon, dd] = match;
  const month = {
    JAN: '01',
    FEB: '02',
    MAR: '03',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AUG: '08',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DEC: '12',
  }[mon];
  return month ? `20${yy}-${month}-${dd}` : null;
}

function eventPairCode(ticker) {
  return String(ticker ?? '').match(/\d{2}[A-Z]{3}\d{2}\d{4}([A-Z]+)$/)?.[1] ?? null;
}

const TEAM_CODES = new Map([
  ['Arizona Diamondbacks', 'AZ'],
  ['Athletics', 'ATH'],
  ['Atlanta Braves', 'ATL'],
  ['Baltimore Orioles', 'BAL'],
  ['Boston Red Sox', 'BOS'],
  ['Chicago Cubs', 'CHC'],
  ['Chicago White Sox', 'CWS'],
  ['Cincinnati Reds', 'CIN'],
  ['Cleveland Guardians', 'CLE'],
  ['Colorado Rockies', 'COL'],
  ['Detroit Tigers', 'DET'],
  ['Houston Astros', 'HOU'],
  ['Kansas City Royals', 'KC'],
  ['Los Angeles Angels', 'LAA'],
  ['Los Angeles Dodgers', 'LAD'],
  ['Miami Marlins', 'MIA'],
  ['Milwaukee Brewers', 'MIL'],
  ['Minnesota Twins', 'MIN'],
  ['New York Mets', 'NYM'],
  ['New York Yankees', 'NYY'],
  ['Philadelphia Phillies', 'PHI'],
  ['Pittsburgh Pirates', 'PIT'],
  ['San Diego Padres', 'SD'],
  ['San Francisco Giants', 'SF'],
  ['Seattle Mariners', 'SEA'],
  ['St. Louis Cardinals', 'STL'],
  ['Tampa Bay Rays', 'TB'],
  ['Texas Rangers', 'TEX'],
  ['Toronto Blue Jays', 'TOR'],
  ['Washington Nationals', 'WSH'],
]);

function marketTeamCode(ticker) {
  return String(ticker ?? '').split('-').at(-1) ?? null;
}

function moneylineGameMatch(event, officialMlbGames) {
  const code = eventPairCode(event.event_ticker);
  if (!code) return null;
  return officialMlbGames.find(game => {
    const away = TEAM_CODES.get(game.away_team);
    const home = TEAM_CODES.get(game.home_team);
    return away && home && code === `${away}${home}`;
  }) ?? null;
}

function totalStrike(market = {}) {
  const text = [market.yes_sub_title, market.title, market.rules_primary].filter(Boolean).join(' ');
  const match = text.match(/\b(?:over|more than)\s+(\d+(?:\.\d+)?)\s+runs?/i);
  return match ? Number(match[1]) : null;
}

function dollars(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMarketFields({ event, market, matchedGame, lane }) {
  const route = routeMlbMarket({
    event_title: event.title ?? null,
    market_title: market.title ?? market.yes_sub_title ?? market.ticker ?? null,
    contract_title: market.yes_sub_title ?? null,
    rules_summary: market.rules_primary ?? market.rules_summary ?? null,
    event_ticker: event.event_ticker ?? null,
    market_ticker: market.ticker ?? null,
  });
  const teamCode = lane === 'moneyline' ? marketTeamCode(market.ticker) : null;
  const side =
    teamCode && TEAM_CODES.get(matchedGame?.away_team) === teamCode
      ? 'away'
      : teamCode && TEAM_CODES.get(matchedGame?.home_team) === teamCode
        ? 'home'
        : null;

  return {
    event_ticker: event.event_ticker ?? null,
    market_ticker: market.ticker ?? null,
    market_title: market.title ?? market.yes_sub_title ?? market.ticker ?? null,
    contract_title: market.yes_sub_title ?? null,
    team_side: side,
    team_name: side ? matchedGame?.[`${side}_team`] ?? null : null,
    team_code: teamCode,
    yes_bid: dollars(market.yes_bid_dollars ?? market.yes_bid),
    yes_ask: dollars(market.yes_ask_dollars ?? market.yes_ask),
    no_bid: dollars(market.no_bid_dollars ?? market.no_bid),
    no_ask: dollars(market.no_ask_dollars ?? market.no_ask),
    last_price: dollars(market.last_price_dollars ?? market.last_price),
    previous_price: dollars(market.previous_price_dollars ?? market.previous_price),
    volume: dollars(market.volume_fp ?? market.volume_dollars ?? market.volume),
    volume_24h: dollars(market.volume_24h_fp ?? market.volume_24h),
    open_interest: dollars(market.open_interest_fp ?? market.open_interest),
    liquidity: dollars(market.liquidity_dollars ?? market.liquidity),
    status: market.status ?? null,
    result: market.result ?? '',
    open_time: market.open_time ?? null,
    close_time: market.close_time ?? null,
    occurrence_datetime: market.occurrence_datetime ?? event.occurrence_datetime ?? null,
    expected_expiration_time: market.expected_expiration_time ?? null,
    source_url: `https://api.elections.kalshi.com/trade-api/v2/markets/${market.ticker}`,
    route_status: lane ? 'ROUTED' : route.route_status,
    market_lane: lane ?? route.market_lane,
    candidate_lanes: lane ? [lane] : route.candidate_lanes,
    total_strike: lane === 'game_total' ? totalStrike(market) : null,
  };
}

function exclusionReason(event = {}) {
  const text = eventText(event);
  const matched = EXCLUDED_MARKET_PATTERNS.find(pattern => pattern.test(text));
  return matched ? `excluded non-same-day game market: ${matched.source}` : null;
}

function officialGameMatches(event = {}, officialMlbGames = []) {
  const text = eventText(event);
  return officialMlbGames.filter(game => gameMatchesText(game, text, { includeLocation: hasBaseballContext(event) }));
}

function isMlbCandidate(event = {}, officialMlbGames = []) {
  const normalized = normalizeText(eventText(event));
  if (hasBaseballContext(event)) {
    return true;
  }

  return officialMlbGames.some(game => {
    const aliases = [
      ...teamAliases(game.away_team),
      ...teamAliases(game.home_team),
    ];
    return aliases.some(alias => containsPhrase(normalized, alias));
  });
}

function rejectEvent(event, reason) {
  return {
    event_ticker: event.event_ticker ?? null,
    series_ticker: event.series_ticker ?? null,
    event_title: event.title ?? null,
    category: event.category ?? null,
    sub_title: event.sub_title ?? null,
    reason,
  };
}

function challengeDetected(status, bodyText = '') {
  const text = bodyText.toLowerCase();
  return (
    status === 403 ||
    status === 429 ||
    text.includes('challenge') ||
    text.includes('x-vercel-challenge') ||
    text.includes('cf-chl') ||
    text.includes('captcha')
  );
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKalshiEvent(event = {}, matchedGame = null) {
  const title = event.title ?? null;
  const markets = Array.isArray(event.markets) ? event.markets : [];
  const routedMarkets = markets.map(market => {
    const marketTitle = market.title ?? market.yes_sub_title ?? market.ticker ?? null;
    const route = routeMlbMarket({
      event_title: title,
      market_title: marketTitle,
      contract_title: market.yes_sub_title ?? null,
      rules_summary: market.rules_primary ?? market.rules_summary ?? null,
      event_ticker: event.event_ticker ?? null,
      market_ticker: market.ticker ?? null,
    });

    return {
      market_ticker: market.ticker ?? null,
      market_title: marketTitle,
      contract_title: market.yes_sub_title ?? null,
      route_status: route.route_status,
      market_lane: route.market_lane,
      candidate_lanes: route.candidate_lanes,
    };
  });

  return {
    event_ticker: event.event_ticker ?? null,
    series_ticker: event.series_ticker ?? null,
    event_title: title,
    category: event.category ?? null,
    sub_title: event.sub_title ?? null,
    matched_game_pk: matchedGame?.game_pk ?? null,
    matched_game: matchedGame ? `${matchedGame.away_team} at ${matchedGame.home_team}` : null,
    markets: routedMarkets,
  };
}

function normalizeSameDayEvent({ event, matchedGame, lane }) {
  const markets = (Array.isArray(event.markets) ? event.markets : [])
    .filter(market => !String(market.result ?? '').trim())
    .map(market => normalizeMarketFields({ event, market, matchedGame, lane }))
    .filter(market => market.market_ticker);

  return {
    event_ticker: event.event_ticker ?? null,
    series_ticker: event.series_ticker ?? null,
    event_title: event.title ?? null,
    market_title: event.title ?? null,
    category: event.category ?? null,
    sub_title: event.sub_title ?? null,
    game_date: matchedGame?.game_date ?? eventDateFromTicker(event.event_ticker),
    matched_game_pk: matchedGame?.game_pk ?? null,
    matched_game: matchedGame ? `${matchedGame.away_team} at ${matchedGame.home_team}` : null,
    away_team: matchedGame?.away_team ?? null,
    home_team: matchedGame?.home_team ?? null,
    start_time_utc: matchedGame?.start_time_utc ?? null,
    markets,
  };
}

async function fetchJsonIfOk(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
    },
  });
  if (!response.ok) {
    return { ok: false, status: response.status, payload: null };
  }
  return { ok: true, status: response.status, payload: await response.json() };
}

export function fixtureKalshiSuccessEnvelope({ checkedAtUtc = '2026-05-15T14:00:00.000Z', outputDir }) {
  return makeEnvelope({
    status: 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/kalshi_adapter.json`,
    records: [
      {
        event_ticker: 'KXMLB-PLACEHOLDER-001',
        series_ticker: 'KXMLB-PLACEHOLDER',
        event_title: 'Alpha City Aces at Beta Town Bears',
        category: 'Sports',
        sub_title: 'Placeholder MLB game',
        markets: [
          {
            market_ticker: 'KXMLB-PLACEHOLDER-001-WINNER',
            market_title: 'Will the Alpha City Aces beat the Beta Town Bears?',
            contract_title: null,
            route_status: 'ROUTED',
            market_lane: 'moneyline',
            candidate_lanes: ['moneyline'],
          },
        ],
      },
    ],
    warnings: ['Fixture mode: no live Kalshi source was called.'],
    sourceUrls: [KALSHI_BASEBALL_CALENDAR_URL],
  });
}

export function fixtureKalshiBlockedEnvelope({ checkedAtUtc = '2026-05-15T14:00:00.000Z', outputDir }) {
  return makeEnvelope({
    status: 'degraded',
    checkedAtUtc,
    cachePath: `${outputDir}/kalshi_adapter.json`,
    warnings: ['Fixture challenge: Kalshi calendar was blocked/challenge-gated.'],
    errors: ['Kalshi calendar returned HTTP 429/challenge in fixture mode.'],
    sourceUrls: [KALSHI_BASEBALL_CALENDAR_URL],
  });
}

export async function fetchKalshiReadonly({
  runDate = null,
  outputDir,
  fixturesOnly = true,
  fixture = 'success',
  fetchImpl = globalThis.fetch,
  now = new Date(),
  maxApiPages = 3,
  officialMlbGames = [],
} = {}) {
  const checkedAtUtc = isoNow(now);
  if (fixturesOnly) {
    return fixture === 'blocked'
      ? fixtureKalshiBlockedEnvelope({ checkedAtUtc, outputDir })
      : fixtureKalshiSuccessEnvelope({ checkedAtUtc, outputDir });
  }

  const sourceUrls = [KALSHI_BASEBALL_CALENDAR_URL];
  const warnings = [];
  const errors = [];
  const records = [];
  const recordKeys = new Set();
  const rejectedRecords = [];
  const rejectedKeys = new Set();
  const pushRejected = (event, reason) => {
    const rejected = rejectEvent(event, reason);
    const key = `${rejected.event_ticker ?? ''}|${rejected.event_title ?? ''}|${reason}`;
    if (!rejectedKeys.has(key)) {
      rejectedKeys.add(key);
      rejectedRecords.push(rejected);
    }
  };

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/kalshi_adapter.json`,
      errors: ['No fetch implementation available for live-readonly Kalshi discovery.'],
      sourceUrls,
    });
  }

  try {
    const calendarResponse = await fetchImpl(KALSHI_BASEBALL_CALENDAR_URL, {
      method: 'GET',
      headers: {
        accept: 'text/html',
        'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
      },
    });
    const bodyText = await calendarResponse.text();
    if (calendarResponse.ok && !challengeDetected(calendarResponse.status, bodyText)) {
      const visibleText = stripHtml(bodyText);
      warnings.push(
        visibleText
          ? 'Kalshi calendar was accessible, but live discovery keeps only API records that match today official MLB games.'
          : 'Kalshi calendar was accessible, but no visible text was captured.',
      );
    } else {
      warnings.push(`Kalshi calendar inaccessible or challenge-gated: HTTP ${calendarResponse.status}.`);
    }
  } catch (error) {
    warnings.push(`Kalshi calendar fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const endpointSpecs = [
    ...KALSHI_READONLY_EVENT_URLS.flatMap(baseUrl =>
      KALSHI_MLB_SERIES.map(seriesTicker => ({ baseUrl, seriesTicker, maxPages: 2 })),
    ),
    ...KALSHI_READONLY_EVENT_URLS.map(baseUrl => ({ baseUrl, seriesTicker: null, maxPages: maxApiPages })),
  ];

  for (const { baseUrl, seriesTicker, maxPages } of endpointSpecs) {
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(baseUrl);
      url.searchParams.set('limit', '200');
      url.searchParams.set('status', 'open');
      url.searchParams.set('with_nested_markets', 'true');
      if (seriesTicker) url.searchParams.set('series_ticker', seriesTicker);
      if (cursor) url.searchParams.set('cursor', cursor);
      const urlString = url.toString();
      sourceUrls.push(urlString);

      try {
        const result = await fetchJsonIfOk(fetchImpl, urlString);
        if (!result.ok) {
          warnings.push(`Kalshi read-only event API ${baseUrl} returned HTTP ${result.status}.`);
          break;
        }

        const events = Array.isArray(result.payload?.events) ? result.payload.events : [];
        for (const event of events) {
          const eventDate = eventDateFromTicker(event.event_ticker);
          if (runDate && eventDate && eventDate !== runDate) {
            pushRejected(event, `date mismatch: event date ${eventDate} != run date ${runDate}`);
            continue;
          }

          if (safeArray(event.markets).some(market => String(market.result ?? '').trim())) {
            pushRejected(event, 'market has non-empty result field');
            continue;
          }

          if (event.series_ticker === 'KXMLBGAME' || event.series_ticker === 'KXMLBTOTAL') {
            if (officialMlbGames.length === 0) {
              pushRejected(event, 'no official MLB schedule whitelist supplied');
              continue;
            }
            const matchedGame = moneylineGameMatch(event, officialMlbGames) ?? officialGameMatches(event, officialMlbGames)[0] ?? null;
            if (!matchedGame) {
              pushRejected(event, 'no same-day official MLB game match');
              continue;
            }
            if (runDate && matchedGame.game_date !== runDate) {
              pushRejected(event, `official game date mismatch: ${matchedGame.game_date} != ${runDate}`);
              continue;
            }
            const lane = event.series_ticker === 'KXMLBTOTAL' ? 'game_total' : 'moneyline';
            const normalized = normalizeSameDayEvent({ event, matchedGame, lane });
            if (normalized.markets.length > 0 && !recordKeys.has(normalized.event_ticker)) {
              recordKeys.add(normalized.event_ticker);
              records.push(normalized);
            }
            continue;
          }

          if (!isMlbCandidate(event, officialMlbGames)) {
            continue;
          }

          const excluded = exclusionReason(event);
          if (excluded) {
            pushRejected(event, excluded);
            continue;
          }

          if (officialMlbGames.length === 0) {
            pushRejected(event, 'no official MLB schedule whitelist supplied');
            continue;
          }

          const matches = officialGameMatches(event, officialMlbGames);
          if (matches.length === 1) {
            if (!recordKeys.has(event.event_ticker)) {
              recordKeys.add(event.event_ticker);
              records.push(normalizeKalshiEvent(event, matches[0]));
            }
          } else if (matches.length > 1) {
            pushRejected(event, 'matched multiple official MLB games');
          } else {
            pushRejected(event, 'no same-day official MLB game match');
          }
        }

        cursor = result.payload?.cursor ?? null;
        if (!cursor || events.length === 0) break;
      } catch (error) {
        warnings.push(`Kalshi read-only event API failed: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }

  if (records.length > 0) {
    return makeEnvelope({
      status: warnings.length > 0 ? 'degraded' : 'ok',
      checkedAtUtc,
      cachePath: `${outputDir}/kalshi_adapter.json`,
      records,
      rejectedRecords,
      warnings,
      errors,
      sourceUrls,
    });
  }

  return makeEnvelope({
    status: warnings.length > 0 ? 'degraded' : 'blocked',
    checkedAtUtc,
    cachePath: `${outputDir}/kalshi_adapter.json`,
    warnings: [
      ...warnings,
      'No Kalshi baseball records were discovered through public read-only calendar/API access.',
    ],
    rejectedRecords,
    errors,
    sourceUrls,
  });
}
