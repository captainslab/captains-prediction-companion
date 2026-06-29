#!/usr/bin/env node
// World Cup schedule-aware cron dispatcher.
//
// Usage:
//   node scripts/worldcup/cron/cron-dispatch.mjs [--date YYYY-MM-DD] [--now ISO]
//                                                [--state-root state] [--dry-run]
//
// Designed to run every 15 minutes from crontab. Reads the cached fixture
// structure for the date and decides — from real kickoff times — which packet
// jobs are due, including the 9:00 AM Central pre-lock preview and the
// kickoff-minus-45-minute lineup-lock match packets.
// Idempotent: marker files under state/worldcup/<date>/cron/ prevent repeats.
//
// Phases (relative to kickoff K):
//   pre_lineup_board     K-6h  .. K-90m   morning board packet (once per date)
//   lineup_window        K-90m .. K-40m   refresh packet each run (lineups land ~K-75m)
//   post_lineup_final    K-40m .. K       final packet (once per match window)
//   post_match_grade     K+150m ..        grade model vs result (once per match)
//   knockout_switch      automatic — derived from match.stage in the fixture
//                        data; logged here so the switch is auditable.
//
// Script-owned scheduler + delivery glue only. No LLM. No trades.
// Packet delivery is delegated to scripts/packets/send-packets-telegram.mjs.
// Exit codes: 0 = ok (including nothing due), 1 = hard error.

import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CPC_MATCHDAY_TIMEZONE } from '../lib/matchday-window.mjs';
import {
  buildWorldCupPacketSchedule,
  LINEUP_LOCK_LEAD_MINUTES,
  MORNING_PRE_LOCK_LOCAL_TIME,
  wallTimeToUtc,
} from './worldcup-schedule.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATOR = join(__dirname, '..', 'generate-matchday-packet.mjs');
const SENDER = join(__dirname, '..', '..', 'packets', 'send-packets-telegram.mjs');
// Phases where official starting XIs may be published — request a fresh lineup
// cache before generating so the packet can be locked from current official XI
// data rather than an older pre-lock snapshot.
const LINEUP_FETCH_PHASES = new Set(['lineup_lock']);

export const PHASE_WINDOWS = Object.freeze({
  pre_lineup_board: { local_time: MORNING_PRE_LOCK_LOCAL_TIME, time_zone: CPC_MATCHDAY_TIMEZONE },
  lineup_lock: { lead_minutes: LINEUP_LOCK_LEAD_MINUTES },
  post_match_grade: { from: 150, to: Infinity },
});

