export const MLB_LIVE_FEED_BASE = 'https://statsapi.mlb.com/api/v1.1/game';
export const ESPN_SUMMARY_BASE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function makeEnvelope({ status, checkedAtUtc, cachePath, records = [], warnings = [], errors = [], sourceUrls = [] }) {
  return {
    source_id: 'lineup_injury_bullpen',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `lineup_injury_bullpen_${checkedAtUtc}`,
    cache_path: cachePath,
    required: false,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function liveFeedUrl(gamePk) {
  return `${MLB_LIVE_FEED_BASE}/${gamePk}/feed/live`;
}

function espnSummaryUrl(eventId) {
  const url = new URL(ESPN_SUMMARY_BASE);
  url.searchParams.set('event', eventId);
  return url.toString();
}

function flattenInjuries(summary) {
  return safeArray(summary?.injuries).flatMap(teamEntry =>
    safeArray(teamEntry.injuries).slice(0, 8).map(injury => ({
      team: teamEntry.team?.displayName ?? null,
      player: injury.athlete?.displayName ?? injury.athlete?.fullName ?? null,
      status: injury.status ?? injury.type?.description ?? null,
      position: injury.athlete?.position?.abbreviation ?? null,
      detail: [
        injury.details?.side,
        injury.details?.type,
        injury.details?.detail,
      ].filter(Boolean).join(' '),
      return_date: injury.details?.returnDate ?? null,
      updated_at: injury.date ?? null,
    })),
  );
}

function probablePitcherStats(summary) {
  const rows = [];
  for (const competitor of safeArray(summary?.header?.competitions?.[0]?.competitors)) {
    for (const probable of safeArray(competitor.probables)) {
      rows.push({
        team: competitor.team?.displayName ?? null,
        player: probable.athlete?.displayName ?? probable.athlete?.fullName ?? null,
        record: probable.record ?? null,
        era: safeArray(probable.statistics).find(stat => stat.abbreviation === 'ERA')?.displayValue ?? null,
        wins: safeArray(probable.statistics).find(stat => stat.abbreviation === 'W')?.displayValue ?? null,
        losses: safeArray(probable.statistics).find(stat => stat.abbreviation === 'L')?.displayValue ?? null,
      });
    }
  }
  return rows;
}

function lineupStatus(livePayload) {
  const batters = safeArray(livePayload?.liveData?.boxscore?.teams?.away?.batters).length
    + safeArray(livePayload?.liveData?.boxscore?.teams?.home?.batters).length;
  return batters >= 18 ? 'confirmed_or_boxscore_available' : 'lineup_pending';
}

function bullpenNote(summary) {
  const notes = safeArray(summary?.notes).map(note => note.headline ?? note.text).filter(Boolean);
  const bullpen = notes.find(note => /bullpen|relief|reliever|pitch/i.test(note));
  return bullpen ?? 'No machine-readable bullpen workload summary available from ESPN/MLB feed.';
}

function normalizeRecord({ game, checkedAtUtc, livePayload, summaryPayload, sourceUrls }) {
  const injuries = flattenInjuries(summaryPayload);
  return {
    query_type: 'lineup_injury_bullpen_context',
    game_pk: game.game_pk ?? null,
    espn_event_id: game.espn_event_id ?? null,
    game_date: game.game_date ?? null,
    game: `${game.away_team ?? 'Unknown Away'} at ${game.home_team ?? 'Unknown Home'}`,
    away_team: game.away_team ?? null,
    home_team: game.home_team ?? null,
    checked_at_utc: checkedAtUtc,
    lineup_status: lineupStatus(livePayload),
    probable_pitchers: {
      away: livePayload?.gameData?.probablePitchers?.away?.fullName ?? game.probable_pitchers?.away ?? null,
      home: livePayload?.gameData?.probablePitchers?.home?.fullName ?? game.probable_pitchers?.home ?? null,
    },
    probable_pitcher_stats: probablePitcherStats(summaryPayload),
    key_injuries: injuries,
    injury_status: injuries.length > 0 ? 'injury_records_available' : 'no_machine_readable_injury_records',
    bullpen_usage_note: bullpenNote(summaryPayload),
    weather_from_mlb_feed: livePayload?.gameData?.weather ?? null,
    venue_roof_type: livePayload?.gameData?.venue?.fieldInfo?.roofType ?? null,
    source_urls: sourceUrls,
  };
}

export async function fetchContextReadonly({
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  mlbGames = [],
  sportsbookRecords = [],
} = {}) {
  const checkedAtUtc = isoNow(now);
  if (fixturesOnly) {
    return makeEnvelope({
      status: 'ok',
      checkedAtUtc,
      cachePath: `${outputDir}/context_adapter.json`,
      records: [],
      warnings: ['Fixture mode: no live lineup/injury/bullpen source was called.'],
      sourceUrls: [MLB_LIVE_FEED_BASE, ESPN_SUMMARY_BASE],
    });
  }

  const warnings = [];
  const errors = [];
  const records = [];
  const sourceUrls = [];
  const espnByGame = new Map(
    safeArray(sportsbookRecords).map(record => [`${record.away_team}|${record.home_team}`, record.espn_event_id]),
  );

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/context_adapter.json`,
      errors: ['No fetch implementation available for live-readonly context request.'],
      sourceUrls,
    });
  }

  for (const game of safeArray(mlbGames)) {
    const gameSourceUrls = [];
    const feedUrl = liveFeedUrl(game.game_pk);
    const espnEventId = espnByGame.get(`${game.away_team}|${game.home_team}`) ?? null;
    const summaryUrl = espnEventId ? espnSummaryUrl(espnEventId) : null;
    gameSourceUrls.push(feedUrl);
    if (summaryUrl) gameSourceUrls.push(summaryUrl);
    sourceUrls.push(...gameSourceUrls);

    try {
      const liveResponse = await fetchImpl(feedUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
        },
      });
      if (!liveResponse.ok) {
        warnings.push(`MLB live feed returned HTTP ${liveResponse.status} for ${feedUrl}.`);
        continue;
      }
      const livePayload = await liveResponse.json();
      let summaryPayload = {};
      if (summaryUrl) {
        const summaryResponse = await fetchImpl(summaryUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
          },
        });
        if (summaryResponse.ok) {
          summaryPayload = await summaryResponse.json();
        } else {
          warnings.push(`ESPN summary returned HTTP ${summaryResponse.status} for ${summaryUrl}.`);
        }
      } else {
        warnings.push(`No ESPN event id available for ${game.away_team} at ${game.home_team}.`);
      }

      records.push(normalizeRecord({
        game: { ...game, espn_event_id: espnEventId },
        checkedAtUtc,
        livePayload,
        summaryPayload,
        sourceUrls: gameSourceUrls,
      }));
    } catch (error) {
      warnings.push(`Context fetch failed for ${game.away_team} at ${game.home_team}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return makeEnvelope({
    status: records.length > 0 ? (warnings.length > 0 ? 'degraded' : 'ok') : 'blocked',
    checkedAtUtc,
    cachePath: `${outputDir}/context_adapter.json`,
    records,
    warnings: [
      ...warnings,
      'Lineup pending is a disclosed evidence state, not a full-slate blocker.',
    ],
    errors,
    sourceUrls,
  });
}
