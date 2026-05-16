export const ESPN_MLB_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function makeEnvelope({ status, checkedAtUtc, cachePath, records = [], warnings = [], errors = [], sourceUrls = [] }) {
  return {
    source_id: 'sportsbook_reference',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `sportsbook_reference_${checkedAtUtc}`,
    cache_path: cachePath,
    required: false,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function yyyymmdd(runDate) {
  return String(runDate ?? '').replace(/-/g, '');
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function americanToProb(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^(EVEN|EV)$/i.test(text)) return 0.5;
  const odds = Number(text.replace('+', ''));
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function round4(value) {
  return value === null || value === undefined ? null : Math.round(value * 10000) / 10000;
}

function teamByHomeAway(competition, homeAway) {
  return safeArray(competition?.competitors).find(competitor => competitor.homeAway === homeAway)?.team?.displayName ?? null;
}

function normalizeEvent({ event, checkedAtUtc, sourceUrl }) {
  const competition = safeArray(event.competitions)[0] ?? null;
  const odds = safeArray(competition?.odds)[0] ?? null;
  const moneyline = odds?.moneyline ?? null;
  const awayMoneyline = moneyline?.away?.close?.odds ?? null;
  const homeMoneyline = moneyline?.home?.close?.odds ?? null;
  const awayRaw = americanToProb(awayMoneyline);
  const homeRaw = americanToProb(homeMoneyline);
  const denom = awayRaw !== null && homeRaw !== null ? awayRaw + homeRaw : null;
  const awayNoVig = denom ? awayRaw / denom : null;
  const homeNoVig = denom ? homeRaw / denom : null;

  return {
    query_type: 'sportsbook_no_vig_reference',
    espn_event_id: event.id ?? null,
    checked_at_utc: checkedAtUtc,
    game: event.name ?? null,
    start_time_utc: event.date ?? null,
    away_team: teamByHomeAway(competition, 'away'),
    home_team: teamByHomeAway(competition, 'home'),
    venue: competition?.venue?.fullName ?? null,
    provider: odds?.provider?.displayName ?? odds?.provider?.name ?? null,
    details: odds?.details ?? null,
    away_moneyline: awayMoneyline,
    home_moneyline: homeMoneyline,
    away_implied_raw: round4(awayRaw),
    home_implied_raw: round4(homeRaw),
    away_no_vig_fair: round4(awayNoVig),
    home_no_vig_fair: round4(homeNoVig),
    over_under: odds?.overUnder ?? null,
    total_over_odds: odds?.total?.over?.close?.odds ?? null,
    total_under_odds: odds?.total?.under?.close?.odds ?? null,
    source_urls: [sourceUrl],
    usage_note: 'Sportsbook odds are reference-only no-vig fair value inputs; they are not Kalshi prices.',
  };
}

export function buildEspnScoreboardUrl(runDate) {
  const url = new URL(ESPN_MLB_SCOREBOARD_URL);
  url.searchParams.set('dates', yyyymmdd(runDate));
  url.searchParams.set('limit', '100');
  return url.toString();
}

export async function fetchSportsbookReadonly({
  runDate,
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const checkedAtUtc = isoNow(now);
  const sourceUrl = buildEspnScoreboardUrl(runDate);
  if (fixturesOnly) {
    return makeEnvelope({
      status: 'ok',
      checkedAtUtc,
      cachePath: `${outputDir}/sportsbook_adapter.json`,
      records: [],
      warnings: ['Fixture mode: no sportsbook reference source was called.'],
      sourceUrls: [sourceUrl],
    });
  }

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/sportsbook_adapter.json`,
      errors: ['No fetch implementation available for live-readonly sportsbook reference request.'],
      sourceUrls: [sourceUrl],
    });
  }

  try {
    const response = await fetchImpl(sourceUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
      },
    });
    if (!response.ok) {
      return makeEnvelope({
        status: 'blocked',
        checkedAtUtc,
        cachePath: `${outputDir}/sportsbook_adapter.json`,
        errors: [`ESPN scoreboard returned HTTP ${response.status}.`],
        sourceUrls: [sourceUrl],
      });
    }

    const payload = await response.json();
    const records = safeArray(payload.events).map(event => normalizeEvent({ event, checkedAtUtc, sourceUrl }));
    return makeEnvelope({
      status: records.some(record => record.away_no_vig_fair !== null && record.home_no_vig_fair !== null) ? 'ok' : 'degraded',
      checkedAtUtc,
      cachePath: `${outputDir}/sportsbook_adapter.json`,
      records,
      warnings: ['Sportsbook reference records are not Kalshi prices and are never executable prices.'],
      sourceUrls: [sourceUrl],
    });
  } catch (error) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/sportsbook_adapter.json`,
      errors: [error instanceof Error ? error.message : String(error)],
      sourceUrls: [sourceUrl],
    });
  }
}
