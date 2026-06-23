#!/usr/bin/env node
// World Cup schedule-aware cron dispatcher.
//
// Usage:
//   node scripts/worldcup/cron/cron-dispatch.mjs [--date YYYY-MM-DD] [--now ISO]
//                                                [--state-root state] [--dry-run]
//
// Designed to run every 15 minutes from crontab. Reads the cached fixture
// structure for the date and decides — from real kickoff times — which phase
// each match is in, then runs the packet generator / grader accordingly.
// Idempotent: phase markers under state/worldcup/<date>/cron/ prevent repeats.
//
// Phases (relative to kickoff K):
//   pre_lineup_board     K-6h  .. K-90m   morning board packet (once per date)
//   lineup_window        K-90m .. K-40m   refresh packet each run (lineups land ~K-75m)
//   post_lineup_final    K-40m .. K       final packet (once per match window)
//   post_match_grade     K+150m ..        grade model vs result (once per match)
//   knockout_switch      automatic — derived from match.stage in the fixture
//                        data; logged here so the switch is auditable.
//
// Script-owned scheduler glue only. No LLM. No send_message. No trades.
// Exit codes: 0 = ok (including nothing due), 1 = hard error.

import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { filterMatchesForLocalDate, CPC_MATCHDAY_TIMEZONE } from '../lib/matchday-window.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATOR = join(__dirname, '..', 'generate-matchday-packet.mjs');
const LINEUP_FETCHER = join(__dirname, '..', 'source-adapters', 'fetch-official-lineups.mjs');
// Phases where official starting XIs may be published — refresh the lineup
// cache from source before generating so the packet can reach lineup_locked.
const LINEUP_FETCH_PHASES = new Set(['lineup_window', 'post_lineup_final']);

const MIN = 60 * 1000;

export const PHASE_WINDOWS = Object.freeze({
  pre_lineup_board: { from: -360, to: -90 },   // minutes relative to kickoff
  lineup_window: { from: -90, to: -40 },
  post_lineup_final: { from: -40, to: 0 },
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
  const actions = [];
  const marked = hasMarker ?? ((name) => markerExists(stateRoot, date, name));

  const upcoming = (matches || []).filter(m => m.kickoff_utc);
  if (upcoming.length === 0) {
    return { actions, note: 'no fixtures with kickoff times for this date' };
  }

  const nowMs = now.getTime();
  const minutesFromKickoff = (m) => (nowMs - new Date(m.kickoff_utc).getTime()) / MIN;

  // Knockout switch is data-driven; surface it for the audit trail.
  const knockout = upcoming.some(m => m.stage && m.stage !== 'group');
  if (knockout) {
    actions.push({ kind: 'knockout_switch', note: 'knockout-stage fixture present; ET/penalty layer + advance lane active' });
  }

  // Date-level morning board: due when ANY match enters its pre-lineup window.
  const inPre = upcoming.some(m => {
    const t = minutesFromKickoff(m);
    return t >= PHASE_WINDOWS.pre_lineup_board.from && t < PHASE_WINDOWS.pre_lineup_board.to;
  });
  if (inPre && !marked('pre_lineup_board')) {
    actions.push({ kind: 'generate_packet', phase: 'pre_lineup_board', marker: 'pre_lineup_board' });
  }

  // Lineup window: regenerate every run while any match is in the window (no marker).
  const inLineupWindow = upcoming.some(m => {
    const t = minutesFromKickoff(m);
    return t >= PHASE_WINDOWS.lineup_window.from && t < PHASE_WINDOWS.lineup_window.to;
  });
  if (inLineupWindow) {
    actions.push({ kind: 'generate_packet', phase: 'lineup_window', marker: null });
  }

  // Post-lineup final: once per match.
  for (const m of upcoming) {
    const t = minutesFromKickoff(m);
    if (t >= PHASE_WINDOWS.post_lineup_final.from && t < PHASE_WINDOWS.post_lineup_final.to) {
      const name = `post_lineup_final-${m.match_id}`;
      if (!marked(name)) {
        actions.push({ kind: 'generate_packet', phase: 'post_lineup_final', marker: name, match_id: m.match_id });
      }
    }
  }

  // Post-match grade: once per match, only when a result exists.
  for (const m of upcoming) {
    const t = minutesFromKickoff(m);
    if (t >= PHASE_WINDOWS.post_match_grade.from) {
      const name = `post_match_grade-${m.match_id}`;
      if (!marked(name)) {
        actions.push({ kind: 'grade_match', match_id: m.match_id, marker: name });
      }
    }
  }

  return { actions, note: actions.length === 0 ? 'nothing due' : null };
}

function runGenerator({ date, stateRoot, dryRun }) {
  const args = [GENERATOR, '--date', date, '--state-root', stateRoot];
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  return r.status === 0;
}

// Best-effort: pull official starting XIs into the matchday cache so the
// generator can lock the lineup. Failure (e.g. source down / XIs not yet
// posted) is non-fatal — the generator falls back to the pre-lock board.
function runLineupFetch({ date, stateRoot }) {
  const args = [LINEUP_FETCHER, '--date', date, '--state-root', stateRoot];
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[worldcup-dispatch] lineup fetch non-zero (status ${r.status}); proceeding with pre-lock fallback`);
  }
  return r.status === 0;
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

  const structPath = resolve(stateRoot, 'worldcup', date, 'discovery', 'static_structure.json');
  const structure = readJsonIfExists(structPath);
  if (!structure) {
    console.log(`[worldcup-dispatch] no cached structure for ${date}; run daily-sync first. Nothing to do.`);
    return;
  }

  // Select today's matches by America/Chicago local date (the CPC operating
  // timezone), not raw UTC. A late kickoff such as 02:00Z belongs to the prior
  // Chicago date; a UTC startsWith() would orphan it from its slate.
  const todayMatches = filterMatchesForLocalDate(structure.matches || [], date, CPC_MATCHDAY_TIMEZONE);
  const { actions, note } = computeDueActions({ matches: todayMatches, now: nowDate, stateRoot, date });

  if (note) console.log(`[worldcup-dispatch] ${nowDate.toISOString()} ${date}: ${note}`);
  if (actions.length === 0) return;

  for (const action of actions) {
    console.log(`[worldcup-dispatch] due: ${JSON.stringify(action)}`);
    if (dryRun) continue;

    if (action.kind === 'generate_packet') {
      if (LINEUP_FETCH_PHASES.has(action.phase)) {
        runLineupFetch({ date, stateRoot });
      }
      const ok = runGenerator({ date, stateRoot, dryRun: false });
      if (ok && action.marker) writeMarker(stateRoot, date, action.marker, { action });
      if (!ok) console.error(`[worldcup-dispatch] generator failed for phase ${action.phase}`);
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
