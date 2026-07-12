import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeNascarDriverName } from './driver-name.mjs';
import { normalizeNascarWinMarkets } from './win-market-normalization.mjs';

export const NASCAR_PACKET_INCOMPLETE = 'BLOCKED_PACKET_INCOMPLETE';

const REQUIRED_SECTION_TITLES = Object.freeze([
  'FULL FIELD',
  'RANKED BOARD',
  'STRONGEST',
  'SECONDARY',
  'LONGSHOTS',
  'FADES',
  'EVIDENCE',
  'CONFIDENCE',
  'LIMITS',
]);

const REQUIRED_LIVE_RESEARCH_LAYERS = Object.freeze([
  'race_event_identity',
  'entry_list_drivers',
  'qualifying_starting_order',
  'practice_speed',
  'recent_driver_form',
  'track_history_gen7_comparables',
  'team_manufacturer_notes',
  'penalties_inspection_news',
  'weather_track_condition',
]);

const OPTIONAL_SOURCE_UNAVAILABLE_LAYERS = new Set([
  'practice_speed',
  'recent_driver_form',
  'penalties_inspection_news',
  'weather_track_condition',
]);

const MAX_SOURCE_AGE_MS = 36 * 60 * 60 * 1000;

const PLACEHOLDER_NAME_RE =
  /\b(?:placeholder|fixture-mode|driver a\b|driver b\b|driver c\b|fixture name|test driver)\b/i;
const MISSING_NAME_RE = /^(?:missing|unknown|n\/?a|null)$/i;
const RAW_PRICE_RE =
  /\b(?:yes_bid|yes_ask|last(?:[_ -]?price)?|implied|bid|ask|volume|open[_ -]?interest|oi)\s*[:=]/i;
const CACHE_DISCLOSURE_RE =
  /\b(?:cache-only|cache only|stale-source|stale source|live fetch unavailable|using cached)\b/i;

function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export { normalizeNascarDriverName } from './driver-name.mjs';

function getTimestamp(value) {
  const raw = value?.generated_utc
    ?? value?.checked_at_utc
    ?? value?.fetched_utc
    ?? value?.generated_at
    ?? value?.updated_utc
    ?? value?.timestamp
    ?? null;
  const ms = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? { raw, ms } : null;
}

function firstRecord(envelope) {
  return Array.isArray(envelope?.records) && envelope.records.length ? envelope.records[0] : null;
}

