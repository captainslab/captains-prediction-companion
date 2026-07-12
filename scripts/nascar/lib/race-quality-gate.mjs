import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeNascarDriverName } from './driver-name.mjs';

export const NASCAR_PACKET_INCOMPLETE = 'BLOCKED_PACKET_INCOMPLETE';

const REQUIRED_SECTION_TITLES = Object.freeze([
  'FULL FIELD',
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

  // The title/date/track/start comparisons are deliberately unconditional.
  // A sparse Kalshi product_metadata object is not evidence of identity.
  if (!eventTitle) {
    errors.push({ code: 'EVENT_TITLE_IDENTITY_MISSING', message: 'Kalshi event title is missing' });
  } else if (!officialRaceName || normalizeNascarDriverName(officialRaceName) !== normalizedTitle) {
    errors.push({ code: 'EVENT_TITLE_IDENTITY_MISMATCH', message: `event title does not exactly match official race_name (${officialRaceName || 'missing'})` });
  }
  if (!eventRaceName) {
    errors.push({ code: 'EVENT_RACE_NAME_IDENTITY_MISSING', message: 'Kalshi event/product race_name is missing' });
  } else if (!officialRaceName || normalizeNascarDriverName(eventRaceName) !== normalizeNascarDriverName(officialRaceName)) {
    errors.push({ code: 'EVENT_RACE_NAME_MISMATCH', message: `event/product race_name does not match official race_name (${officialRaceName || 'missing'})` });
  }
  if (!eventTrack) {
    errors.push({ code: 'EVENT_TRACK_IDENTITY_MISSING', message: 'Kalshi event/product track is missing' });
  } else if (!officialTrack || normalizeNascarDriverName(eventTrack) !== normalizeNascarDriverName(officialTrack)) {
    errors.push({ code: 'EVENT_TRACK_MISMATCH', message: `event/product track does not match official track (${officialTrack || 'missing'})` });
  }
  if (!eventStartUtc) {
    errors.push({ code: 'EVENT_START_IDENTITY_MISSING', message: 'Kalshi event/product scheduled_start_utc is missing' });
  } else if (!officialStartUtc || compact(eventStartUtc) !== officialStartUtc) {
    errors.push({ code: 'EVENT_START_MISMATCH', message: `event/product scheduled_start_utc does not match official start (${officialStartUtc || 'missing'})` });
  }
  if (!eventDate) {
    errors.push({ code: 'EVENT_DATE_IDENTITY_MISSING', message: 'Kalshi event/product date is missing' });
  } else if (!officialDate || eventDate !== officialDate) {
    errors.push({ code: 'EVENT_DATE_MISMATCH', message: `event/product date does not match official scheduled start date (${officialDate || 'missing'})` });
  }
  if (date && (!officialDate || date !== officialDate)) {
    errors.push({ code: 'OFFICIAL_DATE_MISMATCH', message: `packet date ${date} does not match official Chicago race date ${officialDate || 'missing'}` });
  }

  if (String(event?.product_metadata?.competition ?? '') !== 'NASCAR Cup Series') {
    errors.push({ code: 'RACE_COMPETITION_MISMATCH', message: 'packet event is not an exact NASCAR Cup Series race container' });
  }

  const eventTicker = compact(event?.event_ticker);
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
    if (String(liveLayers?.[layerName]?.status ?? '').toLowerCase() !== 'ok') {
      errors.push({ code: 'LIVE_RESEARCH_LAYER_MISSING', message: `live research layer missing: ${layerName}` });
    }
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
      activeFieldCount: activeRecords.length,
      startByName,
      activeFieldByName,
      loaded,
      requiredLiveResearchLayers: [...REQUIRED_LIVE_RESEARCH_LAYERS],
    },
  };
}

export function evaluateNascarPacketText(text, { packetType = '', packetPath = '' } = {}) {
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
  if (/Live Research \(Perplexity\)/i.test(body) && CACHE_DISCLOSURE_RE.test(body)) {
    errors.push({ code: 'NASCAR_CONTRADICTORY_FRESHNESS_DISCLOSURE', message: 'packet mixes live-research and cache-only freshness disclosures' });
  }
  if (PLACEHOLDER_NAME_RE.test(body)) {
    errors.push({ code: 'NASCAR_FIXTURE_TEXT_PRESENT', message: 'fixture-style driver text leaked into the customer packet' });
  }
  return { ok: errors.length === 0, errors };
}

export function formatNascarIncompleteReasons(errors = []) {
  return errors.map((error) => `${error.code}: ${error.message}`);
}

export function requiredNascarSectionTitles() {
  return [...REQUIRED_SECTION_TITLES];
}
