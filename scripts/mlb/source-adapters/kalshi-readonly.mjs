import { routeMlbMarket } from '../router-core.mjs';

export const KALSHI_BASEBALL_CALENDAR_URL = 'https://kalshi.com/calendar/sports/baseball';
export const KALSHI_READONLY_EVENT_URLS = Object.freeze([
  'https://api.elections.kalshi.com/trade-api/v2/events',
  'https://external-api.kalshi.com/trade-api/v2/events',
]);

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

  for (const baseUrl of KALSHI_READONLY_EVENT_URLS) {
    let cursor = null;
    for (let page = 0; page < maxApiPages; page += 1) {
      const url = new URL(baseUrl);
      url.searchParams.set('limit', '200');
      url.searchParams.set('status', 'open');
      url.searchParams.set('with_nested_markets', 'true');
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
            records.push(normalizeKalshiEvent(event, matches[0]));
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
    if (records.length > 0) break;
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
