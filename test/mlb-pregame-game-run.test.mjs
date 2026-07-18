import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPregameGame } from '../scripts/mlb/pregame-game-run.mjs';
import {
  buildConfirmedLineupRunRecord,
  lineupsNotLockedPath,
} from '../scripts/mlb/lib/mlb-run-record.mjs';

const DATE = '2099-07-18';
const GAME_PK = 9001;

function fixtureState(root, { lineupStatus = 'confirmed_or_boxscore_available' } = {}) {
  const discovery = join(root, 'mlb', DATE, 'discovery');
  mkdirSync(discovery, { recursive: true });
  const official = {
    game_pk: GAME_PK,
    game_date: DATE,
    away_team: 'Alpha City Aces',
    home_team: 'Beta Town Bears',
    away_team_abbrev: 'ACA',
    home_team_abbrev: 'BTB',
    start_time_utc: '2099-07-18T23:00:00.000Z',
    venue: 'Source Park',
  };
  const stats = {
    game_pk: GAME_PK,
    game_date: DATE,
    checked_at_utc: '2099-07-18T18:00:00.000Z',
    away_team: official.away_team,
    home_team: official.home_team,
    venue: official.venue,
    away_pitcher: { name: 'Ada Ace', mlb_id: 11, era: 3.2, whip: 1.1, k_pct: 0.24, games_started: 10, batters_faced: 500, hand: 'R' },
    home_pitcher: { name: 'Byron Bear', mlb_id: 22, era: 4.1, whip: 1.3, k_pct: 0.21, games_started: 10, batters_faced: 480, hand: 'L' },
    away_team_stats: { wins: 12, losses: 8, gamesPlayed: 20, runDiff: 18, runs_scored: 100, runs_allowed: 82, ops: 0.75, last10: '7-3' },
    home_team_stats: { wins: 9, losses: 11, gamesPlayed: 20, runDiff: -10, runs_scored: 86, runs_allowed: 96, ops: 0.70, last10: '4-6' },
    away_bullpen: { era: 3.8, recentLoadPct: 30 },
    home_bullpen: { era: 4.5, recentLoadPct: 60 },
  };
  const context = {
    game_pk: GAME_PK,
    checked_at_utc: '2099-07-18T22:00:00.000Z',
    lineup_status: lineupStatus,
    away_batting_order: [101, 102, 103, 104, 105, 106, 107, 108, 109],
    home_batting_order: [201, 202, 203, 204, 205, 206, 207, 208, 209],
    probable_pitchers: { away: 'Ada Ace', home: 'Byron Bear' },
    away_team: official.away_team,
    home_team: official.home_team,
  };
  const weather = { game_pk: GAME_PK, venue: official.venue, temperature: 72, wind_speed: 8, precipitation_risk: 0.05 };
  writeFileSync(join(discovery, 'mlb_official_adapter.json'), JSON.stringify({ records: [official] }));
  writeFileSync(join(discovery, 'stats_adapter.json'), JSON.stringify({ records: [stats] }));
  writeFileSync(join(discovery, 'context_adapter.json'), JSON.stringify({ records: [context] }));
  writeFileSync(join(discovery, 'weather_adapter.json'), JSON.stringify({ records: [weather] }));
  writeFileSync(join(discovery, 'baseball_savant_adapter.json'), JSON.stringify({ records: [] }));
  return { discovery, context };
}

function options(root, overrides = {}) {
  return {
    gamePk: String(GAME_PK),
    date: DATE,
    stateRoot: root,
    noSend: true,
    maxRetries: 0,
    ...overrides,
  };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('lineups-not-locked is written after retries and no sender function runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlb-pregame-pending-'));
  try {
    fixtureState(root, { lineupStatus: 'lineup_pending' });
    let refreshes = 0;
    let sends = 0;
    const result = await runPregameGame({
      injectedOptions: options(root, { maxRetries: 2 }),
      refreshPregame: async () => { refreshes += 1; },
      sleepImpl: async () => {},
      sendMessage: async () => { sends += 1; },
      sendDocument: async () => { sends += 1; },
    });
    assert.equal(result.status, 'lineups_not_locked');
    assert.equal(result.sent, false);
    assert.equal(refreshes, 3);
    assert.equal(sends, 0);
    const artifact = JSON.parse(readFileSync(lineupsNotLockedPath(root, DATE, GAME_PK), 'utf8'));
    assert.equal(artifact.retries_exhausted, true);
    assert.ok(artifact.affected_layers.includes('hr'));
    assert.ok(artifact.affected_layers.includes('ks_home'));
    assert.equal(existsSync(join(root, 'mlb', DATE, 'runs', `${GAME_PK}-confirmed_lineup.json`)), false);
  } finally {
    cleanup(root);
  }
});

