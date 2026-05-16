const MLB_SCHEDULE_BASE_URL = 'https://statsapi.mlb.com/api/v1/schedule';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function makeEnvelope({ status, checkedAtUtc, cachePath, records = [], warnings = [], errors = [], sourceUrls = [] }) {
  return {
    source_id: 'mlb_official',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `mlb_official_schedule_${checkedAtUtc}`,
    cache_path: cachePath,
    required: true,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

export function buildMlbScheduleUrl(runDate) {
  const url = new URL(MLB_SCHEDULE_BASE_URL);
  url.searchParams.set('sportId', '1');
  url.searchParams.set('date', runDate);
  url.searchParams.set('hydrate', 'probablePitcher,team,venue(timezone)');
  return url.toString();
}

export function normalizeMlbSchedulePayload(payload = {}) {
  const games = Array.isArray(payload.dates)
    ? payload.dates.flatMap(dateEntry => (Array.isArray(dateEntry.games) ? dateEntry.games : []))
    : [];

  return games.map(game => ({
    game_pk: game.gamePk ?? null,
    game_date: game.officialDate ?? null,
    start_time_utc: game.gameDate ?? null,
    away_team: game.teams?.away?.team?.name ?? null,
    home_team: game.teams?.home?.team?.name ?? null,
    mlb_status: game.status?.detailedState ?? game.status?.abstractGameState ?? null,
    probable_pitchers: {
      away: game.teams?.away?.probablePitcher?.fullName ?? null,
      home: game.teams?.home?.probablePitcher?.fullName ?? null,
      away_id: game.teams?.away?.probablePitcher?.id ?? null,
      home_id: game.teams?.home?.probablePitcher?.id ?? null,
    },
    venue: game.venue?.name ?? null,
    venue_timezone: game.venue?.timeZone?.id ?? null,
  }));
}

export function fixtureMlbScheduleEnvelope({ runDate, checkedAtUtc = '2026-05-15T14:00:00.000Z', outputDir }) {
  return makeEnvelope({
    status: 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/mlb_official_adapter.json`,
    records: [
      {
        game_pk: 100001,
        game_date: runDate,
        start_time_utc: `${runDate}T23:05:00Z`,
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        mlb_status: 'Preview',
        probable_pitchers: {
          away: 'Placeholder Pitcher A',
          home: 'Placeholder Pitcher B',
        },
        venue: 'Placeholder Park',
      },
    ],
    warnings: ['Fixture mode: no live MLB source was called.'],
    sourceUrls: [buildMlbScheduleUrl(runDate)],
  });
}

export async function fetchMlbScheduleReadonly({
  runDate,
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const checkedAtUtc = isoNow(now);
  if (fixturesOnly) {
    return fixtureMlbScheduleEnvelope({ runDate, checkedAtUtc, outputDir });
  }

  const sourceUrl = buildMlbScheduleUrl(runDate);
  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/mlb_official_adapter.json`,
      errors: ['No fetch implementation available for live-readonly MLB schedule request.'],
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
        cachePath: `${outputDir}/mlb_official_adapter.json`,
        errors: [`MLB Stats API returned HTTP ${response.status}.`],
        sourceUrls: [sourceUrl],
      });
    }

    const payload = await response.json();
    const records = normalizeMlbSchedulePayload(payload);
    return makeEnvelope({
      status: records.length > 0 ? 'ok' : 'degraded',
      checkedAtUtc,
      cachePath: `${outputDir}/mlb_official_adapter.json`,
      records,
      warnings: records.length > 0 ? [] : ['MLB Stats API returned no games for the requested date.'],
      sourceUrls: [sourceUrl],
    });
  } catch (error) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/mlb_official_adapter.json`,
      errors: [error instanceof Error ? error.message : String(error)],
      sourceUrls: [sourceUrl],
    });
  }
}
