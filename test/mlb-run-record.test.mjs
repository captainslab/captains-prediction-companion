import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../scripts/packets/generate-mlb-daily.mjs';
import { hashRunRecordValue, readRunRecord, writeRunRecord } from '../scripts/mlb/lib/mlb-run-record.mjs';

const DATE = '2026-07-18';

function baseRecord(overrides = {}) {
  return {
    run_type: 'morning_proxy',
    game_pk: 824414,
    generated_at_utc: '2026-07-18T10:00:00.000Z',
    generation_date: DATE,
    lineup_confidence: 'PROXY',
    lineup_source: {
      mode: 'LAST_LOCKED_LINEUP_PROXY',
      proxy_date: '2026-07-17',
      proxy_game_pk: 824400,
      batting_order_hash: 'a'.repeat(64),
    },
    starters: {
      away: { name: 'Away Starter', source: 'stats_adapter', as_of: DATE },
      home: { name: 'Home Starter', source: 'mlb_official_adapter', as_of: DATE },
    },
    models: {
      score: { status: 'provisional', outputs: { moneyline_home: 0.55 } },
      yrfi: { status: 'provisional', outputs: { yrfi_prob: 0.51 } },
      ks_home: { status: 'blocked', outputs: null },
      ks_away: { status: 'blocked', outputs: null },
      hr: { status: 'blocked', outputs: [] },
      composite: { status: 'PASS', outputs: { classification: 'PASS' } },
    },
    input_hash: 'b'.repeat(64),
    ...overrides,
  };
}

test('writeRunRecord produces the exact immutable schema and is readable', () => {
  const root = mkdtempSync(join(tmpdir(), 'mlb-run-record-'));
  const result = writeRunRecord(root, baseRecord());
  const record = JSON.parse(readFileSync(result.path, 'utf8'));

  assert.deepEqual(Object.keys(record), [
    'run_id', 'run_type', 'game_pk', 'generated_at_utc', 'generation_date',
    'lineup_confidence', 'lineup_source', 'starters', 'models', 'input_hash', 'output_hash',
  ]);
  assert.equal(record.run_type, 'morning_proxy');
  assert.equal(record.game_pk, 824414);
  assert.match(record.run_id, /^[a-f0-9]{64}$/);
  assert.equal(record.run_id, hashRunRecordValue({
    game_pk: record.game_pk,
    run_type: record.run_type,
    generated_at_utc: record.generated_at_utc,
  }));
  assert.equal(record.output_hash, hashRunRecordValue(record.models));
  for (const model of Object.values(record.models)) {
    assert.deepEqual(Object.keys(model), ['status', 'outputs', 'hash']);
    assert.match(model.hash, /^[a-f0-9]{64}$/);
  }
  assert.equal(readRunRecord(root, DATE, 824414, 'morning_proxy').run_id, record.run_id);
});

test('a second write for the same game and run type preserves the first file', () => {
  const root = mkdtempSync(join(tmpdir(), 'mlb-run-record-collision-'));
  const first = writeRunRecord(root, baseRecord());
  const second = writeRunRecord(root, baseRecord({ input_hash: 'c'.repeat(64) }));
  const files = readdirSync(join(root, 'mlb', DATE, 'runs')).filter(name => name.endsWith('.json'));

  assert.notEqual(second.path, first.path);
  assert.equal(files.length, 2);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).input_hash, 'b'.repeat(64));
  assert.equal(JSON.parse(readFileSync(second.path, 'utf8')).input_hash, 'c'.repeat(64));
});

function writeJson(root, relative, value) {
  const path = join(root, relative);
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('generate-mlb-daily writes all six morning_proxy slots and audits blocked projections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlb-morning-main-'));
  const discovery = `mlb/${DATE}/discovery`;
  writeJson(root, `${discovery}/stats_adapter.json`, {
    records: [{
      game_pk: 824414,
      game_date: DATE,
      away_team: 'Away Club',
      home_team: 'Home Club',
      away_pitcher: { name: 'Away Stats Starter', mlb_id: 1, era: 3.2, k_pct: 0.24, games_started: 10, batters_faced: 220 },
      home_pitcher: { name: 'Home Stats Starter', mlb_id: 2, era: 3.8, k_pct: 0.22, games_started: 10, batters_faced: 220 },
      probable_pitchers: { away: 'Away Stats Starter', home: 'Home Stats Starter' },
      away_team_stats: { runs_scored: 320, runs_allowed: 300, gamesPlayed: 80 },
      home_team_stats: { runs_scored: 340, runs_allowed: 310, gamesPlayed: 80 },
      away_bullpen: { era: 4.1 },
      home_bullpen: { era: 4.2 },
      lineup_status: 'lineup_pending',
    }],
  });
  writeJson(root, `${discovery}/context_adapter.json`, { records: [{ game_pk: 824414, lineup_status: 'lineup_pending' }] });
  writeJson(root, `${discovery}/mlb_official_adapter.json`, {
    records: [{ game_pk: 824414, probable_pitchers: { away: 'Away Official Starter', home: 'Home Official Starter' } }],
  });
  writeJson(root, `${discovery}/weather_adapter.json`, { records: [{ game_pk: 824414, weather_status: 'complete' }] });
  writeJson(root, `mlb/${DATE}/picks.json`, {
    picks: [{ matched_game_pk: 824414, classification: 'PASS', primary_pick: true, gates_passed: ['model'] }],
  });

  await main(['--date', DATE, '--state-root', root], {
    primeResearch: () => [],
    fetchEvents: async () => ({ ok: true, events: [] }),
  });

  const runDir = join(root, 'mlb', DATE, 'runs');
  const record = readRunRecord(root, DATE, 824414, 'morning_proxy');
  assert.ok(record);
  assert.deepEqual(Object.keys(record.models), ['score', 'yrfi', 'ks_home', 'ks_away', 'hr', 'composite']);
  assert.ok(Object.values(record.models).every(model => model.status !== null));
  assert.equal(record.lineup_confidence, 'PROXY');
  assert.equal(record.starters.away.source, 'stats_adapter');
  assert.equal(record.starters.home.source, 'stats_adapter');
  assert.doesNotMatch(JSON.stringify(record.models), /yes_bid|yes_ask|volume|open_interest|odds/);

  const audit = JSON.parse(readFileSync(join(runDir, 'invocation-audit.json'), 'utf8'));
  const game = audit.games.find(item => item.game_pk === 824414);
  assert.deepEqual(game.skipped_models.map(item => item.model).sort(), ['hr', 'ks_away', 'ks_home']);
  assert.equal(game.models.score.ran, true);
  assert.equal(game.models.ks_home.skipped, true);
  assert.match(game.models.ks_home.reason, /blocked/);
});