test('confirmed-lineup run is fresh, does not read picks.json, and preserves morning_proxy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlb-pregame-confirmed-'));
  try {
    fixtureState(root);
    const morningPath = join(root, 'mlb', DATE, 'runs', `${GAME_PK}-morning_proxy.json`);
    mkdirSync(join(root, 'mlb', DATE, 'runs'), { recursive: true });
    const morning = { run_type: 'morning_proxy', lineup_confidence: 'PROXY', untouched: true };
    writeFileSync(morningPath, JSON.stringify(morning));
    writeFileSync(join(root, 'mlb', DATE, 'picks.json'), '{ invalid frozen morning snapshot');

    const result = await runPregameGame({
      injectedOptions: options(root),
      refreshPregame: async () => {},
      sleepImpl: async () => {},
    });
    assert.equal(result.status, 'confirmed_lineup');
    const recordPath = join(root, 'mlb', DATE, 'runs', `${GAME_PK}-confirmed_lineup.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(record.run_type, 'confirmed_lineup');
    assert.equal(record.lineup_confidence, 'CONFIRMED');
    assert.equal(record.lineup_source.mode, 'current_boxscore');
    assert.equal(record.models.score.schema_version, 'mlb_score_engine_projection_v1');
    assert.ok(record.models.composite.board);
    assert.doesNotMatch(JSON.stringify(record.models), /"(?:yes_ask|no_bid|yes_bid|no_ask|price|odds|volume|open_interest|kalshi_ask)"/i);
    assert.deepEqual(JSON.parse(readFileSync(morningPath, 'utf8')), morning);
    assert.ok(existsSync(result.packetPath));
  } finally {
    cleanup(root);
  }
});

test('a confirmed-lineup record cannot be built with non-CONFIRMED lineup source', () => {
  assert.throws(() => buildConfirmedLineupRunRecord({
    gamePk: GAME_PK,
    generatedAtUtc: '2099-07-18T22:00:00.000Z',
    generationDate: DATE,
    lineupSource: { mode: 'last_locked_proxy', batting_order_hash: 'abc' },
    starters: { away: { name: 'A' }, home: { name: 'B' } },
    models: {},
    inputHash: 'abc',
  }), /current_boxscore/);
});

test('--no-send renders one packet without calling Telegram and a real send uses a distinct ledger key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mlb-pregame-send-'));
  try {
    fixtureState(root);
    let noSendCalls = 0;
    const dry = await runPregameGame({
      injectedOptions: options(root, { noSend: true }),
      refreshPregame: async () => {},
      sendMessage: async () => { noSendCalls += 1; },
      sendDocument: async () => { noSendCalls += 1; },
    });
    assert.equal(dry.delivery.status, 'dryrun');
    assert.equal(noSendCalls, 0);

    const sentIds = [];
    const live = await runPregameGame({
      injectedOptions: options(root, { noSend: false }),
      refreshPregame: async () => {},
      sendMessage: async () => { sentIds.push('notice'); return 1; },
      sendDocument: async () => { sentIds.push('document'); return 2; },
    });
    assert.equal(live.delivery.status, 'sent');
    assert.deepEqual(sentIds, ['notice', 'document']);
    const ledger = JSON.parse(readFileSync(join(root, 'packets', DATE, 'mlb-daily', '.delivery-ledger.json'), 'utf8'));
    assert.ok(ledger.delivered[`mlb:confirmed_lineup:${GAME_PK}:${DATE}`]);
    assert.equal(ledger.delivered[`${DATE}-mlb-daily-board`], undefined);
  } finally {
    cleanup(root);
  }
});
