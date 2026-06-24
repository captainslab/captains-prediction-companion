#!/usr/bin/env node
// World Cup packet schedule helper.
//
// Computes the repo-owned schedule for the morning pre-lock preview packet
// and the individual lineup-lock match packets without touching live cron
// state. The dispatcher uses this helper to decide what is due.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CPC_MATCHDAY_TIMEZONE, filterMatchesForLocalDate } from '../lib/matchday-window.mjs';

export const MORNING_PRE_LOCK_LOCAL_TIME = '09:00';
export const LINEUP_LOCK_LEAD_MINUTES = 45;
const MIN = 60 * 1000;

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatLocalDateTime(date, timeZone = CPC_MATCHDAY_TIMEZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

function zonedParts(date, timeZone = CPC_MATCHDAY_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

export function wallTimeToUtc(dateYmd, timeHm, timeZone = CPC_MATCHDAY_TIMEZONE) {
  const [year, month, day] = String(dateYmd).split('-').map((n) => Number(n));
  const [hour, minute] = String(timeHm).split(':').map((n) => Number(n));
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  for (let i = 0; i < 6; i += 1) {
    const local = zonedParts(utc, timeZone);
    const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    const observedUtcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
    const delta = desiredUtcMs - observedUtcMs;
    if (delta === 0) break;
    utc = new Date(utc.getTime() + delta);
  }

  return utc;
}

export function kickoffMinusMinutes(kickoffUtc, minutes) {
  const kickoff = new Date(kickoffUtc);
  if (Number.isNaN(kickoff.getTime())) return null;
  return new Date(kickoff.getTime() - (minutes * MIN));
}

export function loadWorldCupMatchesForDate({ date, stateRoot = 'state' } = {}) {
  const structPath = resolve(stateRoot, 'worldcup', date, 'discovery', 'static_structure.json');
  if (!existsSync(structPath)) {
    return { ok: false, error: `missing static structure for ${date}`, jobs: [], matches: [] };
  }
  const structure = readJsonIfExists(structPath);
  if (!structure) {
    return { ok: false, error: `invalid static structure for ${date}`, jobs: [], matches: [] };
  }
  const matches = filterMatchesForLocalDate(structure.matches || [], date, CPC_MATCHDAY_TIMEZONE);
  return {
    ok: true,
    structure,
    matches,
    count: matches.length,
  };
}

export function buildWorldCupPacketSchedule({ date, stateRoot = 'state' } = {}) {
  const loaded = loadWorldCupMatchesForDate({ date, stateRoot });
  if (!loaded.ok) return loaded;

  const jobs = [];
  const seen = new Set();

  const morningSendAt = wallTimeToUtc(date, MORNING_PRE_LOCK_LOCAL_TIME, CPC_MATCHDAY_TIMEZONE);
  const morningJob = {
    key: `pre_lineup_board:${date}`,
    kind: 'pre_lineup_board',
    stem: `worldcup-${date}-morning_pre_lock`,
    packet_stage: 'morning_pre_lock',
    date,
    send_at_utc: morningSendAt?.toISOString() ?? null,
    send_at_local: morningSendAt ? formatLocalDateTime(morningSendAt) : null,
  };
  jobs.push(morningJob);
  seen.add(morningJob.key);

  for (const match of loaded.matches) {
    const sendAt = kickoffMinusMinutes(match.kickoff_utc, LINEUP_LOCK_LEAD_MINUTES);
    if (!sendAt) continue;
    const home = slugify(match.home_team);
    const away = slugify(match.away_team);
    const stem = `worldcup-${date}-lineup_lock-${home}-${away}`;
    const key = `lineup_lock:${match.match_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({
      key,
      kind: 'lineup_lock',
      stem,
      packet_stage: 'lineup_lock',
      date,
      match_id: String(match.match_id),
      home_team: match.home_team,
      away_team: match.away_team,
      kickoff_utc: match.kickoff_utc,
      send_at_utc: sendAt.toISOString(),
      send_at_local: formatLocalDateTime(sendAt),
    });
  }

  jobs.sort((a, b) => String(a.send_at_utc).localeCompare(String(b.send_at_utc)) || String(a.key).localeCompare(String(b.key)));

  return {
    ok: true,
    date,
    time_zone: CPC_MATCHDAY_TIMEZONE,
    morning_pre_lock_local_time: MORNING_PRE_LOCK_LOCAL_TIME,
    lineup_lock_lead_minutes: LINEUP_LOCK_LEAD_MINUTES,
    jobs,
    matches: loaded.matches,
    structure: loaded.structure,
    match_count: loaded.count,
  };
}

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const schedule = buildWorldCupPacketSchedule({ date: opts.date, stateRoot: opts.stateRoot });
  if (!schedule.ok) {
    console.error(`[worldcup-schedule] ${schedule.error}`);
    process.exit(1);
  }

  console.log(`[worldcup-schedule] date=${schedule.date} matches=${schedule.match_count} tz=${schedule.time_zone}`);
  for (const job of schedule.jobs) {
    console.log(`[worldcup-schedule] ${job.kind} send_at=${job.send_at_local} (${job.send_at_utc}) stem=${job.stem}`);
  }
  if (opts.dryRun) {
    console.log('[worldcup-schedule] DRY RUN — schedule emitted only, no packets written');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`[worldcup-schedule] FATAL: ${e.message}`);
    process.exit(1);
  });
}