function eventDateString(value) {
  const text = compact(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(parsed));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  const match = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return match ? match[0] : null;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function loadNascarRaceQualityInputs({
  date,
  stateRoot = 'state',
  liveResearch = null,
  officialEnvelope = null,
  sourceRegistry = null,
  discovery = null,
  activeFieldEnvelope = null,
  practiceEnvelope = null,
  nowMs = Date.now(),
  maxSourceAgeMs = MAX_SOURCE_AGE_MS,
} = {}) {
  const root = resolve(stateRoot, 'nascar', date ?? '');
  const discoveryDir = join(root, 'discovery');
  return {
    liveResearch: liveResearch ?? readJsonIfExists(join(root, 'live-research.json')),
    officialEnvelope: officialEnvelope ?? readJsonIfExists(join(discoveryDir, 'nascar_official_adapter.json')),
    sourceRegistry: sourceRegistry ?? readJsonIfExists(join(root, 'source_registry.json')),
    discovery: discovery ?? readJsonIfExists(join(root, 'discovery.json')),
    activeFieldEnvelope: activeFieldEnvelope ?? readJsonIfExists(join(discoveryDir, 'active_field_pool_adapter.json')),
    practiceEnvelope: practiceEnvelope ?? readJsonIfExists(join(discoveryDir, 'practice_qualifying_adapter.json')),
  };
}

function eventIdentityFromLoaded({ date, event, loaded }) {
  const errors = [];
  const official = firstRecord(loaded.officialEnvelope);
  const officialStatus = String(loaded.officialEnvelope?.status ?? '').toLowerCase();
  if (!official || officialStatus !== 'ok') {
    errors.push({ code: 'OFFICIAL_RACE_IDENTITY_MISSING', message: 'official NASCAR race envelope is missing or not ok' });
  }
  if (loaded.officialEnvelope && loaded.officialEnvelope.source_id && loaded.officialEnvelope.source_id !== 'nascar_official') {
    errors.push({ code: 'OFFICIAL_RACE_IDENTITY_SOURCE_MISMATCH', message: 'official envelope has an unexpected source_id' });
  }

  const officialRaceName = compact(official?.race_name);
  const officialTrack = compact(official?.track);
  const officialStartUtc = compact(official?.scheduled_start_utc);
  const officialRaceId = Number(official?.race_id);
  const officialTrackId = Number(official?.track_id);
  const officialSeriesId = Number(official?.series_id);
  if (!Number.isInteger(officialRaceId) || officialRaceId <= 0) {
    errors.push({ code: 'OFFICIAL_RACE_ID_MISSING', message: 'official envelope is missing a numeric race_id' });
  }
  if (!Number.isInteger(officialTrackId) || officialTrackId <= 0) {
    errors.push({ code: 'OFFICIAL_TRACK_ID_MISSING', message: 'official envelope is missing a numeric track_id' });
  }
  if (officialSeriesId !== 1) {
    errors.push({ code: 'OFFICIAL_SERIES_ID_MISMATCH', message: 'official envelope is not the numeric NASCAR Cup Series (series_id=1)' });
  }
  if (!officialRaceName || !officialTrack || !officialStartUtc) {
    errors.push({ code: 'OFFICIAL_RACE_IDENTITY_INCOMPLETE', message: 'official envelope is missing race_name, track, or scheduled_start_utc' });
  }
  if (official?.race_started === true || Number(official?.actual_laps) > 0) {
    errors.push({ code: 'NASCAR_RACE_ALREADY_STARTED', message: 'official NASCAR feed reports that the race has started' });
  }

  const eventMetadata = event?.product_metadata ?? {};
  const eventTitle = compact(event?.title);
  const eventRaceName = compact(eventMetadata.race_name ?? event?.race_name);
  const eventTrack = compact(eventMetadata.track ?? event?.venue ?? event?.track);
  const eventStartUtc = compact(eventMetadata.scheduled_start_utc ?? event?.scheduled_start_utc);
  const eventDate = eventDateString(
    eventMetadata.date
      ?? eventMetadata.event_date
      ?? eventMetadata.scheduled_date
      ?? event?.date
      ?? event?.event_date
      ?? eventStartUtc,
  );
  const officialDate = eventDateString(officialStartUtc);
  const normalizedTitle = normalizeNascarDriverName(eventTitle.replace(/\s+winner$/i, ''));

  // Official NASCAR data is canonical for race name, track, scheduled start,
  // and date. Kalshi's optional product metadata may corroborate that identity
  // or contradict it, but an omitted optional field cannot erase a valid
  // official identity.
  if (!eventTitle) {
    errors.push({ code: 'EVENT_TITLE_IDENTITY_MISSING', message: 'Kalshi event title is missing' });
  } else if (!officialRaceName || normalizeNascarDriverName(officialRaceName) !== normalizedTitle) {
    errors.push({ code: 'EVENT_TITLE_IDENTITY_MISMATCH', message: `event title does not exactly match official race_name (${officialRaceName || 'missing'})` });
  }
  if (eventRaceName && (!officialRaceName || normalizeNascarDriverName(eventRaceName) !== normalizeNascarDriverName(officialRaceName))) {
    errors.push({ code: 'EVENT_RACE_NAME_MISMATCH', message: `event/product race_name does not match official race_name (${officialRaceName || 'missing'})` });
  }
  if (eventTrack && (!officialTrack || normalizeNascarDriverName(eventTrack) !== normalizeNascarDriverName(officialTrack))) {
    errors.push({ code: 'EVENT_TRACK_MISMATCH', message: `event/product track does not match official track (${officialTrack || 'missing'})` });
  }
  if (eventStartUtc && (!officialStartUtc || compact(eventStartUtc) !== officialStartUtc)) {
    errors.push({ code: 'EVENT_START_MISMATCH', message: `event/product scheduled_start_utc does not match official start (${officialStartUtc || 'missing'})` });
  }
  if (eventDate && (!officialDate || eventDate !== officialDate)) {
    errors.push({ code: 'EVENT_DATE_MISMATCH', message: `event/product date does not match official scheduled start date (${officialDate || 'missing'})` });
  }
  if (date && (!officialDate || date !== officialDate)) {
    errors.push({ code: 'OFFICIAL_DATE_MISMATCH', message: `packet date ${date} does not match official Chicago race date ${officialDate || 'missing'}` });
  }

  if (String(event?.product_metadata?.competition ?? '') !== 'NASCAR Cup Series') {
    errors.push({ code: 'RACE_COMPETITION_MISMATCH', message: 'packet event is not an exact NASCAR Cup Series race container' });
  }

  const eventTicker = compact(event?.event_ticker);
  if (!/^KXNASCARRACE-[A-Z0-9_-]+$/i.test(eventTicker)) {
    errors.push({ code: 'EVENT_TICKER_IDENTITY_MISSING', message: 'Kalshi NASCAR event_ticker is missing or malformed' });
  }
  const marketEventTickers = new Set(
    (Array.isArray(event?.markets) ? event.markets : [])
      .map((market) => compact(market?.event_ticker))
      .filter(Boolean),
  );
  if (marketEventTickers.size && (marketEventTickers.size !== 1 || !marketEventTickers.has(eventTicker))) {
    errors.push({ code: 'MARKET_EVENT_TICKER_MISMATCH', message: 'one or more win-market records does not belong to the selected Kalshi event_ticker' });
  }
  const liveTicker = compact(loaded.liveResearch?.event_ticker);
  if (!liveTicker) {
    errors.push({ code: 'LIVE_RESEARCH_EVENT_TICKER_MISSING', message: 'live research event_ticker is missing' });
  } else if (!eventTicker || liveTicker !== eventTicker) {
    errors.push({ code: 'LIVE_RESEARCH_EVENT_MISMATCH', message: `live research event_ticker ${liveTicker} does not match packet event ${eventTicker || 'missing'}` });
  }

  return {
    errors,
    context: {
      officialRaceName,
      officialTrack,
      officialStartUtc,
      officialDate,
      officialRaceId,
      officialTrackId,
      officialSeriesId,
      eventTicker,
      liveTicker,
      packetIdentity: {
        event_ticker: eventTicker,
        event_title: eventTitle,
        race_id: Number.isInteger(officialRaceId) ? officialRaceId : null,
        track_id: Number.isInteger(officialTrackId) ? officialTrackId : null,
        series_id: Number.isInteger(officialSeriesId) ? officialSeriesId : null,
        race_name: officialRaceName || null,
        track: officialTrack || null,
        scheduled_start_utc: officialStartUtc || null,
        race_date: officialDate || null,
      },
    },
  };
}

export function evaluateNascarEventIdentity({
  date,
  event = null,
  stateRoot = 'state',
  liveResearch = null,
  officialEnvelope = null,
  sourceRegistry = null,
  discovery = null,
  activeFieldEnvelope = null,
  practiceEnvelope = null,
} = {}) {
  const loaded = loadNascarRaceQualityInputs({
    date,
    stateRoot,
    liveResearch,
    officialEnvelope,
    sourceRegistry,
    discovery,
    activeFieldEnvelope,
    practiceEnvelope,
  });
  const identity = eventIdentityFromLoaded({ date, event, loaded });
  return {
    ok: identity.errors.length === 0,
    errors: identity.errors,
    context: { ...identity.context, loaded },
  };
}

export function evaluateNascarRaceReadiness({
  date,
  event = null,
  ceiling = null,
  winMarkets = [],
  stateRoot = 'state',
  liveResearch = null,
  officialEnvelope = null,
  sourceRegistry = null,
  discovery = null,
  activeFieldEnvelope = null,
  practiceEnvelope = null,
  nowMs = Date.now(),
  maxSourceAgeMs = MAX_SOURCE_AGE_MS,
} = {}) {
  const loaded = loadNascarRaceQualityInputs({
    date,
    stateRoot,
    liveResearch,
    officialEnvelope,
    sourceRegistry,
    discovery,
    activeFieldEnvelope,
    practiceEnvelope,
  });

  const errors = [];
  const identity = eventIdentityFromLoaded({ date, event, loaded });
  errors.push(...identity.errors);
  const { officialRaceName, officialTrack, officialStartUtc, officialDate } = identity.context;

  const liveLayers = loaded.liveResearch?.layers ?? {};
  for (const layerName of REQUIRED_LIVE_RESEARCH_LAYERS) {
    const layer = liveLayers?.[layerName] ?? null;
    const status = String(layer?.status ?? '').toLowerCase();
    if (status === 'ok') {
      const sourceUrls = (Array.isArray(layer?.sources) ? layer.sources : [])
        .map((source) => compact(typeof source === 'string' ? source : source?.url))
        .filter((url) => /^https?:\/\//i.test(url));
      const checked = getTimestamp(layer);
      if (!compact(layer?.source_id ?? layer?.source_adapter) || sourceUrls.length === 0 || !checked) {
        errors.push({
          code: 'LIVE_RESEARCH_OK_UNPROVEN',
          message: `ok layer lacks adapter/source/timestamp proof: ${layerName}`,
        });
        continue;
      }
      if (checked.ms > nowMs + 60_000) {
        errors.push({ code: 'LIVE_RESEARCH_LAYER_FROM_FUTURE', message: `${layerName} timestamp is newer than the evaluation clock` });
      } else if (nowMs - checked.ms > maxSourceAgeMs) {
        errors.push({ code: 'LIVE_RESEARCH_LAYER_STALE', message: `${layerName} is stale (${checked.raw})` });
      }
      continue;
    }
    if (OPTIONAL_SOURCE_UNAVAILABLE_LAYERS.has(layerName) && status === 'source_unavailable') {
      const source = compact(layer?.source_id ?? layer?.source_adapter);
      const checked = getTimestamp(layer);
      if (source && checked) continue;
      errors.push({
        code: 'LIVE_RESEARCH_UNAVAILABLE_UNPROVEN',
        message: `source-unavailable layer lacks adapter/timestamp proof: ${layerName}`,
      });
      continue;
    }
    errors.push({ code: 'LIVE_RESEARCH_LAYER_MISSING', message: `required current-event evidence layer missing: ${layerName}` });
  }

  const activeRecords = Array.isArray(loaded.activeFieldEnvelope?.records) ? loaded.activeFieldEnvelope.records : [];
  const practiceRecords = Array.isArray(loaded.practiceEnvelope?.records) ? loaded.practiceEnvelope.records : [];
  if (String(loaded.activeFieldEnvelope?.status ?? '').toLowerCase() !== 'ok') {
    errors.push({ code: 'ACTIVE_FIELD_UNAVAILABLE', message: 'active-field pool envelope is not ok' });
  }
  if (String(loaded.practiceEnvelope?.status ?? '').toLowerCase() !== 'ok') {
    errors.push({ code: 'PRACTICE_QUALIFYING_UNAVAILABLE', message: 'practice/qualifying envelope is not ok' });
  }
  if (!activeRecords.length) {
    errors.push({ code: 'ACTIVE_FIELD_MISSING', message: 'active-field pool envelope is missing or empty' });
  }
  if (!practiceRecords.length) {
    errors.push({ code: 'FINAL_STARTING_ORDER_MISSING', message: 'practice/qualifying envelope is missing or empty' });
  }

  const { officialRaceId, officialTrackId } = identity.context;
  const activeRecordNames = activeRecords.map((record) => normalizeNascarDriverName(record.driver_name));
  const practiceRecordNames = practiceRecords.map((record) => normalizeNascarDriverName(record.driver_name));
  if (activeRecordNames.some((name) => !name || MISSING_NAME_RE.test(name))) {
    errors.push({ code: 'ACTIVE_FIELD_DRIVER_NAME_MISSING', message: 'official active field contains a blank driver_name' });
  }
  if (new Set(activeRecordNames).size !== activeRecordNames.length) {
    errors.push({ code: 'ACTIVE_FIELD_DRIVER_NAMES_NOT_UNIQUE', message: 'official active field driver names are not unique' });
  }
  if (practiceRecordNames.some((name) => !name || MISSING_NAME_RE.test(name))) {
    errors.push({ code: 'FINAL_STARTING_ORDER_DRIVER_NAME_MISSING', message: 'final starting order contains a blank driver_name' });
  }
  if (new Set(practiceRecordNames).size !== practiceRecordNames.length) {
    errors.push({ code: 'FINAL_STARTING_ORDER_DRIVER_NAMES_NOT_UNIQUE', message: 'final starting order driver names are not unique' });
  }
  for (const [label, records] of [['active field', activeRecords], ['final starting order', practiceRecords]]) {
    for (const record of records) {
      if (Number(record.race_id) !== officialRaceId) {
        errors.push({ code: 'OFFICIAL_RECORD_RACE_ID_MISMATCH', message: `${label} record race_id does not match official race_id` });
        break;
      }
      if (label === 'active field' && Number(record.track_id) !== officialTrackId) {
        errors.push({ code: 'OFFICIAL_RECORD_TRACK_ID_MISMATCH', message: 'active field record track_id does not match official track_id' });
        break;
      }
    }
  }

  const startingOrder = practiceRecords
    .map((record) => Number(record.effective_race_start))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const expectedOrder = Array.from({ length: startingOrder.length }, (_, idx) => idx + 1);
  if (!startingOrder.length || startingOrder.length !== practiceRecords.length || startingOrder.some((v, idx) => v !== expectedOrder[idx])) {
    errors.push({ code: 'FINAL_STARTING_ORDER_INCOMPLETE', message: 'effective_race_start must be complete and contiguous across the field' });
  }

  const activeFieldByName = new Map();
  for (const record of activeRecords) {
    const norm = normalizeNascarDriverName(record.driver_name);
    if (norm) activeFieldByName.set(norm, record);
  }
  const practiceByName = new Map();
  for (const record of practiceRecords) {
    const norm = normalizeNascarDriverName(record.driver_name);
    if (norm) practiceByName.set(norm, record);
  }

  const placeholderNames = new Set();
  for (const name of [
    ...activeRecords.map((record) => record.driver_name),
    ...practiceRecords.map((record) => record.driver_name),
    ...winMarkets.map((market) => market.driver_name),
    ...(Array.isArray(ceiling?.candidates) ? ceiling.candidates.map((candidate) => candidate.driver_name) : []),
  ]) {
    if (PLACEHOLDER_NAME_RE.test(String(name ?? ''))) placeholderNames.add(compact(name));
  }
  if (placeholderNames.size) {
    errors.push({
      code: 'FIXTURE_DRIVER_NAMES_PRESENT',
      message: `fixture-style driver names present: ${[...placeholderNames].join(', ')}`,
    });
  }

  const marketDrivers = winMarkets.map((market) => normalizeNascarDriverName(market.driver_name)).filter(Boolean);
  if (marketDrivers.length !== winMarkets.length
    || winMarkets.some((market) => MISSING_NAME_RE.test(normalizeNascarDriverName(market.driver_name)))) {
    errors.push({ code: 'WIN_MARKET_DRIVER_NAME_MISSING', message: 'one or more NASCAR win markets has no driver_name' });
  }
  if (!marketDrivers.length) {
    errors.push({ code: 'WIN_MARKETS_MISSING', message: 'no NASCAR win markets discovered for packet build' });
  }
  if (new Set(marketDrivers).size !== marketDrivers.length) {
    errors.push({ code: 'DUPLICATE_DRIVER_MARKETS', message: 'duplicate driver win markets discovered' });
  }

  const activeFieldNames = new Set(activeRecords.map((record) => normalizeNascarDriverName(record.driver_name)).filter(Boolean));
  const practiceNames = new Set(practiceRecords.map((record) => normalizeNascarDriverName(record.driver_name)).filter(Boolean));
  if (activeFieldNames.size && practiceNames.size && !sameSet(activeFieldNames, practiceNames)) {
    errors.push({ code: 'ACTIVE_START_ORDER_JOIN_INCOMPLETE', message: 'official active field and final starting order driver sets do not match' });
  }
  const marketNameSet = new Set(marketDrivers);
  if (activeFieldNames.size && marketNameSet.size && !sameSet(activeFieldNames, marketNameSet)) {
    errors.push({
      code: 'WIN_MARKET_COVERAGE_INCOMPLETE',
      message: `win-market coverage ${marketNameSet.size}/${activeFieldNames.size} does not match the active field`,
    });
  }
  for (const driverName of marketNameSet) {
    if (!activeFieldByName.has(driverName) || !practiceByName.has(driverName)) {
      errors.push({
        code: 'DETERMINISTIC_JOIN_FAILED',
        message: `market driver missing from official field/start order: ${driverName}`,
      });
    }
  }

  const candidates = Array.isArray(ceiling?.candidates) ? ceiling.candidates : [];
  const candidateNames = candidates.map((candidate) => normalizeNascarDriverName(candidate.driver_name));
  if (candidateNames.some((name) => !name || MISSING_NAME_RE.test(name))) {
    errors.push({ code: 'CEILING_DRIVER_NAME_MISSING', message: 'ceiling model contains a blank driver_name' });
  }
  if (new Set(candidateNames).size !== candidateNames.length) {
    errors.push({ code: 'CEILING_DRIVER_NAMES_NOT_UNIQUE', message: 'ceiling model driver names are not unique' });
  }
  if (candidates.some((candidate) => !Number.isFinite(Number(candidate.composite_score)))) {
    errors.push({ code: 'CEILING_COMPOSITE_SCORE_MISSING', message: 'ceiling model is missing a numeric composite_score' });
  }
  if (candidates.length !== winMarkets.length) {
    errors.push({
      code: 'CEILING_COVERAGE_INCOMPLETE',
      message: `ceiling candidates ${candidates.length}/${winMarkets.length} do not cover the full win market field`,
    });
  }
  const candidateSet = new Set(candidates.map((candidate) => normalizeNascarDriverName(candidate.driver_name)).filter(Boolean));
  if (marketNameSet.size && candidateSet.size && !sameSet(candidateSet, marketNameSet)) {
    errors.push({ code: 'CEILING_MARKET_JOIN_INCOMPLETE', message: 'ceiling candidates do not deterministically match the win market field' });
  }

  const timestampEntries = [
    ['source_registry', getTimestamp(loaded.sourceRegistry)],
    ['discovery', getTimestamp(loaded.discovery)],
    ['official_race_identity', getTimestamp(loaded.officialEnvelope)],
    ['active_field_pool', getTimestamp(loaded.activeFieldEnvelope)],
    ['practice_qualifying', getTimestamp(loaded.practiceEnvelope)],
    ['live_research', getTimestamp(loaded.liveResearch)],
  ];
  const timestamps = timestampEntries.filter(([, stamp]) => Boolean(stamp));
  if (timestamps.length < timestampEntries.length) {
    errors.push({ code: 'TIMESTAMP_MISSING', message: 'race-quality inputs must carry current timestamps' });
  } else {
    const minMs = Math.min(...timestamps.map(([, item]) => item.ms));
    const maxMs = Math.max(...timestamps.map(([, item]) => item.ms));
    if (maxMs - minMs > maxSourceAgeMs) {
      errors.push({ code: 'TIMESTAMP_INCONSISTENT', message: `race-quality timestamps disagree by more than ${maxSourceAgeMs}ms` });
    }
    for (const [label, stamp] of timestamps) {
      if (stamp.ms > nowMs + 60_000) {
        errors.push({ code: 'TIMESTAMP_FROM_FUTURE', message: `${label} timestamp is newer than the evaluation clock` });
      }
      if (nowMs - stamp.ms > maxSourceAgeMs) {
        errors.push({ code: 'TIMESTAMP_STALE', message: `${label} is stale relative to the evaluation clock (${stamp.raw})` });
      }
    }
  }

  const manifestBlob = JSON.stringify({
    sourceRegistry: loaded.sourceRegistry,
    discovery: loaded.discovery,
    officialEnvelope: loaded.officialEnvelope,
  }).toLowerCase();
  const staleFixtureManifestLoaded =
    /daytona|fixture-mode|fixtures-only/.test(manifestBlob)
    && !/daytona/.test(normalizeNascarDriverName(officialRaceName))
    && !/daytona/.test(normalizeNascarDriverName(officialTrack));
  if (staleFixtureManifestLoaded) {
    errors.push({
      code: 'STALE_FIXTURE_MANIFEST_IDENTITY',
      message: 'loaded NASCAR discovery metadata still points at Daytona/fixture-mode identity instead of the current official race',
    });
  }

  for (const [label, artifact] of [['source registry', loaded.sourceRegistry], ['discovery', loaded.discovery]]) {
    if (/fixtures?-only/i.test(String(artifact?.mode ?? ''))) {
      errors.push({
        code: 'FIXTURE_ARTIFACT_LOADED_IN_PRODUCTION',
        message: `${label} is fixture-only and cannot satisfy a production NASCAR packet`,
      });
    }
  }

  const startByName = new Map();
  for (const record of practiceRecords) {
    const norm = normalizeNascarDriverName(record.driver_name);
    if (norm) startByName.set(norm, Number(record.effective_race_start) || null);
  }

  return {
    ok: errors.length === 0,
    errors,
    context: {
      officialRaceName,
      officialTrack,
      officialStartUtc,
      officialDate,
      packetIdentity: identity.context.packetIdentity,
      activeFieldCount: activeRecords.length,
      startByName,
      activeFieldByName,
      loaded,
      requiredLiveResearchLayers: [...REQUIRED_LIVE_RESEARCH_LAYERS],
    },
  };
}

function packetValue(body, field) {
  const match = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'im').exec(body);
  return match ? compact(match[1]) : null;
}

function packetSectionRows(body, title, nextTitle, rowPattern) {
  const start = body.indexOf(`=== ${title} ===`);
  const end = body.indexOf(`=== ${nextTitle} ===`, start + 1);
  if (start < 0 || end < 0) return [];
  return body.slice(start, end).split('\n').map((line) => line.trim()).filter((line) => rowPattern.test(line));
}

function correctionStateErrors(body, { date, stateRoot }) {
  const errors = [];
  const eventTicker = packetValue(body, 'event_ticker');
  const root = resolve(stateRoot, 'nascar', date ?? '');
  const discoveryDir = join(root, 'discovery');
  const artifacts = {
    manifest: readJsonIfExists(join(root, 'race_manifest.json')),
    ceiling: readJsonIfExists(join(root, 'ceiling_board.json')),
    sourceRegistry: readJsonIfExists(join(root, 'source_registry.json')),
    discovery: readJsonIfExists(join(root, 'discovery.json')),
    official: readJsonIfExists(join(discoveryDir, 'nascar_official_adapter.json')),
    active: readJsonIfExists(join(discoveryDir, 'active_field_pool_adapter.json')),
    practice: readJsonIfExists(join(discoveryDir, 'practice_qualifying_adapter.json')),
    event: eventTicker ? readJsonIfExists(join(root, 'kalshi-events', `${eventTicker}.json`)) : null,
  };
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (!artifact) errors.push({ code: 'NASCAR_CORRECTION_ARTIFACT_MISSING', message: `persisted correction artifact missing or invalid: ${name}` });
  }
  for (const [name, artifact] of Object.entries({
    manifest: artifacts.manifest,
    ceiling: artifacts.ceiling,
    sourceRegistry: artifacts.sourceRegistry,
    discovery: artifacts.discovery,
  })) {
    if (artifact && String(artifact.mode ?? '').toLowerCase() !== 'production') {
      errors.push({ code: 'NASCAR_CORRECTION_ARTIFACT_NOT_PRODUCTION', message: `persisted correction artifact is not production: ${name}` });
    }
  }

  const identity = artifacts.manifest?.event_identity ?? null;
  const official = firstRecord(artifacts.official);
  const identityFields = [
    ['event_ticker', eventTicker, identity?.event_ticker],
    ['race_id', Number(packetValue(body, 'race_id')), Number(identity?.race_id)],
    ['track_id', Number(packetValue(body, 'track_id')), Number(identity?.track_id)],
    ['series_id', Number(packetValue(body, 'series_id')), Number(identity?.series_id)],
    ['official_start_utc', packetValue(body, 'official_start_utc'), identity?.scheduled_start_utc],
  ];
  for (const [field, packetActual, expected] of identityFields) {
    if (packetActual !== expected) {
      errors.push({ code: 'NASCAR_CORRECTION_IDENTITY_MISMATCH', message: `${field} does not match the persisted production manifest` });
    }
  }
  if (official && (Number(official.race_id) !== Number(identity?.race_id)
    || Number(official.track_id) !== Number(identity?.track_id)
    || Number(official.series_id) !== Number(identity?.series_id))) {
    errors.push({ code: 'NASCAR_CORRECTION_OFFICIAL_MISMATCH', message: 'official envelope identity does not match the production manifest' });
  }

  const activeRecords = Array.isArray(artifacts.active?.records) ? artifacts.active.records : [];
  const practiceRecords = Array.isArray(artifacts.practice?.records) ? artifacts.practice.records : [];
  const candidates = Array.isArray(artifacts.ceiling?.candidates) ? artifacts.ceiling.candidates : [];
  const markets = normalizeNascarWinMarkets(artifacts.event ?? {});
  const expectedCounts = [
    activeRecords.length,
    practiceRecords.length,
    candidates.length,
    markets.length,
    Number(artifacts.manifest?.active_field_count),
    Number(artifacts.manifest?.model_candidate_count),
  ];
  const expectedCount = expectedCounts[0];
  if (!Number.isInteger(expectedCount) || expectedCount <= 0 || expectedCounts.some((value) => value !== expectedCount)) {
    errors.push({ code: 'NASCAR_CORRECTION_STATE_COUNT_MISMATCH', message: `persisted official/market/model counts disagree: ${expectedCounts.join('/')}` });
  }
  for (const field of ['field_size', 'grid_count', 'market_count', 'candidate_count', 'ranked_count']) {
    if (Number(packetValue(body, field)) !== expectedCount) {
      errors.push({ code: 'NASCAR_CORRECTION_PACKET_COUNT_MISMATCH', message: `${field} does not equal persisted production count ${expectedCount}` });
    }
  }

  const fullRows = packetSectionRows(body, 'FULL FIELD', 'RANKED BOARD', /^-\s+P\d+\s+/);
  const rankedRows = packetSectionRows(body, 'RANKED BOARD', 'STRONGEST', /^-\s+#\d+\s+/);
  if (fullRows.length !== expectedCount || rankedRows.length !== expectedCount) {
    errors.push({ code: 'NASCAR_CORRECTION_RENDERED_COUNT_MISMATCH', message: `rendered FULL FIELD/RANKED rows ${fullRows.length}/${rankedRows.length} do not equal ${expectedCount}` });
  }
  const namesFromRows = (rows, pattern) => new Set(rows.map((line) => normalizeNascarDriverName(pattern.exec(line)?.[1])).filter(Boolean));
  const fullNames = namesFromRows(fullRows, /^-\s+P\d+\s+(.+?)(?:\s+\||$)/);
  const rankedNames = namesFromRows(rankedRows, /^-\s+#\d+\s+(.+?)(?:\s+\||$)/);
  const activeNames = new Set(activeRecords.map((record) => normalizeNascarDriverName(record.driver_name)).filter(Boolean));
  const candidateNames = new Set(candidates.map((candidate) => normalizeNascarDriverName(candidate.driver_name)).filter(Boolean));
  const marketNames = new Set(markets.map((market) => normalizeNascarDriverName(market.yes_sub_title ?? market.expiration_value)).filter(Boolean));
  if (![fullNames, rankedNames, candidateNames, marketNames].every((names) => sameSet(names, activeNames))) {
    errors.push({ code: 'NASCAR_CORRECTION_DRIVER_SET_MISMATCH', message: 'rendered, official, market, and model driver sets do not match' });
  }
  return errors;
}

export function evaluateNascarPacketText(text, {
  packetType = '',
  packetPath = '',
  requirePersistedState = false,
  stateRoot = 'state',
  date = null,
} = {}) {
  if (!/nascar/i.test(packetType) && !/nascar/i.test(packetPath)) {
    return { ok: true, errors: [] };
  }
  const body = String(text ?? '');
  const errors = [];
  if (body.includes(NASCAR_PACKET_INCOMPLETE)) {
    errors.push({ code: NASCAR_PACKET_INCOMPLETE, message: 'generator marked the NASCAR packet as incomplete' });
  }
  for (const title of REQUIRED_SECTION_TITLES) {
    if (!new RegExp(`\\b${title.replace(/\s+/g, '\\s+')}\\b`, 'i').test(body)) {
      errors.push({ code: 'NASCAR_SECTION_MISSING', message: `required NASCAR section missing: ${title}` });
    }
  }
  if (RAW_PRICE_RE.test(body)) {
    errors.push({ code: 'NASCAR_MARKET_PRICE_NOT_DISPLAY_ONLY', message: 'raw market price fields leaked into the NASCAR customer packet' });
  }
  if (/(?:Live Research \(Perplexity\)|Current Event Evidence)/i.test(body) && CACHE_DISCLOSURE_RE.test(body)) {
    errors.push({ code: 'NASCAR_CONTRADICTORY_FRESHNESS_DISCLOSURE', message: 'packet mixes live-research and cache-only freshness disclosures' });
  }
  if (PLACEHOLDER_NAME_RE.test(body)) {
    errors.push({ code: 'NASCAR_FIXTURE_TEXT_PRESENT', message: 'fixture-style driver text leaked into the customer packet' });
  }
  const identityFields = [
    ['event_ticker', /^event_ticker:\s*KXNASCARRACE-[A-Z0-9_-]+\s*$/im],
    ['race_id', /^race_id:\s*[1-9]\d*\s*$/im],
    ['track_id', /^track_id:\s*[1-9]\d*\s*$/im],
    ['series_id', /^series_id:\s*1\s*$/im],
    ['race_name', /^race_name:\s*\S.+$/im],
    ['track', /^track:\s*\S.+$/im],
    ['official_start_utc', /^official_start_utc:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\s*$/im],
  ];
  for (const [field, pattern] of identityFields) {
    if (!pattern.test(body)) {
      errors.push({ code: 'NASCAR_PACKET_IDENTITY_MISSING', message: `persisted packet identity field missing: ${field}` });
    }
  }

  const countFields = ['field_size', 'grid_count', 'market_count', 'candidate_count', 'ranked_count'];
  const counts = new Map();
  for (const field of countFields) {
    const match = new RegExp(`^${field}:\\s*(\\d+)\\s*$`, 'im').exec(body);
    const value = match ? Number(match[1]) : null;
    if (!Number.isInteger(value) || value <= 0) {
      errors.push({ code: 'NASCAR_PACKET_COUNT_MISSING', message: `persisted packet count missing or invalid: ${field}` });
    } else {
      counts.set(field, value);
    }
  }
  if (counts.size === countFields.length && new Set(counts.values()).size !== 1) {
    errors.push({
      code: 'NASCAR_PACKET_COUNT_MISMATCH',
      message: `field/grid/market/candidate/ranked counts disagree: ${[...counts.entries()].map(([key, value]) => `${key}=${value}`).join(', ')}`,
    });
  }
  if (requirePersistedState) errors.push(...correctionStateErrors(body, { date, stateRoot }));
  return { ok: errors.length === 0, errors };
}

export function formatNascarIncompleteReasons(errors = []) {
  return errors.map((error) => `${error.code}: ${error.message}`);
}

export function requiredNascarSectionTitles() {
  return [...REQUIRED_SECTION_TITLES];
}
