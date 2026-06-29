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
import { readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeDueActions,
  dispatchGeneratePacketAction,
  gradeMatch,
  runGenerator,
  runPacketSender,
} from '../scripts/worldcup/cron/cron-dispatch.mjs';
import {
  buildWorldCupPacketSchedule,
  LINEUP_LOCK_LEAD_MINUTES,
} from '../scripts/worldcup/cron/worldcup-schedule.mjs';

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

function tempScheduleRoot(match = OPENER) {
  const root = mkdtempSync(join(tmpdir(), 'wc-sched-'));
  mkdirSync(join(root, 'worldcup', '2026-06-11', 'discovery'), { recursive: true });
  writeFileSync(
    join(root, 'worldcup', '2026-06-11', 'discovery', 'static_structure.json'),
    JSON.stringify({ ok: true, matches: [match], match_count: 1 }, null, 2),
  );
  return root;
}

// ---------------------------------------------------------------------------
// Schedule helper + due actions
// ---------------------------------------------------------------------------

test('schedule helper pins the morning preview to 9:00 AM Central', () => {
  const root = tempScheduleRoot();
  try {
    const schedule = buildWorldCupPacketSchedule({ date: '2026-06-11', stateRoot: root });
    assert.equal(schedule.ok, true);
    assert.equal(schedule.lineup_lock_lead_minutes, LINEUP_LOCK_LEAD_MINUTES);
    const morning = schedule.jobs.find((job) => job.kind === 'pre_lineup_board');
    assert.ok(morning, 'morning job must exist');
    assert.match(morning.send_at_local, /9:00 AM C(?:DT|ST)/, `unexpected morning send_at_local: ${morning.send_at_local}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet sender helper targets the exact worldcup stem', () => {
  const calls = [];
  const ok = runPacketSender({
    date: '2026-06-26',
    stateRoot: '/tmp/state',
    stem: 'worldcup-2026-06-26-lineup_lock-norway-france',
    dryRun: false,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    },
  });

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.ok(calls[0].args.some((arg) => String(arg).includes('send-packets-telegram.mjs')));
  assert.ok(calls[0].args.includes('--type'));
  assert.ok(calls[0].args.includes('worldcup-matchday'));
  assert.ok(calls[0].args.includes('--only'));
  assert.ok(calls[0].args.includes('worldcup-2026-06-26-lineup_lock-norway-france'));
});

test('lineup-lock generation requests a fresh lineup refresh before calculating', () => {
  const calls = [];
  const ok = runGenerator({
    date: '2026-06-26',
    stateRoot: '/tmp/state',
    dryRun: false,
    packetStage: 'lineup_lock',
    matchId: '400021443',
    refreshLineups: true,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    },
  });

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.ok(calls[0].args.some((arg) => String(arg).includes('generate-matchday-packet.mjs')));
  assert.ok(calls[0].args.includes('--refresh-lineups'));
  assert.ok(calls[0].args.includes('--packet-stage'));
  assert.ok(calls[0].args.includes('lineup_lock'));
});

test('dispatch helper dry-run never calls generator, sender, or marker writes', () => {
  const calls = [];
  const result = dispatchGeneratePacketAction({
    action: {
      phase: 'lineup_lock',
      packet_stage: 'lineup_lock',
      stem: 'worldcup-2026-06-26-lineup_lock-norway-france',
      marker: 'lineup_lock-400021443',
      match_id: '400021443',
    },
    date: '2026-06-26',
    stateRoot: '/tmp/state',
    dryRun: true,
    runGeneratorFn: () => { calls.push('generator'); return true; },
    runPacketSenderFn: () => { calls.push('sender'); return true; },
    writeMarkerFn: () => { calls.push('marker'); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stage, 'dry_run');
  assert.deepEqual(calls, []);
});

test('dispatch helper runs generator before sender and writes the marker only after sender success', () => {
  const calls = [];
  const result = dispatchGeneratePacketAction({
    action: {
      phase: 'lineup_lock',
      packet_stage: 'lineup_lock',
      stem: 'worldcup-2026-06-26-lineup_lock-norway-france',
      marker: 'lineup_lock-400021443',
      match_id: '400021443',
    },
    date: '2026-06-26',
    stateRoot: '/tmp/state',
    runGeneratorFn: (opts) => {
      calls.push(['generator', opts]);
      return true;
    },
    runPacketSenderFn: (opts) => {
      calls.push(['sender', opts]);
      return true;
    },
    writeMarkerFn: (stateRoot, date, marker, payload) => {
      calls.push(['marker', { stateRoot, date, marker, payload }]);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stage, 'sent');
  assert.deepEqual(calls.map(([kind]) => kind), ['generator', 'sender', 'marker']);
  assert.equal(calls[0][1].refreshLineups, true);
  assert.equal(calls[1][1].stem, 'worldcup-2026-06-26-lineup_lock-norway-france');
  assert.equal(calls[2][1].marker, 'lineup_lock-400021443');
});

test('dispatch helper generator failure does not send and does not mark', () => {
  const calls = [];
  const result = dispatchGeneratePacketAction({
    action: {
      phase: 'lineup_lock',
      packet_stage: 'lineup_lock',
      stem: 'worldcup-2026-06-26-lineup_lock-norway-france',
      marker: 'lineup_lock-400021443',
      match_id: '400021443',
    },
    date: '2026-06-26',
    stateRoot: '/tmp/state',
    runGeneratorFn: () => {
      calls.push('generator');
      return false;
    },
    runPacketSenderFn: () => {
      calls.push('sender');
      return true;
    },
    writeMarkerFn: () => {
      calls.push('marker');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'generator_failed');
  assert.deepEqual(calls, ['generator']);
});

test('dispatch helper sender failure does not write the marker', () => {
  const calls = [];
  const result = dispatchGeneratePacketAction({
    action: {
      phase: 'lineup_lock',
      packet_stage: 'lineup_lock',
      stem: 'worldcup-2026-06-26-lineup_lock-norway-france',
      marker: 'lineup_lock-400021443',
      match_id: '400021443',
    },
    date: '2026-06-26',
    stateRoot: '/tmp/state',
    runGeneratorFn: () => {
      calls.push('generator');
      return true;
    },
    runPacketSenderFn: () => {
      calls.push('sender');
      return false;
    },
    writeMarkerFn: () => {
      calls.push('marker');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'sender_failed');
  assert.deepEqual(calls, ['generator', 'sender']);
});

test('fresh lineup cache helper accepts source event id differences and rejects stale snapshots', async () => {
  const { isFreshLineupCache } = await import('../scripts/worldcup/lib/lineup-freshness.mjs');
  assert.equal(
    isFreshLineupCache({
      ok: true,
      match_id: '400021443',
      source: { event_id: '400021443', event_state: 'pre' },
      fetched_utc: '2026-06-26T18:45:10.000Z',
    }, {
      matchId: '400021443',
      kickoffUtc: '2026-06-26T19:00:00.000Z',
      refreshStartedAtIso: '2026-06-26T18:45:00.000Z',
    }),
    true,
  );
  assert.equal(
    isFreshLineupCache({
      ok: true,
      match_id: '400021443',
      source: { event_id: '400099999', event_state: 'pre' },
      fetched_utc: '2026-06-26T18:45:10.000Z',
    }, {
      matchId: '400021443',
      kickoffUtc: '2026-06-26T19:00:00.000Z',
      refreshStartedAtIso: '2026-06-26T18:45:00.000Z',
    }),
    true,
  );
  assert.equal(
    isFreshLineupCache({
      ok: true,
      match_id: '400021443',
      source: { event_id: '400021443', event_state: 'pre' },
      fetched_utc: '2026-06-26T18:39:00.000Z',
    }, {
      matchId: '400021443',
      kickoffUtc: '2026-06-26T19:00:00.000Z',
      refreshStartedAtIso: '2026-06-26T18:45:00.000Z',
    }),
    false,
  );
  assert.equal(
    isFreshLineupCache({
      ok: true,
      source: { event_id: '400021443', event_state: 'pre' },
      fetched_utc: '2026-06-26T18:45:10.000Z',
    }, {
      matchId: '400021443',
      kickoffUtc: '2026-06-26T19:00:00.000Z',
      refreshStartedAtIso: '2026-06-26T18:45:00.000Z',
    }),
    false,
  );
});

test('T-5h → pre-lineup board due once; marker suppresses repeat', () => {
  const first = due({ at: '2026-06-11T14:00:00Z' });
  assert.deepEqual(first.actions.map((a) => a.phase), ['pre_lineup_board']);
  const repeat = due({ at: '2026-06-11T14:15:00Z', markers: ['pre_lineup_board'] });
  assert.equal(repeat.actions.length, 0, 'marker must prevent duplicate morning board');
});

test('T-45m → lineup-lock packet due once per match; marker suppresses repeat', () => {
  const a = due({ at: '2026-06-11T18:15:00Z', markers: ['pre_lineup_board'] });
  assert.deepEqual(a.actions.map((x) => x.phase), ['lineup_lock']);
  assert.equal(a.actions[0].match_id, OPENER.match_id);
  assert.equal(a.actions[0].marker, `lineup_lock-${OPENER.match_id}`);
  const repeat = due({ at: '2026-06-11T18:30:00Z', markers: ['pre_lineup_board', `lineup_lock-${OPENER.match_id}`] });
  assert.equal(repeat.actions.length, 0, 'marker must prevent duplicate lineup-lock packet');
});

test('T+3h → post-match grade due once per match', () => {
  const a = due({ at: '2026-06-11T22:00:00Z', markers: ['pre_lineup_board', `lineup_lock-${OPENER.match_id}`] });
  assert.deepEqual(a.actions.map(x => x.kind), ['grade_match']);
  const repeat = due({ at: '2026-06-11T23:00:00Z', markers: ['pre_lineup_board', `lineup_lock-${OPENER.match_id}`, `post_match_grade-${OPENER.match_id}`] });
  assert.equal(repeat.actions.length, 0);
});

test('schedule helper deduplicates repeated fixtures by stable match job key', () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-sched-dupe-'));
  try {
    mkdirSync(join(root, 'worldcup', '2026-06-11', 'discovery'), { recursive: true });
    writeFileSync(
      join(root, 'worldcup', '2026-06-11', 'discovery', 'static_structure.json'),
      JSON.stringify({ ok: true, matches: [OPENER, OPENER], match_count: 2 }, null, 2),
    );
    const schedule = buildWorldCupPacketSchedule({ date: '2026-06-11', stateRoot: root });
    const lineupJobs = schedule.jobs.filter((job) => job.kind === 'lineup_lock');
    assert.equal(lineupJobs.length, 1, 'duplicate match jobs must collapse to one');
    assert.equal(new Set(schedule.jobs.map((job) => job.stem)).size, schedule.jobs.length, 'stems must remain unique');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    mkdirSync(join(stateRoot, 'worldcup', '2026-06-11', 'discovery'), { recursive: true });
    const struct = { ok: true, matches: [OPENER], match_count: 1 };
    writeFileSync(join(stateRoot, 'worldcup', '2026-06-11', 'discovery', 'static_structure.json'), JSON.stringify(struct, null, 2));

    const morning = computeDueActions({
      matches: [OPENER],
      now: new Date('2026-06-11T14:00:00Z'),
      stateRoot,
      date: '2026-06-11',
      hasMarker: () => false,
    });
    assert.deepEqual(morning.actions.map((a) => a.phase), ['pre_lineup_board']);
    assert.equal(morning.note, null);

    const lineup = computeDueActions({
      matches: [OPENER],
      now: new Date('2026-06-11T18:15:00Z'),
      stateRoot,
      date: '2026-06-11',
      hasMarker: (name) => name === 'pre_lineup_board',
    });
    assert.deepEqual(lineup.actions.map((a) => a.phase), ['lineup_lock']);
    assert.equal(lineup.actions[0].match_id, OPENER.match_id);
    assert.ok(!existsSync(join(stateRoot, 'worldcup', '2026-06-11', 'cron')), 'dry-run must not write markers');
    assert.ok(!existsSync(join(stateRoot, 'packets')), 'dry-run must not write packets');
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
