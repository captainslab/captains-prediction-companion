// NASCAR official live-data adapter.
//
// This adapter is event-generic and read-only. It selects the Cup race from
// the official race list using the requested America/Chicago calendar window,
// then verifies the weekend feed by numeric race_id and track_id. It never
// turns a missing or malformed feed into fixture rows.

import { writeJsonAtomic, isoNow, makeEnvelope } from '../cache.mjs';
import { normalizeNascarDriverName } from '../driver-name.mjs';

export const SOURCE_ID = 'nascar_official';
export const CUP_SERIES_ID = 1;
export const NASCAR_FEED_BASE = 'https://cf.nascar.com/cacher';
export const NASCAR_TIME_ZONE = 'America/Chicago';
export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_ATTEMPTS = 2; // initial request plus at most one retry

function checkedAt(now) {
  return isoNow(now ?? new Date());
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (headers?.get) return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
  if (headers && typeof headers === 'object') {
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  }
  return null;
}

function normalizeHeaderDate(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

function chicagoDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  // A date-only value from the official schedule is already a calendar date;
  // parsing it as UTC would incorrectly move it to the prior Chicago day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NASCAR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integerOrNull(value) {
  const n = numberOrNull(value);
  return Number.isInteger(n) ? n : null;
}

function utcTimestamp(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function responseOk(response) {
  if (!response) return false;
  if (response.ok === false) return false;
  return response.status === undefined || (response.status >= 200 && response.status < 300);
}

async function fetchJson(url, { fetchImpl, timeoutMs, now }) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!responseOk(response)) {
        throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
      }
      const payload = await response.json();
      return {
        payload,
        url,
        fetched_at_utc: checkedAt(now),
        last_modified_utc: normalizeHeaderDate(headerValue(response, 'Last-Modified')),
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url}: ${lastError?.message ?? 'fetch failed'}`);
}

function baseEnvelope({ source_id, status, checked_at_utc, outputDir, records = [], source_urls = [], notes = [], errors = [] }) {
  return {
    ...makeEnvelope({
      source_id,
      status,
      checked_at_utc,
      cache_path: `${outputDir}/${source_id === SOURCE_ID ? 'nascar_official' : source_id}_adapter.json`,
      required: true,
      records,
      warnings: [],
      errors,
      source_urls,
    }),
    notes,
  };
}

function unavailableArtifacts({ checked_at_utc, outputDir, sourceUrls, reason }) {
  const notes = [reason];
  return {
    official: baseEnvelope({
      source_id: SOURCE_ID,
      status: 'unavailable',
      checked_at_utc,
      outputDir,
      source_urls: sourceUrls,
      notes,
      errors: [reason],
    }),
    activeField: baseEnvelope({
      source_id: 'active_field_pool',
      status: 'unavailable',
      checked_at_utc,
      outputDir,
      source_urls: sourceUrls,
      notes,
      errors: [reason],
    }),
    practiceQualifying: baseEnvelope({
      source_id: 'practice_qualifying',
      status: 'unavailable',
      checked_at_utc,
      outputDir,
      source_urls: sourceUrls,
      notes,
      errors: [reason],
    }),
  };
}

function raceStartUtc(race) {
  const scheduled = Array.isArray(race?.schedule)
    ? race.schedule.find((item) => Number(item?.run_type) === 3)
    : null;
  return utcTimestamp(scheduled?.start_time_utc ?? race?.date_scheduled ?? race?.race_date);
}

function selectRace(raceList, date) {
  const races = raceList?.series_1;
  if (!Array.isArray(races)) throw new Error('race list missing series_1');
  const matches = races.filter((race) => chicagoDate(race?.race_date) === date);
  if (matches.length !== 1) {
    throw new Error(matches.length ? `expected one Cup race for ${date}, found ${matches.length}` : `no Cup race for ${date}`);
  }
  return matches[0];
}

function validateGrid(results) {
  if (!Array.isArray(results) || !results.length) throw new Error('weekend_race.results missing or empty');
  const positions = results.map((row) => integerOrNull(row?.starting_position));
  if (positions.some((position) => position === null || position < 1)) {
    throw new Error('final starting order contains a missing or zero starting_position');
  }
  const unique = new Set(positions);
  const expected = Array.from({ length: positions.length }, (_, index) => index + 1);
  if (unique.size !== positions.length || !expected.every((position) => unique.has(position))) {
    throw new Error('final starting order is not unique and contiguous from 1 through N');
  }
  const names = results.map((row) => row?.driver_fullname ?? row?.driver_name).map(normalizeNascarDriverName);
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error('entry list contains a missing or duplicate driver_name');
  }
}

function qualifyingRun(feed, race) {
  const runs = Array.isArray(feed?.weekend_runs)
    ? feed.weekend_runs.filter((run) => Number(run?.run_type) === 2 && Number(run?.race_id) === Number(race.race_id))
    : [];
  if (!runs.length) throw new Error('weekend_runs has no matching run_type 2 qualifying detail');
  return runs.slice().sort((a, b) => String(b.run_date_utc ?? '').localeCompare(String(a.run_date_utc ?? '')))[0];
}

function driverName(row) {
  return String(row?.driver_fullname ?? row?.driver_name ?? '').trim();
}

function normalizeRows({ results, qualifying }) {
  const qualifyingByDriver = new Map(
    (qualifying.results ?? []).map((row) => [
      row?.driver_id != null ? `id:${row.driver_id}` : `name:${normalizeNascarDriverName(row?.driver_name)}`,
      row,
    ]),
  );
  const activeRecords = results.map((row) => ({
    query_type: 'active_field_pool_entry',
    driver_name: driverName(row),
    driver_id: integerOrNull(row.driver_id),
    car_number: row.car_number ?? row.official_car_number ?? null,
    team: row.team_name ?? null,
    manufacturer: row.car_make ?? null,
    starting_grid_position: integerOrNull(row.starting_position),
    race_id: integerOrNull(row.race_id),
    track_id: integerOrNull(row.track_id),
    finishing_position: integerOrNull(row.finishing_position),
    source_record_id: row.result_id ?? null,
  }));
  const practiceRecords = results.map((row) => {
    const key = row?.driver_id != null
      ? `id:${row.driver_id}`
      : `name:${normalizeNascarDriverName(driverName(row))}`;
    const detail = qualifyingByDriver.get(key);
    if (!detail) throw new Error(`qualifying detail missing for ${driverName(row)}`);
    return {
      query_type: 'practice_qualifying_entry',
      driver_name: driverName(row),
      driver_id: integerOrNull(row.driver_id),
      car_number: row.car_number ?? row.official_car_number ?? detail.car_number ?? null,
      qualifying_position: integerOrNull(detail.finishing_position),
      qualifying_speed: numberOrNull(detail.best_lap_speed),
      qualifying_lap_time: numberOrNull(detail.best_lap_time),
      starting_position: integerOrNull(row.starting_position),
      effective_race_start: integerOrNull(row.starting_position),
      race_id: integerOrNull(row.race_id),
      source_run_id: detail.run_id ?? null,
    };
  });
  return { activeRecords, practiceRecords };
}

function writeArtifacts({ outputDir, artifacts }) {
  const paths = {
    official: writeJsonAtomic(`${outputDir}/nascar_official_adapter.json`, artifacts.official),
    activeField: writeJsonAtomic(`${outputDir}/active_field_pool_adapter.json`, artifacts.activeField),
    practiceQualifying: writeJsonAtomic(`${outputDir}/practice_qualifying_adapter.json`, artifacts.practiceQualifying),
  };
  return paths;
}

export async function fetchNascarOfficialLive({
  date,
  season = String(date ?? '').slice(0, 4),
  outputDir = `state/nascar/${date}/discovery`,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date(),
} = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error('date must be YYYY-MM-DD');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is unavailable');

  const checked_at_utc = checkedAt(now);
  const listUrl = `${NASCAR_FEED_BASE}/${season}/race_list_basic.json`;
  let listResponse = null;
  let feedResponse = null;
  let sourceUrls = [listUrl];
  let race = null;
  try {
    listResponse = await fetchJson(listUrl, { fetchImpl, timeoutMs, now });
    race = selectRace(listResponse.payload, date);
    const feedUrl = `${NASCAR_FEED_BASE}/${season}/${CUP_SERIES_ID}/${race.race_id}/weekend-feed.json`;
    sourceUrls = [listUrl, feedUrl];
    feedResponse = await fetchJson(feedUrl, { fetchImpl, timeoutMs, now });
    const weekendRaces = feedResponse.payload?.weekend_race;
    if (!Array.isArray(weekendRaces)) throw new Error('weekend_feed missing weekend_race');
    const weekendRace = weekendRaces.find((item) =>
      Number(item?.race_id) === Number(race.race_id)
      && Number(item?.track_id) === Number(race.track_id));
    if (!weekendRace) throw new Error('weekend_feed race_id/track_id did not match selected race');
    const results = weekendRace.results;
    validateGrid(results);
    const qualifying = qualifyingRun(feedResponse.payload, race);
    const { activeRecords, practiceRecords } = normalizeRows({ results, qualifying });
    const publication_at_utc = feedResponse.last_modified_utc ?? listResponse.last_modified_utc ?? null;
    const officialRecord = {
      query_type: 'race_event_identity',
      race_id: integerOrNull(race.race_id),
      track_id: integerOrNull(race.track_id),
      series_id: integerOrNull(race.series_id ?? CUP_SERIES_ID),
      race_name: String(race.race_name ?? '').trim(),
      track: String(race.track_name ?? '').trim(),
      scheduled_start_utc: raceStartUtc(race),
      race_date: race.race_date ?? null,
      source_urls: sourceUrls,
      publication_at_utc,
      race_list_last_modified_utc: listResponse.last_modified_utc,
      weekend_feed_last_modified_utc: feedResponse.last_modified_utc,
      fetched_at_utc: feedResponse.fetched_at_utc,
    };
    if (!officialRecord.race_id || !officialRecord.track_id || !officialRecord.race_name || !officialRecord.track || !officialRecord.scheduled_start_utc) {
      throw new Error('selected official race identity is incomplete');
    }
    const artifacts = {
      official: baseEnvelope({
        source_id: SOURCE_ID,
        status: 'ok',
        checked_at_utc,
        outputDir,
        records: [officialRecord],
        source_urls: sourceUrls,
        notes: ['Official NASCAR race identity selected by America/Chicago race_date and verified by race_id/track_id.'],
      }),
      activeField: baseEnvelope({
        source_id: 'active_field_pool',
        status: 'ok',
        checked_at_utc,
        outputDir,
        records: activeRecords,
        source_urls: sourceUrls,
        notes: ['weekend_race.results is treated as the official active entry list, including pre-race finishing_position: 0 rows.'],
      }),
      practiceQualifying: baseEnvelope({
        source_id: 'practice_qualifying',
        status: 'ok',
        checked_at_utc,
        outputDir,
        records: practiceRecords,
        source_urls: sourceUrls,
        notes: ['Final effective_race_start is taken from the official starting_position; run_type 2 is retained as qualifying detail.'],
      }),
    };
    const paths = writeArtifacts({ outputDir, artifacts });
    return {
      ok: true,
      status: 'ok',
      date,
      race: officialRecord,
      envelopes: artifacts,
      paths,
    };
  } catch (error) {
    const artifacts = unavailableArtifacts({
      checked_at_utc,
      outputDir,
      sourceUrls,
      reason: error?.message ?? 'official NASCAR data unavailable',
    });
    const paths = writeArtifacts({ outputDir, artifacts });
    return {
      ok: false,
      status: 'unavailable',
      date,
      race: null,
      reason: error?.message ?? 'official NASCAR data unavailable',
      envelopes: artifacts,
      paths,
    };
  }
}

// Adapter naming aliases used by the other NASCAR source adapters and by
// callers that want to make the live/read-only intent explicit.
export const runNascarOfficialIngestion = fetchNascarOfficialLive;
export const fetchNascarOfficialReadonly = fetchNascarOfficialLive;
