// World Cup cron tests.
//
// Pins:
//   - schedule-aware phase windows computed from real kickoff times
//   - idempotency via markers (no duplicate packets)
//   - cron wrappers are no-send/no-trade scheduler glue (UFC convention)
//   - grading compares composite call vs final result only (no market input)
//   - dispatcher dry-run proof: decisions without side effects

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeDueActions, gradeMatch, PHASE_WINDOWS } from '../scripts/worldcup/cron/cron-dispatch.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const OPENER = {
  match_id: '400021443',
  home_team: 'Mexico',
  away_team: 'South Africa',
  stage: 'group',
  kickoff_utc: '2026-06-11T19:00:00Z',
};

function due({ at, matches = [OPENER], markers = [] }) {
  const set = new Set(markers);
  return computeDueActions({
    matches,
    now: new Date(at),
    stateRoot: 'unused',
    date: '2026-06-11',
    hasMarker: (name) => set.has(name),
  });
}

// ---------------------------------------------------------------------------
// Phase windows
// ---------------------------------------------------------------------------

test('phase windows are contiguous from T-6h to kickoff', () => {
  assert.equal(PHASE_WINDOWS.pre_lineup_board.to, PHASE_WINDOWS.lineup_window.from);
  assert.equal(PHASE_WINDOWS.lineup_window.to, PHASE_WINDOWS.post_lineup_final.from);
  assert.equal(PHASE_WINDOWS.post_lineup_final.to, 0);
});

test('T-5h → pre-lineup board due once; marker suppresses repeat', () => {
  const first = due({ at: '2026-06-11T14:00:00Z' });
  assert.deepEqual(first.actions.map(a => a.phase), ['pre_lineup_board']);
  const repeat = due({ at: '2026-06-11T14:15:00Z', markers: ['pre_lineup_board'] });
  assert.equal(repeat.actions.length, 0, 'marker must prevent duplicate morning board');
});

test('T-75m → lineup-window refresh fires every run (no marker)', () => {
  const a = due({ at: '2026-06-11T17:45:00Z' });
  assert.deepEqual(a.actions.map(x => x.phase), ['lineup_window']);
  assert.equal(a.actions[0].marker, null, 'lineup window refresh is intentionally unmarked');
  const again = due({ at: '2026-06-11T18:00:00Z' });
  assert.deepEqual(again.actions.map(x => x.phase), ['lineup_window']);
});

test('T-20m → post-lineup final due once per match', () => {
  const a = due({ at: '2026-06-11T18:40:00Z' });
  assert.deepEqual(a.actions.map(x => x.phase), ['post_lineup_final']);
  assert.equal(a.actions[0].match_id, OPENER.match_id);
  const repeat = due({ at: '2026-06-11T18:50:00Z', markers: [`post_lineup_final-${OPENER.match_id}`] });
  assert.equal(repeat.actions.length, 0);
});

test('T+3h → post-match grade due once per match', () => {
  const a = due({ at: '2026-06-11T22:00:00Z' });
  assert.deepEqual(a.actions.map(x => x.kind), ['grade_match']);
  const repeat = due({ at: '2026-06-11T23:00:00Z', markers: [`post_match_grade-${OPENER.match_id}`] });
  assert.equal(repeat.actions.length, 0);
});

test('far from kickoff → nothing due', () => {
  const a = due({ at: '2026-06-11T02:00:00Z' });
  assert.equal(a.actions.length, 0);
  assert.equal(a.note, 'nothing due');
});

test('knockout fixture → knockout_switch surfaces in the audit trail', () => {
  const ko = { ...OPENER, stage: 'round_of_16', kickoff_utc: '2026-06-29T19:00:00Z' };
  const a = computeDueActions({
    matches: [ko],
    now: new Date('2026-06-29T02:00:00Z'),
    stateRoot: 'unused',
    date: '2026-06-29',
    hasMarker: () => false,
  });
  assert.ok(a.actions.some(x => x.kind === 'knockout_switch'), 'knockout switch must be logged');
});

