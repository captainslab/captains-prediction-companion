// Compact, pure Savant distribution layer. It accepts the same row field names
// as baseball-savant-readonly.mjs, defaults to fixtures, and never writes state.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';

const WINDOWS = Object.freeze(['7d', '30d', 'season']);
const DAY = 86400000;
export const NON_BIP_TERMINAL_EVENTS = Object.freeze(new Set([
  'strikeout', 'strikeout_double_play', 'walk', 'intent_walk', 'hit_by_pitch', 'catcher_interf',
]));

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  if (typeof value !== 'string' || !value.includes(',')) return null;
  const stripped = Number(value.replace(/,/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

function date(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function dateMs(value) {
  const normalized = date(value);
  return normalized ? new Date(`${normalized}T00:00:00.000Z`).getTime() : null;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function classifyWindow(rowDate, runDate, seasonStart) {
  const rowMs = dateMs(rowDate);
  const runMs = dateMs(runDate);
  const seasonStartMs = dateMs(seasonStart);
  if (rowMs == null || runMs == null || seasonStartMs == null || rowMs < seasonStartMs || rowMs > runMs) return [];
  const age = Math.floor((runMs - rowMs) / DAY);
  return [age < 7 ? '7d' : null, age < 30 ? '30d' : null, 'season'].filter(Boolean);
}

function eventName(row) {
  return String(row.events ?? row.event ?? '').trim().toLowerCase();
}

export function isTerminalPa(row) {
  return Boolean(eventName(row));
}

function isHr(row) {
  return eventName(row) === 'home_run';
}

function isBip(row) {
  const event = eventName(row);
  return Boolean(event) && !NON_BIP_TERMINAL_EVENTS.has(event);
}

function isBarrel(row) {
  const explicit = String(row.barrel ?? row.is_barrel ?? row.isBarrel ?? '').trim().toLowerCase();
  if (/^(1|true|t|yes|barrel)$/.test(explicit)) return true;
  // Savant documents launch_speed_angle zone 6 as Barrel.
  return number(row.launch_speed_angle ?? row.launchSpeedAngle) === 6;
}

function spray(row, stand) {
  const explicit = String(row.spray ?? row.hit_location ?? '').trim().toLowerCase();
  if (['pull', 'center', 'oppo'].includes(explicit)) return explicit;
  const x = number(row.hc_x ?? row.hit_location_x);
  if (x == null) return null;
  const normalizedStand = String(stand ?? '').toUpperCase();
  if (x >= 110 && x <= 140) return 'center';
  const towardPull = normalizedStand === 'L' ? x > 125 : x < 125;
  return towardPull ? 'pull' : 'oppo';
}

function pitchFamily(row) {
  const text = String(row.pitch_family ?? row.pitch_type ?? row.pitch_name ?? '').toLowerCase();
  if (!text) return null;
  if (/(^|[\s_-])(?:four|sinker|fastball|cutter|ff|si|fc|fa)(?=$|[\s_-])/.test(text)) return 'fastball';
  if (/(^|[\s_-])(?:slider|sweeper|curve(?:ball)?|knuckle[ _-]?curve|sl|sv|cu|kc)(?=$|[\s_-])/.test(text)) return 'breaking';
  if (/(^|[\s_-])(?:changeup|change|splitter|split|ch|fo)(?=$|[\s_-])/.test(text)) return 'offspeed';
  return 'other';
}

function emptyBucket() {
  return {
    pa: 0, bip: 0, hr: 0, ev: [], launch_angles: [], distances: [],
    barrels: 0, hard_hit: 0, sweet_spot: 0, fly_ball: 0, pull_air: 0,
    spray: { pull: 0, center: 0, oppo: 0 }, hands: {}, pitches: {},
  };
}

function addToBucket(bucket, row, stand) {
  const terminal = isTerminalPa(row);
  if (terminal) bucket.pa += 1;
  const hr = isHr(row);
  const bip = isBip(row);
  if (bip) bucket.bip += 1;
  if (hr) bucket.hr += 1;
  if (terminal) {
    const hand = String(row.stand ?? row.batter_hand ?? stand ?? '').toUpperCase();
    if (hand) addSplit(bucket.hands, hand, row);
    const family = pitchFamily(row);
    if (family) addSplit(bucket.pitches, family, row);
  }
  // Pitch-level Savant rows can carry contact metrics on fouls. Statcast BBE
  // distributions include only batted balls that produce a terminal result.
  if (!bip) return;
  const ev = number(row.launch_speed ?? row.launchSpeed);
  const la = number(row.launch_angle ?? row.launchAngle);
  const distance = number(row.hit_distance_sc ?? row.hitDistanceSc);
  if (ev != null) { bucket.ev.push(ev); if (ev >= 95) bucket.hard_hit += 1; }
  if (la != null) { bucket.launch_angles.push(la); if (la >= 8 && la <= 32) bucket.sweet_spot += 1; }
  if (distance != null) bucket.distances.push(distance);
  if (['fly_ball', 'flyball'].includes(String(row.bb_type ?? '').toLowerCase()) || (la != null && la >= 25)) bucket.fly_ball += 1;
  if (isBarrel(row)) bucket.barrels += 1;
  const sprayType = spray(row, stand);
  if (sprayType) { bucket.spray[sprayType] += 1; if (sprayType === 'pull' && la != null && la >= 25) bucket.pull_air += 1; }
}

function addSplit(collection, key, row) {
  if (!isTerminalPa(row)) return;
  if (!collection[key]) collection[key] = { pa: 0, bip: 0, hr: 0, ev: [], hard_hit: 0 };
  const split = collection[key];
  split.pa += 1;
  const bip = isBip(row);
  if (bip) split.bip += 1;
  if (isHr(row)) split.hr += 1;
  if (!bip) return;
  const ev = number(row.launch_speed ?? row.launchSpeed);
  if (ev != null) { split.ev.push(ev); if (ev >= 95) split.hard_hit += 1; }
}

function summarizeSplit(split) {
  return {
    pa: split.pa, bip: split.bip, hr: split.hr,
    hr_per_pa: ratio(split.hr, split.pa), hr_per_bip: ratio(split.hr, split.bip),
    ev_mean: split.ev.length ? split.ev.reduce((sum, value) => sum + value, 0) / split.ev.length : null,
    hard_hit_rate: ratio(split.hard_hit, split.ev.length),
  };
}

function summarizeWindow(bucket) {
  const evMean = bucket.ev.length ? bucket.ev.reduce((sum, value) => sum + value, 0) / bucket.ev.length : null;
  const laBuckets = { below_0: 0, '0_9': 0, '10_19': 0, '20_29': 0, '30_plus': 0 };
  for (const la of bucket.launch_angles) {
    if (la < 0) laBuckets.below_0 += 1;
    else if (la < 10) laBuckets['0_9'] += 1;
    else if (la < 20) laBuckets['10_19'] += 1;
    else if (la < 30) laBuckets['20_29'] += 1;
    else laBuckets['30_plus'] += 1;
  }
  const sprayTotal = Object.values(bucket.spray).reduce((sum, value) => sum + value, 0);
  const launchTotal = bucket.launch_angles.length;
  return {
    pa: bucket.pa, bip: bucket.bip, hr: bucket.hr,
    hr_per_pa: ratio(bucket.hr, bucket.pa), hr_per_bip: ratio(bucket.hr, bucket.bip),
    ev_mean: evMean, ev_distribution: {
      mean: evMean, p50: quantile(bucket.ev, 0.5), p90: quantile(bucket.ev, 0.9), max: bucket.ev.length ? Math.max(...bucket.ev) : null,
    },
    launch_angle_histogram: Object.fromEntries(Object.entries(laBuckets).map(([key, value]) => [key, ratio(value, launchTotal)])),
    spray_distribution: {
      pull: ratio(bucket.spray.pull, sprayTotal), center: ratio(bucket.spray.center, sprayTotal), oppo: ratio(bucket.spray.oppo, sprayTotal),
    },
    barrel_rate: ratio(bucket.barrels, bucket.ev.length), hard_hit_rate: ratio(bucket.hard_hit, bucket.ev.length),
    sweet_spot_rate: ratio(bucket.sweet_spot, bucket.launch_angles.length), fly_ball_rate: ratio(bucket.fly_ball, bucket.bip), pull_air_rate: ratio(bucket.pull_air, bucket.bip),
  };
}

function buildRecord(rows, runDate, seasonStart, identity) {
  const buckets = Object.fromEntries(WINDOWS.map((window) => [window, emptyBucket()]));
  const allRows = [];
  let excludedRows = 0;
  for (const row of rows) {
    const rowDate = row.game_date ?? row.gameDate ?? row.date;
    const stand = row.stand ?? row.batter_hand ?? null;
    const normalizedRowDate = date(rowDate);
    if (normalizedRowDate && dateMs(normalizedRowDate) < dateMs(seasonStart)) excludedRows += 1;
    for (const window of classifyWindow(rowDate, runDate, seasonStart)) addToBucket(buckets[window], row, stand);
    if (normalizedRowDate && dateMs(normalizedRowDate) >= dateMs(seasonStart) && dateMs(normalizedRowDate) <= dateMs(runDate)) allRows.push(normalizedRowDate);
  }
  const season = buckets.season;
  const missing = [];
  if (!season.ev.length) missing.push('launch_speed');
  if (!season.launch_angles.length) missing.push('launch_angle');
  if (!Object.values(season.spray).some((value) => value > 0)) missing.push('spray');
  if (!Object.keys(season.hands).length) missing.push('handedness');
  if (!Object.keys(season.pitches).length) missing.push('pitch_family');
  const windows = Object.fromEntries(WINDOWS.map((window) => [window, summarizeWindow(buckets[window])]));
  const latest = allRows.length ? allRows.sort().at(-1) : null;
  return {
    batter_id: identity.batter_id ?? identity.batter ?? null,
    player_name: identity.player_name ?? identity.playerName ?? null,
    team_name: identity.team_name ?? identity.team ?? null,
    stand: identity.stand ?? identity.hand ?? null,
    latest_event_date: latest,
    windows,
    ev_distribution: windows.season.ev_distribution,
    launch_angle_distribution: windows.season.launch_angle_histogram,
    spray_distribution: windows.season.spray_distribution,
    distance_tail: { max: season.distances.length ? Math.max(...season.distances) : null, count_ge_400ft: season.distances.filter((value) => value >= 400).length },
    rates: {
      barrel_rate: windows.season.barrel_rate, hard_hit_rate: windows.season.hard_hit_rate,
      sweet_spot_rate: windows.season.sweet_spot_rate, fly_ball_rate: windows.season.fly_ball_rate, pull_air_rate: windows.season.pull_air_rate,
    },
    handedness_splits: Object.fromEntries(Object.entries(season.hands).map(([key, split]) => [key, summarizeSplit(split)])),
    pitch_family_splits: Object.fromEntries(Object.entries(season.pitches).map(([key, split]) => [key, summarizeSplit(split)])),
    coverage: { latest_event_date: latest, missing_fields: [...missing], excluded_rows: excludedRows },
    optional_bat_tracking: null,
  };
}

export function buildBaseballSavantDistributions(input = {}) {
  assertNoPriceFields(input, 'Savant distribution input');
  const { rows = [], runDate, season_start = null, maxBatters = 25 } = input;
  const normalizedRunDate = date(runDate);
  const seasonStart = season_start == null ? `${normalizedRunDate?.slice(0, 4)}-01-01` : date(season_start);
  if (!Array.isArray(rows) || !normalizedRunDate || !seasonStart || dateMs(seasonStart) > dateMs(normalizedRunDate)) return { status: 'blocked', records: [], warnings: ['runDate, rows, and a valid season_start are required'], errors: ['DISTRIBUTION_INPUT_MISSING'] };
  const groups = new Map();
  for (const row of rows) {
    const id = String(row.batter ?? row.batter_id ?? row.player_id ?? row.player_name ?? row.playerName ?? 'unknown');
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const records = [...groups.entries()].map(([id, group]) => buildRecord(group, normalizedRunDate, seasonStart, { ...group[0], batter_id: group[0].batter ?? group[0].batter_id ?? id }));
  records.sort((a, b) => {
    const byPa = b.windows.season.pa - a.windows.season.pa;
    if (byPa) return byPa;
    const left = String(a.player_name ?? '');
    const right = String(b.player_name ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { status: records.length ? 'ok' : 'blocked', records: records.slice(0, maxBatters), warnings: [], errors: records.length ? [] : ['NO_SAVANT_ROWS'] };
}

function fixtureRows() {
  const rows = [];
  const values = [101, 102, 97, 104, 99, 108, 96, 101, 93, 106, 98, 103];
  values.forEach((ev, index) => rows.push({
    batter: 101, player_name: 'Fixture Hitter A', team_name: 'Alpha City Aces', stand: index % 3 === 0 ? 'L' : 'R',
    game_date: `2026-05-${String(3 + index).padStart(2, '0')}`, launch_speed: ev, launch_angle: [12, 19, 27, 31, 7, 23][index % 6],
    hit_distance_sc: index === 2 ? 425 : 350 + ev - 90, hc_x: index % 4 === 0 ? 95 : 155, bb_type: 'fly_ball', barrel: ev >= 98 ? '1' : '0',
    events: index === 2 || index === 7 ? 'home_run' : 'field_out', pitch_type: index % 2 ? 'FF' : 'SL',
  }));
  return rows;
}

export function fixtureBaseballSavantDistributionEnvelope({ runDate = '2026-05-15', checkedAtUtc = '2026-05-15T14:00:00.000Z' } = {}) {
  const built = buildBaseballSavantDistributions({ rows: fixtureRows(), runDate });
  return { source_id: 'baseball_savant_distributions', status: built.status, checked_at_utc: checkedAtUtc, optional_source: true, fixture_mode: true, records: built.records, warnings: ['Fixture mode: no network and no state writes.'], errors: built.errors, source_urls: [] };
}

export async function fetchBaseballSavantDistributions({ runDate, fixturesOnly = true, rows = [] } = {}) {
  if (fixturesOnly) return fixtureBaseballSavantDistributionEnvelope({ runDate });
  // The phase-one adapter is deliberately input-driven. Network acquisition
  // remains owned by the existing readonly adapter; no hidden fetch is allowed.
  const built = buildBaseballSavantDistributions({ rows, runDate });
  return { source_id: 'baseball_savant_distributions', status: built.status === 'ok' ? 'ok' : 'blocked', optional_source: true, fixture_mode: false, records: built.records, warnings: built.warnings, errors: built.errors, source_urls: [] };
}