function parseArgs(argv) {
  const opts = { date: null, now: null, stateRoot: 'state', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--now') opts.now = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid --now: ${opts.now}`);
  opts.nowDate = now;
  if (!opts.date) opts.date = now.toISOString().slice(0, 10);
  return opts;
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function buildAdHocSchedule({ matches = [], date }) {
  const jobs = [];
  const morningSendAt = wallTimeToUtc(date, MORNING_PRE_LOCK_LOCAL_TIME, CPC_MATCHDAY_TIMEZONE);
  jobs.push({
    key: `pre_lineup_board:${date}`,
    kind: 'pre_lineup_board',
    stem: `worldcup-${date}-morning_pre_lock`,
    packet_stage: 'morning_pre_lock',
    date,
    send_at_utc: morningSendAt?.toISOString() ?? null,
    send_at_local: morningSendAt ? new Intl.DateTimeFormat('en-US', {
      timeZone: CPC_MATCHDAY_TIMEZONE,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(morningSendAt) : null,
  });
  for (const m of matches || []) {
    if (!m?.kickoff_utc) continue;
    const sendAt = new Date(new Date(m.kickoff_utc).getTime() - (LINEUP_LOCK_LEAD_MINUTES * 60 * 1000));
    if (Number.isNaN(sendAt.getTime())) continue;
    jobs.push({
      key: `lineup_lock:${m.match_id}`,
      kind: 'lineup_lock',
      stem: `worldcup-${date}-lineup_lock-${String(m.home_team || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(m.away_team || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      packet_stage: 'lineup_lock',
      date,
      match_id: String(m.match_id),
      home_team: m.home_team,
      away_team: m.away_team,
      kickoff_utc: m.kickoff_utc,
      send_at_utc: sendAt.toISOString(),
      send_at_local: new Intl.DateTimeFormat('en-US', {
        timeZone: CPC_MATCHDAY_TIMEZONE,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(sendAt),
    });
  }
  return { ok: true, date, matches, jobs };
}

function markerPath(stateRoot, date, name) {
  return resolve(stateRoot, 'worldcup', date, 'cron', `${name}.done`);
}

function markerExists(stateRoot, date, name) {
  return existsSync(markerPath(stateRoot, date, name));
}

function writeMarker(stateRoot, date, name, payload) {
  const p = markerPath(stateRoot, date, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2), 'utf8');
}

/**
 * Pure decision function — given matches and a clock, return what is due.
 * Exported for cron dry-run proof tests.
 */
export function computeDueActions({ matches, now, stateRoot, date, hasMarker }) {
  const built = stateRoot ? buildWorldCupPacketSchedule({ date, stateRoot }) : null;
  const schedule = built && built.ok ? built : buildAdHocSchedule({ matches, date });
  const scheduledMatches = schedule.ok ? schedule.matches : (matches || []);
  const upcoming = scheduledMatches.filter((m) => m?.kickoff_utc);
  const actions = [];
  const marked = hasMarker ?? ((name) => markerExists(stateRoot, date, name));
  const nowMs = now.getTime();

  if (!upcoming.length) {
    return { actions, note: 'no fixtures with kickoff times for this date' };
  }

  // Knockout switch is data-driven; surface it for the audit trail.
  const knockout = upcoming.some((m) => m.stage && m.stage !== 'group');
  if (knockout) {
    actions.push({ kind: 'knockout_switch', note: 'knockout-stage fixture present; ET/penalty layer + advance lane active' });
  }

  for (const job of schedule.jobs || []) {
    if (job.kind !== 'pre_lineup_board' && job.kind !== 'lineup_lock') continue;
    const sendAtMs = new Date(job.send_at_utc).getTime();
    if (nowMs < sendAtMs) continue;
    const marker = job.kind === 'pre_lineup_board'
      ? 'pre_lineup_board'
      : `lineup_lock-${job.match_id}`;
    if (marked(marker)) continue;
    actions.push({
      kind: 'generate_packet',
      phase: job.kind,
      packet_stage: job.packet_stage,
      marker,
      match_id: job.match_id ?? null,
      stem: job.stem,
      send_at_utc: job.send_at_utc,
      send_at_local: job.send_at_local,
    });
  }

  for (const m of upcoming) {
    const gradeAt = new Date(m.kickoff_utc).getTime() + (150 * 60 * 1000);
    if (nowMs < gradeAt) continue;
    const name = `post_match_grade-${m.match_id}`;
    if (!marked(name)) {
      actions.push({ kind: 'grade_match', match_id: m.match_id, marker: name });
    }
  }

  return { actions, note: actions.length === 0 ? 'nothing due' : null, schedule };
}

export function runGenerator({ date, stateRoot, dryRun, packetStage = null, matchId = null, refreshLineups = false, spawn = spawnSync }) {
  const args = [GENERATOR, '--date', date, '--state-root', stateRoot];
  if (packetStage) args.push('--packet-stage', packetStage);
  if (matchId) args.push('--match-id', String(matchId));
  if (refreshLineups) args.push('--refresh-lineups');
  if (dryRun) args.push('--dry-run');
  const r = spawn(process.execPath, args, { stdio: 'inherit' });
  return r.status === 0;
}

export function runPacketSender({ date, stateRoot, stem, dryRun, spawn = spawnSync }) {
  const args = [
    SENDER,
    '--type', 'worldcup-matchday',
    '--date', date,
    '--state-root', stateRoot,
    '--only', stem,
  ];
  if (dryRun) args.push('--dry-run');
  const r = spawn(process.execPath, args, { stdio: 'inherit' });
  return r.status === 0;
}

export function dispatchGeneratePacketAction({
  action,
  date,
  stateRoot,
  dryRun = false,
  runGeneratorFn = runGenerator,
  runPacketSenderFn = runPacketSender,
  writeMarkerFn = writeMarker,
}) {
  if (dryRun) {
    return { ok: true, dryRun: true, stage: 'dry_run', generator_called: false, sender_called: false, marker_written: false };
  }

  const generatorOk = runGeneratorFn({
    date,
    stateRoot,
    dryRun: false,
    packetStage: action.packet_stage,
    matchId: action.match_id,
    refreshLineups: LINEUP_FETCH_PHASES.has(action.phase),
  });
  if (!generatorOk) {
    return { ok: false, stage: 'generator_failed', generator_called: true, sender_called: false, marker_written: false };
  }

  const senderOk = runPacketSenderFn({
    date,
    stateRoot,
    stem: action.stem,
    dryRun: false,
  });
  if (!senderOk) {
    return { ok: false, stage: 'sender_failed', generator_called: true, sender_called: true, marker_written: false };
  }

  const marker_written = Boolean(action.marker);
  if (marker_written) {
    writeMarkerFn(stateRoot, date, action.marker, { action });
  }

  return { ok: true, stage: 'sent', generator_called: true, sender_called: true, marker_written };
}

/**
 * Grade the model call against the final score. Reads the latest audit
 * artifact (model favored_side) and the refreshed structure (result).
 * Market prices play no part in grading inputs — composite vs result only.
 */
export function gradeMatch({ structure, audit, matchId }) {
  const match = (structure?.matches || []).find(m => String(m.match_id) === String(matchId));
  if (!match) return { ok: false, error: `match ${matchId} not in structure` };
  if (match.home_goals == null || match.away_goals == null) {
    return { ok: false, pending: true, error: 'no final score yet' };
  }
  const record = (audit?.records || []).find(r => String(r.match?.match_id) === String(matchId));
  const favored = record?.ledger?.favored_side ?? null;
  const actual = match.home_goals > match.away_goals ? 'home'
    : match.away_goals > match.home_goals ? 'away' : 'draw';
  const grade = favored == null || favored === 'even'
    ? 'NO_CALL'
    : favored === actual ? 'WIN' : 'LOSS';
  return {
    ok: true,
    match_id: matchId,
    home_team: match.home_team,
    away_team: match.away_team,
    final_score: `${match.home_goals}-${match.away_goals}`,
    model_favored: favored,
    actual,
    grade,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { date, stateRoot, dryRun, nowDate } = opts;

  const schedule = buildWorldCupPacketSchedule({ date, stateRoot });
  if (!schedule.ok) {
    console.log(`[worldcup-dispatch] ${schedule.error}; run daily-sync first. Nothing to do.`);
    return;
  }

  const structure = schedule.structure;
  const todayMatches = schedule.matches || [];
  const { actions, note } = computeDueActions({ matches: todayMatches, now: nowDate, stateRoot, date, schedule });

  if (note) console.log(`[worldcup-dispatch] ${nowDate.toISOString()} ${date}: ${note}`);
  if (actions.length === 0) return;

  for (const action of actions) {
    console.log(`[worldcup-dispatch] due: ${JSON.stringify(action)}`);
    if (dryRun) continue;

    if (action.kind === 'generate_packet') {
      const result = dispatchGeneratePacketAction({
        action,
        date,
        stateRoot,
      });
      if (!result.ok && result.stage === 'generator_failed') {
        console.error(`[worldcup-dispatch] generator failed for phase ${action.phase}`);
        continue;
      }
      if (!result.ok && result.stage === 'sender_failed') {
        console.error(`[worldcup-dispatch] sender failed for phase ${action.phase}; leaving marker unset`);
        continue;
      }
    } else if (action.kind === 'grade_match') {
      const auditPath = resolve(stateRoot, 'packets', date, 'worldcup-matchday', `worldcup-${date}-audit.json`);
      const audit = readJsonIfExists(auditPath);
      const graded = gradeMatch({ structure, audit, matchId: action.match_id });
      if (graded.pending) {
        console.log(`[worldcup-dispatch] grade pending for ${action.match_id}: no final score yet`);
        continue; // no marker — retry next run
      }
      const gradeDir = resolve(stateRoot, 'worldcup', date, 'grades');
      mkdirSync(gradeDir, { recursive: true });
      writeFileSync(resolve(gradeDir, `${action.match_id}.json`), JSON.stringify(graded, null, 2), 'utf8');
      writeMarker(stateRoot, date, action.marker, { action });
      console.log(`[worldcup-dispatch] graded ${action.match_id}: ${graded.grade ?? graded.error}`);
    }
  }

  if (dryRun) console.log(`[worldcup-dispatch] DRY RUN — no packets written, no markers set.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error(`[worldcup-dispatch] FATAL: ${e.message}`);
    process.exit(1);
  });
}