test('fixtures without kickoff times → explicit note, never guessed schedules', () => {
  const a = due({ at: '2026-06-11T14:00:00Z', matches: [{ ...OPENER, kickoff_utc: null }] });
  assert.equal(a.actions.length, 0);
  assert.ok(a.note.includes('no fixtures with kickoff times'));
});

// ---------------------------------------------------------------------------
// Grading — composite vs result only
// ---------------------------------------------------------------------------

const FINISHED = { ...OPENER, home_goals: 2, away_goals: 0 };

test('gradeMatch grades model favored side against the final score', () => {
  const audit = { records: [{ match: { match_id: OPENER.match_id }, ledger: { favored_side: 'home' } }] };
  const g = gradeMatch({ structure: { matches: [FINISHED] }, audit, matchId: OPENER.match_id });
  assert.equal(g.grade, 'WIN');
  assert.equal(g.final_score, '2-0');
});

test('gradeMatch is pending (retry later) without a final score — never fabricates a result', () => {
  const g = gradeMatch({ structure: { matches: [OPENER] }, audit: { records: [] }, matchId: OPENER.match_id });
  assert.equal(g.ok, false);
  assert.equal(g.pending, true);
});

test('gradeMatch with even/missing model call → NO_CALL, not a fake win', () => {
  const audit = { records: [{ match: { match_id: OPENER.match_id }, ledger: { favored_side: 'even' } }] };
  const g = gradeMatch({ structure: { matches: [FINISHED] }, audit, matchId: OPENER.match_id });
  assert.equal(g.grade, 'NO_CALL');
});

// ---------------------------------------------------------------------------
// Wrapper hygiene — no-send/no-trade scheduler glue (UFC convention)
// ---------------------------------------------------------------------------

const WRAPPERS = [
  'scripts/worldcup/worldcup-daily-sync.sh',
  'scripts/worldcup/worldcup-dispatch.sh',
];

for (const wrapper of WRAPPERS) {
  test(`${wrapper} is quiet-mode, repo-rooted, no-send/no-trade`, () => {
    const src = readFileSync(join(REPO, wrapper), 'utf8');
    assert.ok(src.includes('cd /home/jordan/captains-prediction-companion || exit 1'), 'must cd to repo root');
    assert.ok(/LOG_FILE="logs\/worldcup-[a-z-]+\.log"/.test(src), 'must log to logs/worldcup-*.log');
    assert.ok(src.includes('2> >(tee -a "$LOG_FILE" >&2)'), 'stderr must surface to cron AND log');
    assert.doesNotMatch(src, /\b(send|telegram|discord|trade|order)\b/i, 'wrapper must not send messages or place orders');
  });
}

// ---------------------------------------------------------------------------
// Dry-run proof — dispatcher decides without side effects
// ---------------------------------------------------------------------------

test('dispatcher --dry-run emits decisions and writes no packets or markers', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-cron-'));
  try {
    // Minimal cached structure for the dispatcher to read.
    execFileSync('mkdir', ['-p', join(stateRoot, 'worldcup', '2026-06-11', 'discovery')]);
    const struct = { ok: true, matches: [OPENER], match_count: 1 };
    execFileSync('bash', ['-c', `cat > ${join(stateRoot, 'worldcup', '2026-06-11', 'discovery', 'static_structure.json')}`], { input: JSON.stringify(struct) });

    const out = execFileSync(process.execPath, [
      join(REPO, 'scripts/worldcup/cron/cron-dispatch.mjs'),
      '--date', '2026-06-11',
      '--now', '2026-06-11T14:00:00Z',
      '--state-root', stateRoot,
      '--dry-run',
    ], { encoding: 'utf8' });

    assert.ok(out.includes('"phase":"pre_lineup_board"'), `expected pre_lineup_board decision, got: ${out}`);
    assert.ok(out.includes('DRY RUN'), 'must announce dry-run');
    assert.ok(!existsSync(join(stateRoot, 'worldcup', '2026-06-11', 'cron')), 'dry-run must not write markers');
    assert.ok(!existsSync(join(stateRoot, 'packets')), 'dry-run must not write packets');
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
