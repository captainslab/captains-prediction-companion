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
  required = false,
  optionalSource = true,
}) {
  return {
    source_id: 'baseball_savant',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `baseball_savant_statcast_${checkedAtUtc}`,
    cache_path: cachePath,
    required,
    optional_source: optionalSource,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toIsoYmd(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function shiftYmd(ymd, deltaDays) {
  const base = toIsoYmd(ymd);
  if (!base) return null;
  const shifted = new Date(`${base}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

function buildStatcastCsvUrl(dayYmd) {
  const url = new URL(BASEBALL_SAVANT_STATCAST_CSV_URL);
  url.searchParams.set('all', 'true');
  url.searchParams.set('type', 'details');
  url.searchParams.set('player_type', 'batter');
  // Baseball Savant's CSV query is boundary-sensitive, so we query a centered
  // 2-day window around the requested day and then filter to the exact date.
  url.searchParams.set('game_date_gt', shiftYmd(dayYmd, -1));
  url.searchParams.set('game_date_lt', shiftYmd(dayYmd, 1));
  return url.toString();
}

function buildStatcastTrailingWindow(runDate, trailingDays = 3, mode = 'trailing_yesterday') {
  const runYmd = toIsoYmd(runDate);
  if (!runYmd) {
    return { blocked: true, blocked_reason: 'STATCAST_WINDOW_MISSING_RUN_DATE' };
  }
  if (mode === 'today_only') {
    return { blocked: true, blocked_reason: 'STATCAST_TODAY_ONLY_REJECTED' };
  }
  const endDate = shiftYmd(runYmd, -1);
  const startDate = shiftYmd(endDate, -(Math.max(1, trailingDays) - 1));
  const days = [];
  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);
    for (let cursor = new Date(start); cursor.getTime() <= end.getTime(); cursor = new Date(cursor.getTime() + DAY_MS)) {
      days.push(cursor.toISOString().slice(0, 10));
    }
  }
  return {
    blocked: false,
    mode,
    run_date: runYmd,
    start_date: startDate,
    end_date: endDate,
    days,
    trailing_days: Math.max(1, trailingDays),
  };
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

function parseCsv(text) {
  const rows = [];
  const body = String(text ?? '').trim();
  if (!body) return { headers: [], rows: [] };

  const parsedRows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      parsedRows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch !== '\r') field += ch;
  }

  row.push(field);
  parsedRows.push(row);

  const headers = (parsedRows.shift() ?? []).map((header) => String(header ?? '').trim());
  for (const values of parsedRows) {
    if (!values.some((value) => String(value ?? '').trim().length > 0)) continue;
    const record = {};
    for (let i = 0; i < headers.length; i += 1) {
      record[headers[i]] = values[i] ?? '';
    }
    rows.push(record);
  }
  return { headers, rows };
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function truthyCsvValue(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  return ['1', 't', 'true', 'y', 'yes', 'barrel'].includes(text);
}

function csvDayRows(csvText, dayYmd) {
  const { headers, rows } = parseCsv(csvText);
  const errorColumns = headers.filter((header) => /^(?:error|errors?)$/i.test(header) || /error/i.test(header));
  const rowErrors = rows
    .flatMap((row) => errorColumns.map((col) => String(row[col] ?? '').trim()))
    .filter((value) => value.length > 0 && !/^(?:none|null|n\/a|na)$/i.test(value));
  const dayRows = rows.filter((row) => toIsoYmd(row.game_date ?? row.gameDate ?? row.date) === dayYmd);
  return { dayRows, errorColumns, rowErrors, rowCount: rows.length };
}

function aggregateStatcastRows(rows, { windowStart, windowEnd, maxBatters = 25 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const batterId = row.batter ?? row.batter_id ?? row.player_id ?? row.playerId ?? row.player_name ?? row.playerName ?? null;
    const playerName = row.player_name ?? row.playerName ?? row.batter_name ?? row.name ?? null;
    const key = batterId != null ? String(batterId) : String(playerName ?? 'unknown');
    if (!groups.has(key)) {
      groups.set(key, {
        query_type: 'statcast_hr_batter_aggregate',
        source_id: 'baseball_savant',
        optional_source: true,
        batter_id: batterId != null ? Number(batterId) || batterId : null,
        player_name: playerName,
        team_name: row.team_name ?? row.team ?? row.post_team ?? null,
        hand: row.p_throws ?? row.handedness ?? null,
        window_start_utc: windowStart,
        window_end_utc: windowEnd,
        pa: 0,
        hr_events: 0,
        barrels: 0,
        hard_hit_events: 0,
        launch_speed_sum: 0,
        launch_speed_count: 0,
        launch_angle_sum: 0,
        launch_angle_count: 0,
        max_launch_speed: null,
        max_launch_angle: null,
        max_hit_distance: null,
        game_dates: new Set(),
      });
    }

    const bucket = groups.get(key);
    bucket.pa += 1;
    const gameDate = toIsoYmd(row.game_date ?? row.gameDate ?? row.date);
    if (gameDate) bucket.game_dates.add(gameDate);

    const launchSpeed = toNumber(row.launch_speed ?? row.launchSpeed);
    if (launchSpeed != null) {
      bucket.launch_speed_sum += launchSpeed;
      bucket.launch_speed_count += 1;
      bucket.max_launch_speed = bucket.max_launch_speed == null ? launchSpeed : Math.max(bucket.max_launch_speed, launchSpeed);
      if (launchSpeed >= 95) bucket.hard_hit_events += 1;
    }

    const launchAngle = toNumber(row.launch_angle ?? row.launchAngle);
    if (launchAngle != null) {
      bucket.launch_angle_sum += launchAngle;
      bucket.launch_angle_count += 1;
      bucket.max_launch_angle = bucket.max_launch_angle == null ? launchAngle : Math.max(bucket.max_launch_angle, launchAngle);
    }

    const hitDistance = toNumber(row.hit_distance_sc ?? row.hitDistanceSc);
    if (hitDistance != null) {
      bucket.max_hit_distance = bucket.max_hit_distance == null ? hitDistance : Math.max(bucket.max_hit_distance, hitDistance);
    }

    if (truthyCsvValue(row.barrel ?? row.is_barrel ?? row.isBarrel)) {
      bucket.barrels += 1;
    }
    if (String(row.events ?? row.event ?? '').trim().toLowerCase() === 'home_run') {
      bucket.hr_events += 1;
    }
  }

  const records = [...groups.values()].map((bucket) => {
    const gameDates = [...bucket.game_dates].sort();
    const hrRate = bucket.pa > 0 ? bucket.hr_events / bucket.pa : null;
    const barrelRate = bucket.pa > 0 ? bucket.barrels / bucket.pa : null;
    const hardHitRate = bucket.pa > 0 ? bucket.hard_hit_events / bucket.pa : null;
    return {
      query_type: bucket.query_type,
      source_id: bucket.source_id,
      optional_source: bucket.optional_source,
      batter_id: bucket.batter_id,
      player_name: bucket.player_name,
      team_name: bucket.team_name,
      hand: bucket.hand,
      window_start_utc: bucket.window_start_utc,
      window_end_utc: bucket.window_end_utc,
      pa: bucket.pa,
      hr_events: bucket.hr_events,
      hr_rate: hrRate == null ? null : Math.round(hrRate * 1000) / 1000,
      barrels: bucket.barrels,
      barrel_rate: barrelRate == null ? null : Math.round(barrelRate * 1000) / 1000,
      hard_hit_events: bucket.hard_hit_events,
      hard_hit_rate: hardHitRate == null ? null : Math.round(hardHitRate * 1000) / 1000,
      avg_launch_speed: bucket.launch_speed_count ? Math.round((bucket.launch_speed_sum / bucket.launch_speed_count) * 1000) / 1000 : null,
      max_launch_speed: bucket.max_launch_speed,
      avg_launch_angle: bucket.launch_angle_count ? Math.round((bucket.launch_angle_sum / bucket.launch_angle_count) * 1000) / 1000 : null,
      max_launch_angle: bucket.max_launch_angle,
      max_hit_distance: bucket.max_hit_distance,
      game_count: gameDates.length,
      first_game_date: gameDates[0] ?? null,
      last_game_date: gameDates[gameDates.length - 1] ?? null,
    };
  });

  records.sort((a, b) => {
    if ((b.pa ?? 0) !== (a.pa ?? 0)) return (b.pa ?? 0) - (a.pa ?? 0);
    if ((b.hr_events ?? 0) !== (a.hr_events ?? 0)) return (b.hr_events ?? 0) - (a.hr_events ?? 0);
    return String(a.player_name ?? '').localeCompare(String(b.player_name ?? ''));
  });

  const truncated = records.length > maxBatters;
  return {
    records: truncated ? records.slice(0, maxBatters) : records,
    truncated,
  };
}

function fixtureRecords({ checkedAtUtc, runDate, windowStart, windowEnd }) {
  return [
    {
      query_type: 'statcast_hr_batter_aggregate',
      source_id: 'baseball_savant',
      optional_source: true,
      batter_id: 101,
      player_name: 'Placeholder Hitter A',
      team_name: 'Alpha City Aces',
      hand: 'R',
      window_start_utc: windowStart,
      window_end_utc: windowEnd,
      pa: 12,
      hr_events: 2,
      hr_rate: 0.167,
      barrels: 4,
      barrel_rate: 0.333,
      hard_hit_events: 6,
      hard_hit_rate: 0.5,
      avg_launch_speed: 93.7,
      max_launch_speed: 108.4,
      avg_launch_angle: 16.2,
      max_launch_angle: 41.1,
      max_hit_distance: 428,
      game_count: 3,
      first_game_date: shiftYmd(runDate, -3),
      last_game_date: shiftYmd(runDate, -1),
      checked_at_utc: checkedAtUtc,
      data_quality_note: 'Fixture mode: bounded Statcast HR sidecar without live Baseball Savant calls.',
      source_urls: [],
    },
    {
      query_type: 'statcast_hr_batter_aggregate',
      source_id: 'baseball_savant',
      optional_source: true,
      batter_id: 202,
      player_name: 'Placeholder Hitter B',
      team_name: 'Beta Town Bears',
      hand: 'L',
      window_start_utc: windowStart,
      window_end_utc: windowEnd,
      pa: 9,
      hr_events: 1,
      hr_rate: 0.111,
      barrels: 2,
      barrel_rate: 0.222,
      hard_hit_events: 3,
      hard_hit_rate: 0.333,
      avg_launch_speed: 91.4,
      max_launch_speed: 104.2,
      avg_launch_angle: 13.5,
      max_launch_angle: 37.8,
      max_hit_distance: 402,
      game_count: 2,
      first_game_date: shiftYmd(runDate, -2),
      last_game_date: shiftYmd(runDate, -1),
      checked_at_utc: checkedAtUtc,
      data_quality_note: 'Fixture mode: bounded Statcast HR sidecar without live Baseball Savant calls.',
      source_urls: [],
    },
  ];
}

export function fixtureBaseballSavantEnvelope({
  runDate,
  checkedAtUtc = '2026-05-15T14:00:00.000Z',
  outputDir,
}) {
  const window = buildStatcastTrailingWindow(runDate, 3);
  return makeEnvelope({
    status: 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/baseball_savant_adapter.json`,
    records: fixtureRecords({
      checkedAtUtc,
      runDate,
      windowStart: window.start_date,
      windowEnd: window.end_date,
    }),
    warnings: ['Fixture mode: bounded Statcast HR sidecar without live Baseball Savant calls.'],
    sourceUrls: window.blocked ? [] : window.days.map((day) => buildStatcastCsvUrl(day)),
    optionalSource: true,
    required: false,
  });
}

export async function fetchBaseballSavantReadonly({
  runDate,
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  trailingDays = 3,
  maxBatters = 25,
  mode = 'trailing_yesterday',
} = {}) {
  const checkedAtUtc = isoNow(now);
  const window = buildStatcastTrailingWindow(runDate, trailingDays, mode);
  if (fixturesOnly) {
    return fixtureBaseballSavantEnvelope({ runDate, checkedAtUtc, outputDir });
  }

  const warnings = [];
  const errors = [];
  const sourceUrls = [];

  if (window.blocked) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/baseball_savant_adapter.json`,
      warnings: [window.blocked_reason],
      errors: [window.blocked_reason],
      sourceUrls,
      optionalSource: true,
      required: false,
    });
  }

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/baseball_savant_adapter.json`,
      warnings: [...warnings, 'OPTIONAL_SOURCE=UNAVAILABLE: no fetch implementation available for live-readonly Baseball Savant request.'],
      errors: ['OPTIONAL_SOURCE=UNAVAILABLE'],
      sourceUrls,
      optionalSource: true,
      required: false,
    });
  }

  try {
    const allRows = [];
    for (const day of window.days) {
      const queryUrl = buildStatcastCsvUrl(day);
      sourceUrls.push(queryUrl);
      const response = await fetchImpl(queryUrl, {
        method: 'GET',
        headers: {
          accept: 'text/csv,text/plain,*/*',
          'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
        },
      });

      if (!response.ok) {
        errors.push(`Baseball Savant CSV endpoint returned HTTP ${response.status} for ${day}.`);
        continue;
      }

      const csvText = await response.text();
      const parsed = csvDayRows(csvText, day);
      if (parsed.rowErrors.length > 0) {
        errors.push(`CSV_ERROR_COLUMN_FAILURE for ${day}: ${parsed.rowErrors[0]}`);
        continue;
      }
      allRows.push(...parsed.dayRows);
    }

    const aggregated = aggregateStatcastRows(allRows, {
      windowStart: window.start_date,
      windowEnd: window.end_date,
      maxBatters,
    });
    const records = aggregated.records;
    return makeEnvelope({
      status: errors.length > 0
        ? (records.length > 0 ? 'degraded' : 'blocked')
        : (records.length > 0 ? 'ok' : 'blocked'),
      checkedAtUtc,
      cachePath: `${outputDir}/baseball_savant_adapter.json`,
      records,
      warnings: [
        ...warnings,
        'Live read-only Statcast HR sidecar used a trailing yesterday-ending window and remains display-only, not model input.',
        ...(aggregated.truncated ? [`Statcast HR sidecar truncated to top ${maxBatters} batters by plate appearances.`] : []),
        ...(errors.length === 0 && records.length > 0
          ? ['Records are bounded per-batter aggregates for HR-sidecar proof only.']
          : []),
      ],
      errors,
      sourceUrls,
      optionalSource: true,
      required: false,
    });
  } catch (error) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/baseball_savant_adapter.json`,
      warnings: [
        ...warnings,
        'OPTIONAL_SOURCE=UNAVAILABLE: no usable Statcast rows were returned or parsed; MLB schedule context was not emitted as Baseball Savant evidence.',
      ],
      errors: [error instanceof Error ? error.message : String(error), 'OPTIONAL_SOURCE=UNAVAILABLE'],
      sourceUrls,
      optionalSource: true,
      required: false,
    });
  }
}
