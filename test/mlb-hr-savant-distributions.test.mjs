import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseballSavantDistributions, fixtureBaseballSavantDistributionEnvelope } from '../scripts/mlb/source-adapters/baseball-savant-distributions.mjs';

test('fixture distribution envelope is deterministic, compact, and multi-window', () => {
  const first = fixtureBaseballSavantDistributionEnvelope();
  const second = fixtureBaseballSavantDistributionEnvelope();
  assert.deepEqual(first, second);
  const record = first.records[0];
  assert.deepEqual(Object.keys(record.windows), ['7d', '30d', 'season']);
  assert.ok(record.ev_distribution.p90 >= record.ev_distribution.p50);
  assert.ok(record.ev_distribution.max >= record.ev_distribution.p90);
  assert.ok(record.distance_tail.count_ge_400ft >= 0);
  assert.ok(record.handedness_splits.R || record.handedness_splits.L);
  assert.ok(record.pitch_family_splits.fastball || record.pitch_family_splits.breaking);
});

test('Savant rows produce HR/PA, HR/BIP, spray, launch-angle, and distance coverage', () => {
  const result = buildBaseballSavantDistributions({
    runDate: '2026-07-13',
    rows: [
      { batter: 7, player_name: 'A', game_date: '2026-07-12', events: 'home_run', launch_speed: 110, launch_angle: 25, hit_distance_sc: 425, hc_x: 90, bb_type: 'fly_ball', stand: 'R', pitch_type: 'FF' },
      { batter: 7, player_name: 'A', game_date: '2026-07-11', events: 'field_out', launch_speed: 96, launch_angle: 12, hit_distance_sc: 300, hc_x: 150, bb_type: 'line_drive', stand: 'R', pitch_type: 'SL' },
      { batter: 7, player_name: 'A', game_date: '2026-07-10', events: 'field_out', launch_speed: 92, launch_angle: 4, hit_distance_sc: 200, hit_location: 'oppo', stand: 'R', pitch_type: 'CH' },
    ],
  });
  assert.equal(result.status, 'ok');
  const season = result.records[0].windows.season;
  assert.equal(season.hr, 1);
  assert.equal(season.bip, 3);
  assert.equal(season.hr_per_bip, 1 / 3);
  assert.equal(result.records[0].distance_tail.count_ge_400ft, 1);
  assert.equal(result.records[0].spray_distribution.pull + result.records[0].spray_distribution.center + result.records[0].spray_distribution.oppo, 1);
});

test('scientific notation parses exactly, null launch angle is not pull-air, and CU is breaking', () => {
  const result = buildBaseballSavantDistributions({
    runDate: '2026-07-13',
    rows: [{
      batter: 8, player_name: 'Notation Hitter', game_date: '2026-07-12', events: 'field_out',
      launch_speed: '1.05e2', launch_angle: null, hit_distance_sc: 410, hc_x: 90,
      bb_type: 'line_drive', stand: 'R', pitch_type: 'CU',
    }],
  });
  const record = result.records[0];
  assert.equal(record.windows.season.ev_mean, 105);
  assert.equal(record.windows.season.pull_air_rate, 0);
  assert.ok(record.pitch_family_splits.breaking);
});

test('rows before the run-date season floor contribute to no window and are counted as excluded', () => {
  const result = buildBaseballSavantDistributions({
    runDate: '2026-07-13',
    rows: [{
      batter: 9, player_name: 'Old Hitter', game_date: '2024-07-13', events: 'home_run',
      launch_speed: 110, launch_angle: 28, hit_distance_sc: 425, hc_x: 90,
      bb_type: 'fly_ball', stand: 'R', pitch_type: 'FF',
    }],
  });
  const record = result.records[0];
  for (const window of Object.values(record.windows)) assert.equal(window.pa, 0);
  assert.equal(record.coverage.excluded_rows, 1);
  assert.equal(record.distance_tail.count_ge_400ft, 0);
});

test('equal-size records sort by plain codepoint order', () => {
  const result = buildBaseballSavantDistributions({
    runDate: '2026-07-13',
    rows: [
      { batter: 10, player_name: 'a', game_date: '2026-07-12', launch_speed: 100, launch_angle: 20, hc_x: 90, stand: 'R', pitch_type: 'FF' },
      { batter: 11, player_name: 'Z', game_date: '2026-07-12', launch_speed: 100, launch_angle: 20, hc_x: 90, stand: 'R', pitch_type: 'FF' },
    ],
  });
  assert.deepEqual(result.records.map((record) => record.player_name), ['Z', 'a']);
});

test('distribution adapter fails closed without rows or date', () => {
  assert.equal(buildBaseballSavantDistributions({ rows: [], runDate: '2026-07-13' }).status, 'blocked');
  assert.equal(buildBaseballSavantDistributions({ rows: [{}] }).status, 'blocked');
});
