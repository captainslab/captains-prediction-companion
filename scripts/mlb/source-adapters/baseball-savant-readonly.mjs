import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const BASEBALL_SAVANT_STATCAST_CSV_URL = 'https://baseballsavant.mlb.com/statcast_search/csv';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function makeEnvelope({
  status,
  checkedAtUtc,
  cachePath,
  records = [],
  warnings = [],
  errors = [],
  sourceUrls = [],
}) {
  return {
    source_id: 'baseball_savant',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `baseball_savant_statcast_${checkedAtUtc}`,
    cache_path: cachePath,
    required: true,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildStatcastCsvUrl(runDate) {
  const url = new URL(BASEBALL_SAVANT_STATCAST_CSV_URL);
  url.searchParams.set('all', 'true');
  url.searchParams.set('type', 'details');
  url.searchParams.set('player_type', 'batter');
  url.searchParams.set('game_date_gt', runDate);
  url.searchParams.set('game_date_lt', runDate);
  return url.toString();
}

function countCsvRows(csvText) {
  const lines = String(csvText ?? '')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

function readMlbGamesFromDiscovery(filePath) {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return { records: [], warning: `MLB official discovery file not found at ${filePath}.` };
  }

  try {
    const payload = JSON.parse(readFileSync(absolutePath, 'utf8'));
    return { records: safeArray(payload.records), warning: null };
  } catch (error) {
    return {
      records: [],
      warning: `Could not parse MLB official discovery file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function fixtureRecords({ checkedAtUtc, runDate }) {
  return [
    {
      query_type: 'pitcher_strikeout_profile',
      player_name: 'Placeholder Pitcher A',
      team_name: 'Alpha City Aces',
      game_pk: 100001,
      season_or_date_range: `${runDate} fixture season-to-date`,
      sample_size: 150,
      checked_at_utc: checkedAtUtc,
      k_rate: 0.28,
      whiff_or_swinging_strike_proxy: 0.31,
      pitch_mix: [
        { pitch_type: 'FF', usage_rate: 0.46 },
        { pitch_type: 'SL', usage_rate: 0.28 },
      ],
      opponent_strikeout_profile: 'Placeholder opponent K profile.',
      data_quality_note: 'Fixture mode: no live Baseball Savant source was called.',
      source_urls: [],
    },
    {
      query_type: 'home_run_hitter_profile',
      player_name: 'Placeholder Hitter B',
      team_name: 'Beta Town Bears',
      game_pk: 100001,
      season_or_date_range: `${runDate} fixture season-to-date`,
      sample_size: 120,
      checked_at_utc: checkedAtUtc,
      barrel_rate: 0.14,
      hard_hit_rate: 0.48,
      fly_ball_or_launch_profile: 'Placeholder elevated-contact profile.',
      handedness: 'R',
      pitcher_hr_pitch_profile: 'Placeholder opposing pitcher HR/pitch profile.',
      data_quality_note: 'Fixture mode: no live Baseball Savant source was called.',
      source_urls: [],
    },
    {
      query_type: 'game_run_environment_profile',
      player_name: null,
      team_name: 'Alpha City Aces / Beta Town Bears',
      game_pk: 100001,
      season_or_date_range: `${runDate} fixture season-to-date`,
      sample_size: 250,
      checked_at_utc: checkedAtUtc,
      starter_contact_profile: 'Placeholder starter contact profile.',
      top_of_order_power_contact: 'Placeholder top-of-order power/contact signal.',
      run_environment_batted_ball_indicators: 'Placeholder batted-ball run environment summary.',
      data_quality_note: 'Fixture mode: no live Baseball Savant source was called.',
      source_urls: [],
    },
  ];
}

function liveDiscoveryRecordsFromCsv({ games, checkedAtUtc, runDate, queryUrl, sampleSize }) {
  if (sampleSize <= 0) {
    return [];
  }

  return [
    {
      query_type: 'statcast_csv_discovery_summary',
      record_type: 'discovery_summary_not_model_evidence',
      player_name: null,
      team_name: null,
      game_pk: null,
      game_context_count: games.length,
      season_or_date_range: runDate,
      sample_size: sampleSize,
      checked_at_utc: checkedAtUtc,
      pitcher_strikeout_fields: {
        k_rate: null,
        whiff_or_swinging_strike_proxy: null,
        pitch_mix: [],
      },
      hitter_home_run_fields: {
        barrel_rate: null,
        hard_hit_rate: null,
        fly_ball_or_launch_profile: null,
      },
      run_environment_fields: {
        starter_contact_profile: null,
        top_of_order_power_contact: null,
        run_environment_batted_ball_indicators: null,
      },
      data_quality_note:
        'Live read-only Baseball Savant CSV returned rows. This is a discovery summary only, not final model evidence or a handicap recommendation.',
      source_urls: [queryUrl],
    },
  ];
}

export function fixtureBaseballSavantEnvelope({
  runDate,
  checkedAtUtc = '2026-05-15T14:00:00.000Z',
  outputDir,
}) {
  return makeEnvelope({
    status: 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/baseball_savant_adapter.json`,
    records: fixtureRecords({ checkedAtUtc, runDate }),
    warnings: ['Fixture mode: no live Baseball Savant/Statcast source was called.'],
    sourceUrls: [buildStatcastCsvUrl(runDate)],
  });
}

export async function fetchBaseballSavantReadonly({
  runDate,
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  mlbGames = null,
  mlbDiscoveryPath = `${outputDir}/mlb_official_adapter.json`,
} = {}) {
  const checkedAtUtc = isoNow(now);
  if (fixturesOnly) {
    return fixtureBaseballSavantEnvelope({ runDate, checkedAtUtc, outputDir });
  }

  const queryUrl = buildStatcastCsvUrl(runDate);
  const warnings = [];
  let games = safeArray(mlbGames);
  if (games.length === 0) {
    const discovery = readMlbGamesFromDiscovery(mlbDiscoveryPath);
    games = discovery.records;
    if (discovery.warning) warnings.push(discovery.warning);
  }

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/baseball_savant_adapter.json`,
      warnings,
      errors: ['No fetch implementation available for live-readonly Baseball Savant request.'],
      sourceUrls: [queryUrl],
    });
  }

  try {
    const response = await fetchImpl(queryUrl, {
      method: 'GET',
      headers: {
        accept: 'text/csv,text/plain,*/*',
        'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
      },
    });

    if (!response.ok) {
      return makeEnvelope({
        status: 'blocked',
        checkedAtUtc,
        cachePath: `${outputDir}/baseball_savant_adapter.json`,
        warnings,
        errors: [`Baseball Savant CSV endpoint returned HTTP ${response.status}.`],
        sourceUrls: [queryUrl],
      });
    }

    const csvText = await response.text();
    const sampleSize = countCsvRows(csvText);
    const records = liveDiscoveryRecordsFromCsv({ games, checkedAtUtc, runDate, queryUrl, sampleSize });
    return makeEnvelope({
      status: records.length > 0 && sampleSize > 0 ? 'degraded' : 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/baseball_savant_adapter.json`,
      records,
      warnings: [
        ...warnings,
        'Live read-only Statcast CSV checked; Stage 4 records discovery summaries only and makes no picks.',
        ...(sampleSize > 0
          ? ['Records are discovery summaries only, not final model evidence or handicap recommendations.']
          : ['No usable Statcast rows were returned; MLB schedule context was not emitted as Baseball Savant evidence.']),
      ],
      sourceUrls: [queryUrl],
    });
  } catch (error) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/baseball_savant_adapter.json`,
      warnings: [
        ...warnings,
        'No usable Statcast rows were returned or parsed; MLB schedule context was not emitted as Baseball Savant evidence.',
      ],
      errors: [error instanceof Error ? error.message : String(error)],
      sourceUrls: [queryUrl],
    });
  }
}
