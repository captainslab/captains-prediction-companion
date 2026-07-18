import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchKalshiReadonly,
  fixtureKalshiBlockedEnvelope,
  fixtureKalshiSuccessEnvelope,
} from '../scripts/mlb/source-adapters/kalshi-readonly.mjs';
import {
  buildSameGameCombos,
  calculateComboEstimates,
  classifyCombo,
  comboStatusFromMembers,
} from '../scripts/mlb/output-writer-core.mjs';
import { fixtureMlbScheduleEnvelope } from '../scripts/mlb/source-adapters/mlb-official-readonly.mjs';
import {
  fetchStatsReadonly,
  fixtureStatsEnvelope,
} from '../scripts/mlb/source-adapters/stats-readonly.mjs';
import {
  fetchBaseballSavantReadonly,
  fixtureBaseballSavantEnvelope,
} from '../scripts/mlb/source-adapters/baseball-savant-readonly.mjs';
import {
  fetchContextReadonly,
} from '../scripts/mlb/source-adapters/context-readonly.mjs';
import {
  loadDynamicCompositeSlate,
  runComposite,
} from '../scripts/mlb/late-slate-composite-refresh.mjs';
import { loadStatsRecords } from '../scripts/mlb/lib/projection-engine.mjs';
import { resolveLastLockedLineupProxy } from '../scripts/mlb/lib/lineup-proxy.mjs';

function makeJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
  };
}

test('last locked lineup proxy resolves the most recent confirmed prior game', () => {
  const proxy = resolveLastLockedLineupProxy({
    team: 'New York Yankees',
    generationDate: '2026-07-18',
    lineup_status: 'lineup_pending',
    priorGames: [
      {
        game_pk: 101,
        game_date: '2026-07-15',
        away_team: 'New York Yankees',
        home_team: 'Boston Red Sox',
        lineup_status: 'confirmed_or_boxscore_available',
        away_batting_order: [101, 102, 103],
        probable_pitchers: { away: 'Older Pitcher' },
      },
      {
        game_pk: 102,
        game_date: '2026-07-17',
        away_team: 'New York Yankees',
        home_team: 'Toronto Blue Jays',
        lineup_status: 'lineup_pending',
        away_batting_order: [201, 202, 203],
      },
      {
        game_pk: 103,
        game_date: '2026-07-16',
        away_team: 'New York Yankees',
        home_team: 'Tampa Bay Rays',
        lineup_status: 'confirmed_or_boxscore_available',
        away_batting_order: [111, 112, 113],
        probable_pitchers: { away: 'Never Copy This Pitcher' },
      },
    ],
  });

  assert.deepEqual(proxy, {
    mode: 'LAST_LOCKED_LINEUP_PROXY',
    proxy_date: '2026-07-16',
    proxy_game_pk: 103,
    batting_order: [111, 112, 113],
    source: 'prior_lineup_context',
    hash: proxy.hash,
  });
  assert.equal(Object.hasOwn(proxy, 'pitcher'), false);
  assert.equal(JSON.stringify(proxy).includes('Never Copy This Pitcher'), false);
  assert.notEqual(proxy.mode, 'confirmed');
  assert.equal(resolveLastLockedLineupProxy({
    team: 'New York Yankees',
    generationDate: '2026-07-18',
    lineup_status: 'lineup_pending',
    priorGames: [{
      game_pk: 104,
      game_date: '2026-07-17',
      away_team: 'New York Yankees',
      home_team: 'Boston Red Sox',
      lineup_status: 'lineup_pending',
    }],
  }), null);
});

test('pending stats merge uses proxy batting order, preserves today probable pitchers, and keeps pending unchanged without a proxy', () => {
  const root = mkdtempSync(join(tmpdir(), 'cpc-lineup-proxy-'));
  const priorDiscovery = join(root, 'mlb', '2026-07-16', 'discovery');
  const currentDiscovery = join(root, 'mlb', '2026-07-18', 'discovery');
  mkdirSync(priorDiscovery, { recursive: true });
  mkdirSync(currentDiscovery, { recursive: true });
  try {
    writeFileSync(join(priorDiscovery, 'mlb_official_adapter.json'), JSON.stringify({ records: [{
      game_pk: 103, game_date: '2026-07-16', away_team: 'New York Yankees', home_team: 'Tampa Bay Rays',
    }] }));
    writeFileSync(join(priorDiscovery, 'context_adapter.json'), JSON.stringify({ records: [{
      game_pk: 103, game_date: '2026-07-16', away_team: 'New York Yankees', home_team: 'Tampa Bay Rays',
      lineup_status: 'confirmed_or_boxscore_available', away_batting_order: [111, 112, 113], home_batting_order: [211, 212, 213],
    }] }));
    writeFileSync(join(currentDiscovery, 'stats_adapter.json'), JSON.stringify({ records: [{
      game_pk: 104, game_date: '2026-07-18', away_team: 'New York Yankees', home_team: 'Boston Red Sox',
      probable_pitchers: { away: 'Today Away', home: 'Today Home' },
    }] }));
    writeFileSync(join(currentDiscovery, 'context_adapter.json'), JSON.stringify({ records: [{
      game_pk: 104, game_date: '2026-07-18', away_team: 'New York Yankees', home_team: 'Boston Red Sox',
      lineup_status: 'lineup_pending', away_batting_order: [], home_batting_order: [],
    }] }));

    const [record] = loadStatsRecords(root, '2026-07-18');
    assert.equal(record.lineup_status, 'proxy');
    assert.deepEqual(record.hr_batters.map(player => player.mlb_id), [111, 112, 113]);
    assert.match(record.hr_lineup_source, /LAST_LOCKED_LINEUP_PROXY from 2026-07-16 vs Tampa Bay Rays/);
    assert.deepEqual(record.probable_pitchers, { away: 'Today Away', home: 'Today Home' });

    const rootWithoutPrior = mkdtempSync(join(tmpdir(), 'cpc-lineup-pending-'));
    try {
      const discovery = join(rootWithoutPrior, 'mlb', '2026-07-18', 'discovery');
      mkdirSync(discovery, { recursive: true });
      writeFileSync(join(discovery, 'stats_adapter.json'), JSON.stringify({ records: [{ game_pk: 104, away_team: 'New York Yankees', home_team: 'Boston Red Sox' }] }));
      writeFileSync(join(discovery, 'context_adapter.json'), JSON.stringify({ records: [{ game_pk: 104, away_team: 'New York Yankees', home_team: 'Boston Red Sox', lineup_status: 'lineup_pending' }] }));
      const [pending] = loadStatsRecords(rootWithoutPrior, '2026-07-18');
      assert.equal(pending.lineup_status, 'unconfirmed');
      assert.deepEqual(pending.hr_batters, []);
    } finally {
      rmSync(rootWithoutPrior, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture Kalshi success envelope', () => {
  const envelope = fixtureKalshiSuccessEnvelope({
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'kalshi');
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.required, true);
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].markets[0].market_lane, 'moneyline');
  assert.equal(envelope.errors.length, 0);
});

test('fixture Kalshi blocked/challenge envelope', () => {
  const envelope = fixtureKalshiBlockedEnvelope({
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'kalshi');
  assert.equal(envelope.status, 'degraded');
  assert.equal(envelope.records.length, 0);
  assert.match(envelope.warnings.join(' '), /blocked|challenge/i);
  assert.match(envelope.errors.join(' '), /429|challenge/i);
});

test('fixture MLB schedule envelope', () => {
  const envelope = fixtureMlbScheduleEnvelope({
    runDate: '2026-05-15',
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'mlb_official');
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].game_pk, 100001);
  assert.equal(envelope.records[0].away_team, 'Alpha City Aces');
  assert.equal(envelope.records[0].probable_pitchers.home, 'Placeholder Pitcher B');
});

test('fixture MLB stats envelope exposes composite-ready fields without prices', () => {
  const envelope = fixtureStatsEnvelope({
    runDate: '2026-05-15',
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'mlb_stats');
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].away_pitcher.kPct, 0.24);
  assert.equal(envelope.records[0].away_team_stats.ops, 0.735);
  assert.equal(envelope.records[0].away_team_woba, null);
  assert.doesNotMatch(JSON.stringify(envelope.records[0]), /yes_ask|bid|ask|price|volume|open_interest|odds/i);
});

test('fixture Baseball Savant envelope is optional and bounded to per-batter HR aggregates', () => {
  const envelope = fixtureBaseballSavantEnvelope({
    runDate: '2026-05-15',
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'baseball_savant');
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.required, false);
  assert.equal(envelope.optional_source, true);
  assert.equal(envelope.records.length, 2);
  assert.equal(envelope.records[0].query_type, 'statcast_hr_batter_aggregate');
  assert.equal(envelope.records[0].pa, 12);
  assert.equal(envelope.records[0].window_end_utc, '2026-05-14');
  assert.doesNotMatch(JSON.stringify(envelope.records[0]), /yes_ask|bid|ask|price|volume|open_interest|odds/i);
});

test('live Baseball Savant adapter uses a trailing yesterday-ending window and rejects today-only mode', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    const day = parsed.searchParams.get('game_date_lt');
    const dayText = day ? new Date(`${day}T00:00:00.000Z`) : new Date('2026-06-19T00:00:00.000Z');
    dayText.setUTCDate(dayText.getUTCDate() - 1);
    const queryDay = dayText.toISOString().slice(0, 10);
    if (!String(url).includes('game_date_lt=2026-06-20')) {
      return makeJsonResponse('game_date,player_name,batter,launch_speed,launch_angle,hit_distance_sc,events,barrel\n');
    }
    return makeJsonResponse(
      `game_date,player_name,batter,launch_speed,launch_angle,hit_distance_sc,events,barrel\n${queryDay},Ada Ace,11,101.2,27,405,home_run,1\n${queryDay},Ada Ace,11,98.4,22,390,single,0`,
    );
  };

  const envelope = await fetchBaseballSavantReadonly({
    runDate: '2026-06-20',
    outputDir: 'state/mlb/2026-06-20/discovery',
    fixturesOnly: false,
    fetchImpl,
    now: new Date('2026-06-20T14:00:00.000Z'),
    trailingDays: 3,
    maxBatters: 10,
  });

  assert.equal(envelope.status, 'ok');
  assert.ok(calls.length >= 1, 'expected at least one Statcast fetch');
  assert.ok(calls.every((url) => !url.includes('game_date_gt=2026-06-20')), 'today-pregame must not be queried');
  assert.ok(calls.some((url) => url.includes('game_date_lt=2026-06-20')), 'yesterday-ending window should include yesterday');
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].player_name, 'Ada Ace');
  assert.equal(envelope.records[0].hr_events, 1);
  assert.equal(envelope.records[0].pa, 2);
  assert.doesNotMatch(JSON.stringify(envelope.records[0]), /yes_ask|bid|ask|price|volume|open_interest|odds/i);

  const todayOnly = await fetchBaseballSavantReadonly({
    runDate: '2026-06-20',
    outputDir: 'state/mlb/2026-06-20/discovery',
    fixturesOnly: false,
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
    now: new Date('2026-06-20T14:00:00.000Z'),
    mode: 'today_only',
  });

  assert.equal(todayOnly.status, 'blocked');
  assert.match(JSON.stringify(todayOnly.errors), /STATCAST_TODAY_ONLY_REJECTED/);
});

test('live Baseball Savant adapter surfaces CSV error-column failures as optional-source blocks', async () => {
  const envelope = await fetchBaseballSavantReadonly({
    runDate: '2026-06-20',
    outputDir: 'state/mlb/2026-06-20/discovery',
    fixturesOnly: false,
    fetchImpl: async () => makeJsonResponse('game_date,player_name,error\n2026-06-19,Ada Ace,CSV_PARSE_ERROR'),
    now: new Date('2026-06-20T14:00:00.000Z'),
    trailingDays: 1,
  });

  assert.equal(envelope.status, 'blocked');
  assert.equal(envelope.required, false);
  assert.equal(envelope.optional_source, true);
  assert.match(JSON.stringify(envelope.errors), /CSV_ERROR_COLUMN_FAILURE/);
});

test('live MLB stats adapter normalizes pitcher/team/bullpen stats from no-auth sources', async () => {
  const fetchImpl = async url => {
    const value = typeof url === 'string' ? url : url.toString();
    if (value.includes('/schedule?')) {
      return makeJsonResponse({
        dates: [{
          games: [{
            gamePk: 200001,
            officialDate: '2026-05-15',
            gameDate: '2026-05-15T23:05:00Z',
            status: { detailedState: 'Scheduled' },
            teams: {
              away: {
                team: { id: 1, name: 'Alpha City Aces', abbreviation: 'ACA' },
                probablePitcher: { id: 11, fullName: 'Ada Ace' },
              },
              home: {
                team: { id: 2, name: 'Beta Town Bears', abbreviation: 'BTB' },
                probablePitcher: { id: 22, fullName: 'Byron Bear' },
              },
            },
            venue: { name: 'Source Park', timeZone: { id: 'America/New_York' } },
          }],
        }],
      });
    }
    if (value.includes('/standings?')) {
      return makeJsonResponse({
        records: [{
          teamRecords: [
            {
              team: { id: 1, name: 'Alpha City Aces' },
              wins: 12,
              losses: 8,
              gamesPlayed: 20,
              runDifferential: 25,
              runsScored: 102,
              runsAllowed: 77,
              records: { splitRecords: [{ type: 'lastTen', wins: 7, losses: 3 }] },
            },
            {
              team: { id: 2, name: 'Beta Town Bears' },
              wins: 9,
              losses: 11,
              gamesPlayed: 20,
              runDifferential: -14,
              runsScored: 80,
              runsAllowed: 94,
              records: { splitRecords: [{ type: 'lastTen', wins: 4, losses: 6 }] },
            },
          ],
        }],
      });
    }
    if (/\/people\/11$/.test(value)) return makeJsonResponse({ people: [{ fullName: 'Ada Ace', pitchHand: { code: 'R' } }] });
    if (/\/people\/22$/.test(value)) return makeJsonResponse({ people: [{ fullName: 'Byron Bear', pitchHand: { code: 'L' } }] });
    if (value.includes('/people/11/stats') && value.includes('seasonAdvanced')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { qualityStarts: 3, battersFaced: 50 } }] }] });
    }
    if (value.includes('/people/22/stats') && value.includes('seasonAdvanced')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { qualityStarts: 1, battersFaced: 60 } }] }] });
    }
    if (value.includes('/people/11/stats')) {
      return makeJsonResponse({
        stats: [{ splits: [{ stat: {
          era: '3.20',
          whip: '1.10',
          strikeOuts: 10,
          baseOnBalls: 3,
          battersFaced: 50,
          strikeoutsPer9Inn: '9.00',
          walksPer9Inn: '2.70',
          gamesStarted: 4,
          inningsPitched: '20.0',
        } }] }],
      });
    }
    if (value.includes('/people/22/stats')) {
      return makeJsonResponse({
        stats: [{ splits: [{ stat: {
          era: '4.50',
          whip: '1.35',
          strikeOuts: 12,
          baseOnBalls: 6,
          battersFaced: 60,
          strikeoutsPer9Inn: '8.10',
          walksPer9Inn: '4.05',
          gamesStarted: 4,
          inningsPitched: '18.0',
        } }] }],
      });
    }
    if (value.includes('/teams/1/stats') && value.includes('group=hitting') && value.includes('stats=season')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { gamesPlayed: 20, ops: '.760', avg: '.250', obp: '.330', slg: '.430' } }] }] });
    }
    if (value.includes('/teams/2/stats') && value.includes('group=hitting') && value.includes('stats=season')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { gamesPlayed: 20, ops: '.690', avg: '.230', obp: '.310', slg: '.380' } }] }] });
    }
    if (value.includes('/teams/1/stats') && value.includes('sitCodes=vl')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { ops: '.740' } }] }] });
    }
    if (value.includes('/teams/1/stats') && value.includes('sitCodes=vr')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { ops: '.770' } }] }] });
    }
    if (value.includes('/teams/2/stats') && value.includes('sitCodes=vl')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { ops: '.680' } }] }] });
    }
    if (value.includes('/teams/2/stats') && value.includes('sitCodes=vr')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { ops: '.700' } }] }] });
    }
    if (value.includes('/teams/1/stats') && value.includes('group=pitching')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { era: '3.60', whip: '1.20', inningsPitched: '80.0', gamesPitched: 20 } }] }] });
    }
    if (value.includes('/teams/2/stats') && value.includes('group=pitching')) {
      return makeJsonResponse({ stats: [{ splits: [{ stat: { era: '4.80', whip: '1.40', inningsPitched: '75.0', gamesPitched: 20 } }] }] });
    }
    return makeJsonResponse({}, 404);
  };

  const envelope = await fetchStatsReadonly({
    runDate: '2026-05-15',
    outputDir: 'state/mlb/2026-05-15/discovery',
    fixturesOnly: false,
    fetchImpl,
    now: new Date('2026-05-15T14:00:00.000Z'),
    mlbGames: [{
      game_pk: 200001,
      away_team: 'Alpha City Aces',
      home_team: 'Beta Town Bears',
    }],
  });

  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.records.length, 1);
  const record = envelope.records[0];
  assert.equal(record.game_pk, 200001);
  assert.equal(record.away_pitcher.k_pct, 0.2);
  assert.equal(record.away_pitcher.bb_pct, 0.06);
  assert.equal(record.away_team_stats.runDiff, 25);
  assert.equal(record.home_team_stats.last10, '4-6');
  assert.equal(record.away_bullpen.era, 3.6);
  assert.equal(record.away_lineup_handedness.vsRhpOps, 0.77);
  assert.equal(record.away_team_woba, null);
  assert.doesNotMatch(JSON.stringify(record), /yes_ask|bid|ask|price|volume|open_interest|odds/i);
});

test('dynamic composite builder uses stats_adapter and confirmed context without price inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-dynamic-composite-'));
  const runDate = '2026-05-15';
  const discoveryDir = join(dir, 'mlb', runDate, 'discovery');
  mkdirSync(discoveryDir, { recursive: true });

  try {
    writeFileSync(join(discoveryDir, 'mlb_official_adapter.json'), JSON.stringify({
      source_id: 'mlb_official',
      status: 'ok',
      records: [{
        game_pk: 200001,
        game_date: runDate,
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        probable_pitchers: { away_id: 11, home_id: 22, away: 'Ada Ace', home: 'Byron Bear' },
        venue: 'Source Park',
      }],
    }));
    writeFileSync(join(discoveryDir, 'stats_adapter.json'), JSON.stringify({
      source_id: 'mlb_stats',
      status: 'ok',
      records: [{
        game_pk: 200001,
        label: 'ACA@BTB',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        venue: 'Source Park',
        away_pitcher: { name: 'Ada Ace', mlb_id: 11, hand: 'R', era: 3.2, whip: 1.1, k_pct: 0.2, bb_pct: 0.06, games_started: 4, quality_starts: 3 },
        home_pitcher: { name: 'Byron Bear', mlb_id: 22, hand: 'L', era: 4.5, whip: 1.35, k_pct: 0.2, bb_pct: 0.1, games_started: 4, quality_starts: 1 },
        away_team_stats: { wins: 12, losses: 8, gamesPlayed: 20, runDiff: 25, ops: 0.76, last10: '7-3' },
        home_team_stats: { wins: 9, losses: 11, gamesPlayed: 20, runDiff: -14, ops: 0.69, last10: '4-6' },
        away_bullpen: { era: 3.6, recentLoadPct: null },
        home_bullpen: { era: 4.8, recentLoadPct: null },
        away_lineup_handedness: { vsRhpOps: 0.77, vsLhpOps: 0.74 },
        home_lineup_handedness: { vsRhpOps: 0.7, vsLhpOps: 0.68 },
      }],
    }));
    writeFileSync(join(discoveryDir, 'weather_adapter.json'), JSON.stringify({
      source_id: 'weather',
      status: 'ok',
      records: [{
        game_pk: 200001,
        venue: 'Source Park',
        temperature: 72,
        wind_speed: '8 mph',
        precipitation_risk: 10,
      }],
    }));
    writeFileSync(join(discoveryDir, 'context_adapter.json'), JSON.stringify({
      source_id: 'lineup_injury_bullpen',
      status: 'ok',
      records: [{
        game_pk: 200001,
        lineup_status: 'confirmed_or_boxscore_available',
      }],
    }));

    const slate = loadDynamicCompositeSlate({ date: runDate, stateRoot: dir });
    assert.equal(slate.inputs.length, 1);
    assert.equal(slate.watchGames.length, 0);
    assert.doesNotMatch(JSON.stringify(slate.inputs[0]), /yes_ask|bid|ask|price|volume|open_interest|odds/i);

    const result = runComposite(slate.inputs[0]);
    const categories = result.gameLedger.away.evidence_ledger
      .filter(row => row.present)
      .map(row => row.category);
    assert.ok(categories.includes('starting_pitcher_signal'));
    assert.ok(categories.includes('season_form'));
    assert.ok(categories.includes('lineup_handedness_matchup'));
    assert.ok(result.gameLedger.away.layers_present >= 6);

    const polluted = runComposite({
      ...slate.inputs[0],
      supportedMarketLanes: [
        { market_lane: 'moneyline', source_available: false },
        { market_lane: 'game_total', source_available: false },
        { market_lane: 'yrfi_nrfi', source_available: false },
      ],
      market_context: {
        yes_ask: 0.99,
        no_ask: 0.99,
        odds: '+10000',
        volume: 999999,
        open_interest: 999999,
      },
    });
    assert.deepEqual(polluted.board.top_pick, result.board.top_pick);
    assert.doesNotMatch(JSON.stringify(polluted), /yes_ask|no_ask|open_interest|volume|\+10000/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI defaults to fixtures-only and writes discovery summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-source-cli-'));
  const outDir = join(dir, 'discovery');

  try {
    const stdout = execFileSync(
      process.execPath,
      ['scripts/mlb/source-adapter-dry-run.mjs', '--date', '2026-05-15', '--source', 'all', '--out', outDir],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const result = JSON.parse(stdout);

    assert.equal(result.mode, 'fixtures-only');
    assert.equal(result.kalshi_status, 'ok');
    assert.equal(result.mlb_status, 'ok');
    assert.equal(existsSync(join(outDir, 'kalshi_adapter.json')), true);
    assert.equal(existsSync(join(outDir, 'mlb_official_adapter.json')), true);
    assert.equal(existsSync(join(outDir, 'discovery_summary.md')), true);

    const summary = readFileSync(join(outDir, 'discovery_summary.md'), 'utf8');
    assert.match(summary, /No picks made\./);
    assert.match(summary, /No trades placed\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live-readonly flag does not call trade execution endpoints', async () => {
  const urls = [];
  const fetchImpl = async url => {
    const value = typeof url === 'string' ? url : url.toString();
    urls.push(value);
    if (value.includes('/calendar/')) {
      return makeJsonResponse('challenge', 429);
    }
    return makeJsonResponse({ events: [], cursor: null }, 200);
  };

  const envelope = await fetchKalshiReadonly({
    outputDir: 'state/mlb/2026-05-15/discovery',
    fixturesOnly: false,
    fetchImpl,
    now: new Date('2026-05-15T14:00:00.000Z'),
  });

  assert.equal(envelope.source_id, 'kalshi');
  assert.equal(envelope.status, 'degraded');
  assert.equal(urls.length > 0, true);
  for (const url of urls) {
    const pathname = new URL(url).pathname;
    assert.doesNotMatch(pathname, /orders|portfolio|balance|positions|fills/i);
  }
});

test('Kalshi live-readonly filters false positives and keeps only official same-day game matches', async () => {
  const fetchImpl = async url => {
    const value = typeof url === 'string' ? url : url.toString();
    if (value.includes('/calendar/')) {
      return makeJsonResponse('challenge', 429);
    }
    return makeJsonResponse(
      {
        events: [
          {
            event_ticker: 'KXDEPP-PIRATES',
            series_ticker: 'KXENTERTAINMENT',
            title: 'Will Johnny Depp be cast in the next Pirates of the Caribbean?',
            category: 'Entertainment',
            markets: [{ ticker: 'KXDEPP-PIRATES-YES', title: 'Johnny Depp Pirates movie casting' }],
          },
          {
            event_ticker: 'KXMLBDEBUT-HOLLIDAY',
            series_ticker: 'KXMLBDEBUT',
            title: 'Ethan Holliday: Debut Date',
            category: 'Sports',
            markets: [
              {
                ticker: 'KXMLBDEBUT-HOLLIDAY-2026',
                title: 'Will Ethan Holliday play in a game for any team in the MLB before June 1?',
              },
            ],
          },
          {
            event_ticker: 'KXMLB-PHI-PIT',
            series_ticker: 'KXMLB',
            title: 'Philadelphia Phillies at Pittsburgh Pirates',
            category: 'Sports',
            markets: [
              {
                ticker: 'KXMLB-PHI-PIT-WINNER',
                title: 'Will the Philadelphia Phillies beat the Pittsburgh Pirates?',
              },
            ],
          },
          {
            event_ticker: 'SENATENY-28',
            series_ticker: 'SENATENY',
            title: 'New York Senate winner? (2028)',
            category: 'Elections',
            markets: [{ ticker: 'SENATENY-28-D', title: 'Will Democrats win the Senate race in New York?' }],
          },
          {
            event_ticker: 'KXRELOCATIONCHI-28',
            series_ticker: 'KXRELOCATIONCHI',
            title: 'Chicago Pro Football Team: Relocation',
            category: 'Sports',
            markets: [
              {
                ticker: 'KXRELOCATIONCHI-28-IL',
                title: 'Will the Chicago Pro Football Team relocate before the 2028 season?',
              },
            ],
          },
        ],
        cursor: null,
      },
      200,
    );
  };

  const envelope = await fetchKalshiReadonly({
    outputDir: 'state/mlb/2026-05-15/discovery',
    fixturesOnly: false,
    fetchImpl,
    now: new Date('2026-05-15T14:00:00.000Z'),
    officialMlbGames: [
      {
        game_pk: 823384,
        away_team: 'Philadelphia Phillies',
        home_team: 'Pittsburgh Pirates',
      },
    ],
  });

  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].event_ticker, 'KXMLB-PHI-PIT');
  assert.equal(envelope.records[0].matched_game_pk, 823384);
  assert.equal(envelope.records[0].markets[0].market_lane, 'moneyline');
  assert.equal(envelope.rejected_records.length, 2);
  assert.match(envelope.rejected_records.map(record => record.reason).join(' '), /entertainment|debut/i);
});

test('generated summary includes No picks made and No trades placed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-source-summary-'));
  const outDir = join(dir, 'discovery');

  try {
    execFileSync(
      process.execPath,
      [
        'scripts/mlb/source-adapter-dry-run.mjs',
        '--date',
        '2026-05-15',
        '--fixtures-only',
        '--source',
        'all',
        '--out',
        outDir,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    const summary = readFileSync(join(outDir, 'discovery_summary.md'), 'utf8');
    assert.match(summary, /This is discovery only\./);
    assert.match(summary, /No picks made\./);
    assert.match(summary, /No trades placed\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('single-source discover does not overwrite other adapter files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-single-source-'));
  const outDir = join(dir, 'discovery');

  try {
    execFileSync(
      process.execPath,
      [
        'scripts/mlb/source-adapter-dry-run.mjs',
        '--date',
        '2026-05-15',
        '--source',
        'kalshi',
        '--out',
        outDir,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    // kalshi was requested — its file should exist
    assert.equal(existsSync(join(outDir, 'kalshi_adapter.json')), true);
    // mlb was NOT requested and no pre-existing file — should not exist
    assert.equal(existsSync(join(outDir, 'mlb_official_adapter.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-game combos keep multi-lane groups and exclude single-lane clusters', () => {
  const combos = buildSameGameCombos([
    {
      event_ticker: 'KXTEST-ACESBET',
      game: 'Alpha City Aces at Beta Town Bears',
      market_ticker: 'KXTEST-ML-AWAY',
      market_lane: 'moneyline',
      classification: 'CLEAR_PICK',
      edge_pp: 4.2,
      kalshi_ask: 0.46,
    },
    {
      event_ticker: 'KXTEST-ACESBET',
      game: 'Alpha City Aces at Beta Town Bears',
      market_ticker: 'KXTEST-TOTAL-OVER',
      market_lane: 'game_total',
      classification: 'LEAN',
      edge_pp: 2.8,
      kalshi_ask: 0.58,
    },
    {
      event_ticker: 'KXTEST-ONLYTOTAL',
      game: 'Gamma City Gulls at Delta Bay Ducks',
      market_ticker: 'KXTEST-TOTAL-1',
      market_lane: 'game_total',
      classification: 'CLEAR_PICK',
      edge_pp: 5.1,
      kalshi_ask: 0.49,
    },
    {
      event_ticker: 'KXTEST-ACESBET',
      game: 'Alpha City Aces at Beta Town Bears',
      market_ticker: 'KXTEST-TOTAL-ALT',
      market_lane: 'game_total',
      classification: 'CORRELATED_ALTERNATE',
      edge_pp: 6.1,
      kalshi_ask: 0.51,
    },
  ]);

  assert.equal(combos.length, 1);
  assert.equal(combos[0].event_ticker, 'KXTEST-ACESBET');
  assert.equal(combos[0].combo_status, 'LEAN');
  assert.deepEqual(combos[0].lanes_present, ['moneyline', 'game_total']);
  assert.equal(combos[0].members.length, 2);
  assert.match(combos[0].display_markets, /moneyline: KXTEST-ML-AWAY/);
  assert.match(combos[0].display_markets, /game_total: KXTEST-TOTAL-OVER/);
});

test('combo status tracks the weakest actionable member', () => {
  assert.equal(
    comboStatusFromMembers([
      { classification: 'CLEAR_PICK' },
      { classification: 'WATCH_FOR_PRICE' },
    ]),
    'WATCH_FOR_PRICE',
  );
  assert.equal(
    comboStatusFromMembers([
      { classification: 'CLEAR_PICK' },
      { classification: 'LEAN' },
    ]),
    'LEAN',
  );
  assert.equal(
    comboStatusFromMembers([
      { classification: 'CLEAR_PICK' },
      { classification: 'PRE_LINEUP_PICK' },
    ]),
    'PRE_LINEUP_PICK',
  );
  assert.equal(
    comboStatusFromMembers([
      { classification: 'CLEAR_PICK' },
      { classification: 'CLEAR_PICK' },
    ]),
    'CLEAR_PICK',
  );
});

test('combo estimates multiply cost and market reference values', () => {
  const estimates = calculateComboEstimates(
    {
      leg_1_ask: 0.63,
      leg_1_market_ref: 0.7112,
      leg_2_ask: 0.57,
      leg_2_market_ref: 0.5983,
    },
  );

  assert.equal(estimates.estimatedComboCost, 0.3591);
  assert.equal(estimates.estimatedComboMarketRef, 0.4255);
  assert.equal(estimates.comboEdgePp, (0.4255 - 0.3591) * 100);
});

test('classifyCombo maps leg pairs to combo-specific classifications', () => {
  const leg = (classification, missing_confirmations = []) => ({ classification, missing_confirmations });

  // Rule 4: WATCH_FOR_PRICE leg => COMBO_WATCH
  assert.equal(classifyCombo(leg('WATCH_FOR_PRICE', ['stronger_edge']), leg('CLEAR_PICK')), 'COMBO_WATCH');
  assert.equal(classifyCombo(leg('CLEAR_PICK'), leg('WATCH_FOR_PRICE', ['injury_activation_pending'])), 'COMBO_WATCH');

  // Rule 5: PASS leg => COMBO_PASS
  assert.equal(classifyCombo(leg('PASS'), leg('CLEAR_PICK')), 'COMBO_PASS');
  assert.equal(classifyCombo(leg('CLEAR_PICK'), leg('PASS')), 'COMBO_PASS');

  // Rule 6: BLOCKED_SOURCE_GAP leg propagates
  assert.equal(classifyCombo(leg('BLOCKED_SOURCE_GAP'), leg('CLEAR_PICK')), 'BLOCKED_SOURCE_GAP');
  assert.equal(classifyCombo(leg('CLEAR_PICK'), leg('BLOCKED_SOURCE_GAP')), 'BLOCKED_SOURCE_GAP');

  // Rule 3: CLEAR_PICK + CLEAR_PICK, no missing => COMBO_CLEAR
  assert.equal(classifyCombo(leg('CLEAR_PICK'), leg('CLEAR_PICK')), 'COMBO_CLEAR');

  // Rule 3 + Rule 8: CLEAR_PICK + CLEAR_PICK, with missing => COMBO_WATCH (not COMBO_CLEAR)
  assert.equal(classifyCombo(leg('CLEAR_PICK', ['bullpen_unknown']), leg('CLEAR_PICK')), 'COMBO_WATCH');
  assert.equal(classifyCombo(leg('CLEAR_PICK'), leg('CLEAR_PICK', ['stronger_edge'])), 'COMBO_WATCH');

  // Rule 7: PRE_LINEUP_PICK + CLEAR_PICK, no missing => COMBO_LEAN
  assert.equal(classifyCombo(leg('PRE_LINEUP_PICK'), leg('CLEAR_PICK')), 'COMBO_LEAN');
  assert.equal(classifyCombo(leg('CLEAR_PICK'), leg('PRE_LINEUP_PICK')), 'COMBO_LEAN');

  // Rule 7: LEAN + CLEAR_PICK, no missing => COMBO_LEAN
  assert.equal(classifyCombo(leg('LEAN'), leg('CLEAR_PICK')), 'COMBO_LEAN');

  // Rule 7 + Rule 8: PRE_LINEUP_PICK + CLEAR_PICK, with missing => COMBO_WATCH
  assert.equal(classifyCombo(leg('PRE_LINEUP_PICK', ['injury_activation_pending']), leg('CLEAR_PICK')), 'COMBO_WATCH');
  assert.equal(classifyCombo(leg('PRE_LINEUP_PICK'), leg('CLEAR_PICK', ['bullpen_unknown'])), 'COMBO_WATCH');
});

test('no combo candidate uses a plain singles classification', () => {
  const PLAIN_SINGLES = new Set(['CLEAR_PICK', 'PRE_LINEUP_PICK', 'LEAN', 'WATCH_FOR_PRICE', 'PASS']);
  const ALLOWED_COMBO = new Set(['COMBO_CLEAR', 'COMBO_LEAN', 'COMBO_WATCH', 'COMBO_PASS', 'BLOCKED_SOURCE_GAP']);

  const legPairs = [
    ['CLEAR_PICK', 'CLEAR_PICK'],
    ['CLEAR_PICK', 'LEAN'],
    ['LEAN', 'CLEAR_PICK'],
    ['CLEAR_PICK', 'PRE_LINEUP_PICK'],
    ['PRE_LINEUP_PICK', 'PRE_LINEUP_PICK'],
    ['WATCH_FOR_PRICE', 'CLEAR_PICK'],
    ['CLEAR_PICK', 'WATCH_FOR_PRICE'],
    ['PASS', 'CLEAR_PICK'],
    ['CLEAR_PICK', 'PASS'],
    ['BLOCKED_SOURCE_GAP', 'CLEAR_PICK'],
    ['CLEAR_PICK', 'BLOCKED_SOURCE_GAP'],
    ['LEAN', 'LEAN'],
  ];

  for (const [cls1, cls2] of legPairs) {
    const result = classifyCombo({ classification: cls1, missing_confirmations: [] }, { classification: cls2, missing_confirmations: [] });
    assert.ok(
      ALLOWED_COMBO.has(result),
      `classifyCombo('${cls1}', '${cls2}') returned '${result}' which is a plain singles label`,
    );
    assert.ok(
      !PLAIN_SINGLES.has(result),
      `classifyCombo('${cls1}', '${cls2}') returned plain singles label '${result}'`,
    );
  }
});

test('scoring blocks CLEAR_PICK when fixture mode detected', async () => {
  const { scoreMarkets } = await import('../scripts/mlb/scoring-core.mjs');
  const { fixtureKalshiSuccessEnvelope } = await import('../scripts/mlb/source-adapters/kalshi-readonly.mjs');
  const { fixtureMlbScheduleEnvelope } = await import('../scripts/mlb/source-adapters/mlb-official-readonly.mjs');
  const { fixtureWeatherEnvelope } = await import('../scripts/mlb/source-adapters/weather-readonly.mjs');
  const { fixtureLiquidityEnvelope } = await import('../scripts/mlb/source-adapters/liquidity-readonly.mjs');

  const outputDir = 'state/mlb/2026-05-15/discovery';
  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const runDate = '2026-05-15';

  const kalshi = fixtureKalshiSuccessEnvelope({ checkedAtUtc, outputDir });
  const mlb = fixtureMlbScheduleEnvelope({ runDate, checkedAtUtc, outputDir });
  const weather = fixtureWeatherEnvelope({ runDate, checkedAtUtc, outputDir });
  const liquidity = fixtureLiquidityEnvelope({ checkedAtUtc, outputDir });
  const baseballSavant = {
    source_id: 'baseball_savant',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [{ query_type: 'fixture' }],
    warnings: ['Fixture mode: placeholder'],
    errors: [],
    source_urls: [],
  };

  const result = scoreMarkets({ kalshi, mlb, baseballSavant, weather, liquidity });

  assert.equal(result.fixture_mode, true);
  assert.equal(result.counts.clear_pick, 0);
  for (const candidate of result.candidates) {
    assert.notEqual(candidate.classification, 'CLEAR_PICK');
  }
});

test('Kalshi degraded and Baseball Savant blocked still allow MLB scoring to return a candidate', async () => {
  const { scoreMarkets } = await import('../scripts/mlb/scoring-core.mjs');
  const { fixtureKalshiSuccessEnvelope } = await import('../scripts/mlb/source-adapters/kalshi-readonly.mjs');

  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const outputDir = 'state/mlb/2026-05-15/discovery';
  const kalshiSeed = fixtureKalshiSuccessEnvelope({ checkedAtUtc, outputDir });
  const kalshi = {
    ...kalshiSeed,
    status: 'degraded',
    warnings: [],
    errors: ['HTTP 429'],
    records: kalshiSeed.records.map((record) => ({
      ...record,
      matched_game_pk: 100001,
      away_team: 'Alpha City Aces',
      home_team: 'Beta Town Bears',
      markets: record.markets.map((market) => ({
        ...market,
        yes_ask: 0.55,
        yes_bid: 0.45,
        market_title: 'Will the Alpha City Aces beat the Beta Town Bears?',
        contract_title: null,
        team_side: 'away',
      })),
    })),
  };
  const mlb = {
    source_id: 'mlb_official',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [{
      game_pk: 100001,
      away_team: 'Alpha City Aces',
      home_team: 'Beta Town Bears',
    }],
    warnings: [],
    errors: [],
    source_urls: [],
  };
  const baseballSavant = {
    source_id: 'baseball_savant',
    status: 'blocked',
    checked_at_utc: checkedAtUtc,
    records: [],
    warnings: ['OPTIONAL_SOURCE=UNAVAILABLE'],
    errors: ['OPTIONAL_SOURCE=UNAVAILABLE'],
    source_urls: [],
  };
  const weather = {
    source_id: 'weather',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [],
    warnings: [],
    errors: [],
    source_urls: [],
  };
  const liquidity = {
    source_id: 'liquidity',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [],
    warnings: [],
    errors: [],
    source_urls: [],
  };
  const sportsbook = {
    source_id: 'sportsbook',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [{
      away_team: 'Alpha City Aces',
      home_team: 'Beta Town Bears',
      away_no_vig_fair: 0.55,
      home_no_vig_fair: 0.45,
      over_under: 8.5,
    }],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const result = scoreMarkets({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook });

  assert.equal(result.fixture_mode, false);
  assert.equal(result.candidates.length, 1);
  assert.notEqual(result.candidates[0].classification, 'BLOCKED_SOURCE_GAP');
  assert.notEqual(result.candidates[0].classification, 'NO_CLEAR_PICK');
});

test('output writer reads optional liquidity adapter when present', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { composeMlbDailyOutputs } = await import('../scripts/mlb/output-writer-core.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'mlb-output-writer-'));
  const discoveryDir = join(dir, 'discovery');
  const outDir = join(dir, 'out');
  mkdirSync(discoveryDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const baseEnvelope = (sourceId) => ({
    source_id: sourceId,
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [],
    warnings: [],
    errors: [],
    source_urls: [],
  });

  writeFileSync(join(discoveryDir, 'kalshi_adapter.json'), JSON.stringify(baseEnvelope('kalshi')));
  writeFileSync(join(discoveryDir, 'mlb_official_adapter.json'), JSON.stringify(baseEnvelope('mlb_official')));
  writeFileSync(
    join(discoveryDir, 'liquidity_adapter.json'),
    JSON.stringify({
      source_id: 'liquidity',
      status: 'ok',
      checked_at_utc: checkedAtUtc,
      records: [{ market_ticker: 'TEST-MKT' }],
      warnings: [],
      errors: [],
      source_urls: [],
    }),
  );

  try {
    composeMlbDailyOutputs({
      runDate: '2026-05-15',
      discoveryDir,
      outDir,
      now: new Date(checkedAtUtc),
    });

    const registry = JSON.parse(readFileSync(join(outDir, 'source_registry.json'), 'utf8'));
    const sourceIds = registry.sources.map(s => s.source_id);
    assert.ok(sourceIds.includes('liquidity'), `Expected 'liquidity' in source_ids, got: ${sourceIds.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('moneyline edge board keeps best positive-edge rows across classifications', async () => {
  const { buildMoneylineEdgeBoard } = await import('../scripts/mlb/output-writer-core.mjs');

  const rows = buildMoneylineEdgeBoard([
    {
      event_ticker: 'EVT1',
      game: 'Alpha City Aces at Beta Town Bears',
      market_ticker: 'ML-A',
      contract_title: 'Alpha City Aces',
      market_lane: 'moneyline',
      classification: 'PASS',
      edge_pp: 0.8,
      kalshi_ask: 0.6,
      market_reference_prob: 0.608,
      missing_confirmations: ['lineup_pending'],
    },
    {
      event_ticker: 'EVT1',
      game: 'Alpha City Aces at Beta Town Bears',
      market_ticker: 'ML-A-NEG',
      contract_title: 'Beta Town Bears',
      market_lane: 'moneyline',
      classification: 'PASS',
      edge_pp: -0.4,
      kalshi_ask: 0.64,
      market_reference_prob: 0.6,
      missing_confirmations: ['lineup_pending'],
    },
    {
      event_ticker: 'EVT2',
      game: 'Gamma City Gulls at Delta Bay Ducks',
      market_ticker: 'ML-B',
      contract_title: 'Gamma City Gulls',
      market_lane: 'moneyline',
      classification: 'WATCH_FOR_PRICE',
      edge_pp: 1.1,
      kalshi_ask: 0.49,
      market_reference_prob: 0.501,
      target_entry: 0.48,
      missing_confirmations: ['stronger_edge'],
    },
    {
      event_ticker: 'EVT3',
      game: 'Epsilon City Eagles at Zeta Town Zebras',
      market_ticker: 'ML-C',
      contract_title: 'Epsilon City Eagles',
      market_lane: 'moneyline',
      classification: 'LEAN',
      edge_pp: 2.4,
      kalshi_ask: 0.44,
      market_reference_prob: 0.464,
      missing_confirmations: [],
    },
    {
      event_ticker: 'EVT4',
      game: 'Theta City Tides at Iota Bay Iguanas',
      market_ticker: 'RL-1',
      contract_title: 'Theta City Tides',
      market_lane: 'run_line',
      classification: 'WATCH_FOR_PRICE',
      edge_pp: 3.2,
      kalshi_ask: 0.41,
      market_reference_prob: 0.442,
      missing_confirmations: ['lineup_pending'],
    },
    {
      event_ticker: 'EVT5',
      game: 'Kappa City Kings at Lambda Bay Lizards',
      market_ticker: 'ML-ZERO',
      contract_title: 'Kappa City Kings',
      market_lane: 'moneyline',
      classification: 'PASS',
      edge_pp: 0,
      kalshi_ask: 0.55,
      market_reference_prob: 0.55,
      missing_confirmations: [],
    },
  ]);

  assert.deepEqual(rows.map(row => row.market_ticker), ['ML-C', 'ML-B', 'ML-A']);
  assert.equal(rows[0].classification, 'LEAN');
  assert.equal(rows[1].classification, 'WATCH_FOR_PRICE');
  assert.equal(rows[2].classification, 'PASS');
  assert.match(rows[1].why_not, /stronger_edge/);
  assert.ok(rows.every(row => row.edge_pp > 0));
  assert.ok(!rows.some(row => row.market_ticker === 'ML-A-NEG'));
  assert.ok(!rows.some(row => row.market_ticker === 'RL-1'));
  assert.ok(!rows.some(row => row.market_ticker === 'ML-ZERO'));
});

test('output writer surfaces same-game combo visibility in json and markdown', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { composeMlbDailyOutputs } = await import('../scripts/mlb/output-writer-core.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'mlb-same-game-combos-'));
  const discoveryDir = join(dir, 'discovery');
  const outDir = join(dir, 'out');
  mkdirSync(discoveryDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const runDate = '2026-05-15';

  const kalshiEnvelope = {
    source_id: 'kalshi',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'kalshi_fixture',
    cache_path: join(discoveryDir, 'kalshi_adapter.json'),
    required: true,
    records: [
      {
        event_ticker: 'KXTEST-ACESBET',
        event_title: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        matched_game_pk: 100001,
        markets: [
          {
            market_ticker: 'KXTEST-ML-AWAY',
            market_title: 'Will the Alpha City Aces beat the Beta Town Bears?',
            contract_title: 'Alpha City Aces',
            market_lane: 'moneyline',
            candidate_lanes: ['moneyline'],
            yes_ask: 0.44,
            team_name: 'Alpha City Aces',
            team_code: 'ACES',
          },
          {
            market_ticker: 'KXTEST-TOTAL-OVER',
            market_title: 'Alpha City Aces vs Beta Town Bears total runs',
            contract_title: 'Over 8.5 runs scored',
            market_lane: 'game_total',
            candidate_lanes: ['game_total'],
            yes_ask: 0.28,
            total_strike: 8.5,
          },
        ],
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const mlbEnvelope = {
    source_id: 'mlb_official',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'mlb_fixture',
    cache_path: join(discoveryDir, 'mlb_official_adapter.json'),
    required: true,
    records: [
      {
        game_pk: 100001,
        game_date: runDate,
        start_time_utc: `${runDate}T23:05:00Z`,
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        mlb_status: 'Scheduled',
        probable_pitchers: {
          away: 'Starter A',
          home: 'Starter B',
        },
        venue: 'Placeholder Park',
        venue_timezone: 'America/New_York',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const sportsbookEnvelope = {
    source_id: 'sportsbook_reference',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'sportsbook_fixture',
    cache_path: join(discoveryDir, 'sportsbook_adapter.json'),
    required: false,
    records: [
      {
        query_type: 'sportsbook_no_vig_reference',
        game: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        away_no_vig_fair: 0.63,
        home_no_vig_fair: 0.37,
        over_under: 8.5,
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const weatherEnvelope = {
    source_id: 'weather',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'weather_fixture',
    cache_path: join(discoveryDir, 'weather_adapter.json'),
    required: true,
    records: [
      {
        query_type: 'game_weather_environment',
        game_pk: 100001,
        game_date: runDate,
        game: 'Alpha City Aces at Beta Town Bears',
        venue: 'Placeholder Park',
        checked_at_utc: checkedAtUtc,
        precipitation_risk: 0.1,
        roof_status: 'open_air',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const contextEnvelope = {
    source_id: 'lineup_injury_bullpen',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'context_fixture',
    cache_path: join(discoveryDir, 'context_adapter.json'),
    required: false,
    records: [
      {
        query_type: 'lineup_injury_bullpen_context',
        game_pk: 100001,
        game_date: runDate,
        game: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        lineup_status: 'confirmed_or_boxscore_available',
        venue_roof_type: 'open_air',
        key_injuries: [],
        bullpen_usage_note: 'Bullpen usage normal.',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  try {
    writeFileSync(join(discoveryDir, 'kalshi_adapter.json'), `${JSON.stringify(kalshiEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'mlb_official_adapter.json'), `${JSON.stringify(mlbEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'sportsbook_adapter.json'), `${JSON.stringify(sportsbookEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'weather_adapter.json'), `${JSON.stringify(weatherEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'context_adapter.json'), `${JSON.stringify(contextEnvelope, null, 2)}\n`);

    composeMlbDailyOutputs({
      runDate,
      discoveryDir,
      outDir,
      now: new Date(checkedAtUtc),
    });

    const board = JSON.parse(readFileSync(join(outDir, 'today-execution-board.json'), 'utf8'));
    assert.equal(board.same_game_combos.length, 1);
    assert.equal(board.same_game_combos[0].event_ticker, 'KXTEST-ACESBET');
    assert.deepEqual(board.same_game_combos[0].lanes_present, ['moneyline', 'game_total']);
    assert.deepEqual(board.same_game_combos[0].surfaced_lanes, ['moneyline', 'game_total']);
    assert.match(board.same_game_combos[0].display_markets, /moneyline: KXTEST-ML-AWAY/);
    assert.match(board.same_game_combos[0].display_markets, /game_total: KXTEST-TOTAL-OVER/);
    assert.deepEqual(board.actionable_counts_by_market_lane, [
      { market_lane: 'moneyline', actionable_candidate_count: 1 },
      { market_lane: 'run_line', actionable_candidate_count: 0 },
      { market_lane: 'game_total', actionable_candidate_count: 1 },
      { market_lane: 'yrfi_nrfi', actionable_candidate_count: 0 },
      { market_lane: 'home_run_hitter', actionable_candidate_count: 0 },
      { market_lane: 'pitcher_strikeouts', actionable_candidate_count: 0 },
    ]);
    assert.equal(board.moneyline_candidate_count, 1);
    assert.equal(board.game_total_candidate_count, 1);
    assert.equal(board.unknown_other_candidate_count, 0);
    assert.equal(board.moneyline_edge_board_count, 1);
    assert.equal(board.moneyline_edge_board.length, 1);
    assert.equal(board.market_lane_diagnostics.lane_counts[0].actionable_candidates, 1);
    assert.equal(board.market_lane_diagnostics.lane_counts[2].actionable_candidates, 1);
    assert.equal(board.combo_candidates.length, 1);
    assert.equal(board.combo_candidates[0].leg_1_market_lane, 'moneyline');
    assert.equal(board.combo_candidates[0].leg_2_market_lane, 'game_total');
    assert.match(board.combo_candidates[0].display_markets, /moneyline: KXTEST-ML-AWAY/);
    assert.match(board.combo_candidates[0].display_markets, /game_total: KXTEST-TOTAL-OVER/);
    // Combo candidates must never carry plain singles classifications
    const PLAIN_SINGLES_LABELS = new Set(['CLEAR_PICK', 'PRE_LINEUP_PICK', 'LEAN', 'WATCH_FOR_PRICE', 'PASS']);
    for (const combo of board.combo_candidates) {
      assert.ok(
        !PLAIN_SINGLES_LABELS.has(combo.classification),
        `combo classification '${combo.classification}' is a plain singles label`,
      );
    }
    assert.ok(Object.hasOwn(board.combo_candidates[0], 'leg_1_classification'), 'leg_1_classification missing');
    assert.ok(Object.hasOwn(board.combo_candidates[0], 'leg_2_classification'), 'leg_2_classification missing');

    const guide = readFileSync(join(outDir, 'daily-baseball-guide.md'), 'utf8');
    const boardMd = readFileSync(join(outDir, 'today-execution-board.md'), 'utf8');
    assert.match(boardMd, /Moneyline Edge Board/);
    assert.match(boardMd, /\| market_ticker \| game \| Side \| Status \| Ask \| Mkt Ref \| Edge \| Target \| Why not \|/);
    assert.match(boardMd, /Alpha City Aces at Beta Town Bears/);
    assert.match(boardMd, /Why mostly totals\?/i);
    assert.match(guide, /Same-Game Combo Visibility/);
    assert.match(guide, /Actionable Counts by Market Lane/);
    assert.match(guide, /Why mostly totals\?/i);
    assert.match(guide, /Moneyline candidates: 1/);
    assert.match(guide, /Game total candidates: 1/);
    assert.match(guide, /Unknown\/other candidates: 0/);
    assert.match(boardMd, /Unknown\/other candidates: 0/);
    assert.match(guide, /Alpha City Aces at Beta Town Bears/);
    assert.match(guide, /Informational only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-game visibility keeps PASS legs in the exposure group without emitting a combo row', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { composeMlbDailyOutputs } = await import('../scripts/mlb/output-writer-core.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'mlb-same-game-pass-'));
  const discoveryDir = join(dir, 'discovery');
  const outDir = join(dir, 'out');
  mkdirSync(discoveryDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const runDate = '2026-05-15';

  const kalshiEnvelope = {
    source_id: 'kalshi',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'kalshi_fixture',
    cache_path: join(discoveryDir, 'kalshi_adapter.json'),
    required: true,
    records: [
      {
        event_ticker: 'KXTEST-MIXED',
        event_title: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        matched_game_pk: 100001,
        markets: [
          {
            market_ticker: 'KXTEST-ML-AWAY',
            market_title: 'Will the Alpha City Aces beat the Beta Town Bears?',
            contract_title: 'Alpha City Aces',
            market_lane: 'moneyline',
            candidate_lanes: ['moneyline'],
            yes_ask: 0.68,
            team_name: 'Alpha City Aces',
            team_code: 'ACES',
          },
          {
            market_ticker: 'KXTEST-ML-HOME',
            market_title: 'Will the Beta Town Bears beat the Alpha City Aces?',
            contract_title: 'Beta Town Bears',
            market_lane: 'moneyline',
            candidate_lanes: ['moneyline'],
            yes_ask: 0.45,
            team_name: 'Beta Town Bears',
            team_code: 'BEARS',
          },
          {
            market_ticker: 'KXTEST-TOTAL-OVER',
            market_title: 'Alpha City Aces vs Beta Town Bears total runs',
            contract_title: 'Over 7.5 runs scored',
            market_lane: 'game_total',
            candidate_lanes: ['game_total'],
            yes_ask: 0.4,
            total_strike: 7.5,
          },
        ],
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const mlbEnvelope = {
    source_id: 'mlb_official',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'mlb_fixture',
    cache_path: join(discoveryDir, 'mlb_official_adapter.json'),
    required: true,
    records: [
      {
        game_pk: 100001,
        game_date: runDate,
        start_time_utc: `${runDate}T23:05:00Z`,
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        mlb_status: 'Scheduled',
        probable_pitchers: {
          away: 'Starter A',
          home: 'Starter B',
        },
        venue: 'Placeholder Park',
        venue_timezone: 'America/New_York',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const sportsbookEnvelope = {
    source_id: 'sportsbook_reference',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'sportsbook_fixture',
    cache_path: join(discoveryDir, 'sportsbook_adapter.json'),
    required: false,
    records: [
      {
        query_type: 'sportsbook_no_vig_reference',
        game: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        away_no_vig_fair: 0.63,
        home_no_vig_fair: 0.37,
        over_under: 8.5,
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const weatherEnvelope = {
    source_id: 'weather',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'weather_fixture',
    cache_path: join(discoveryDir, 'weather_adapter.json'),
    required: true,
    records: [
      {
        query_type: 'game_weather_environment',
        game_pk: 100001,
        game_date: runDate,
        game: 'Alpha City Aces at Beta Town Bears',
        venue: 'Placeholder Park',
        checked_at_utc: checkedAtUtc,
        precipitation_risk: 0.1,
        roof_status: 'open_air',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const contextEnvelope = {
    source_id: 'lineup_injury_bullpen',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'context_fixture',
    cache_path: join(discoveryDir, 'context_adapter.json'),
    required: false,
    records: [
      {
        query_type: 'lineup_injury_bullpen_context',
        game_pk: 100001,
        game_date: runDate,
        game: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        lineup_status: 'confirmed_or_boxscore_available',
        venue_roof_type: 'open_air',
        key_injuries: [],
        bullpen_usage_note: 'Bullpen usage normal.',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  try {
    writeFileSync(join(discoveryDir, 'kalshi_adapter.json'), `${JSON.stringify(kalshiEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'mlb_official_adapter.json'), `${JSON.stringify(mlbEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'sportsbook_adapter.json'), `${JSON.stringify(sportsbookEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'weather_adapter.json'), `${JSON.stringify(weatherEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'context_adapter.json'), `${JSON.stringify(contextEnvelope, null, 2)}\n`);

    composeMlbDailyOutputs({
      runDate,
      discoveryDir,
      outDir,
      now: new Date(checkedAtUtc),
    });

    const board = JSON.parse(readFileSync(join(outDir, 'today-execution-board.json'), 'utf8'));
    assert.equal(board.same_game_combos.length, 1);
    assert.ok(Object.hasOwn(board.same_game_combos[0], 'combo_edge_pp'));
    assert.equal(board.same_game_combos[0].market_count, 3);
    assert.equal(board.same_game_combos[0].visible_market_count, 1);
    assert.deepEqual(board.same_game_combos[0].lanes_present, ['game_total']);
    assert.deepEqual(board.same_game_combos[0].surfaced_lanes, ['moneyline', 'game_total']);
    assert.match(board.same_game_combos[0].display_markets, /PASS/);
    assert.equal(board.combo_candidates.length, 0);
    assert.equal(board.market_lane_diagnostics.combo_summary.combo_candidates, 0);
    assert.equal(board.market_lane_diagnostics.combo_summary.moneyline_visible_combo_groups, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASS moneylines do not emit combo candidates', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { composeMlbDailyOutputs } = await import('../scripts/mlb/output-writer-core.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'mlb-combo-pair-'));
  const discoveryDir = join(dir, 'discovery');
  const outDir = join(dir, 'out');
  mkdirSync(discoveryDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const runDate = '2026-05-15';

  const kalshiEnvelope = {
    source_id: 'kalshi',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'kalshi_fixture',
    cache_path: join(discoveryDir, 'kalshi_adapter.json'),
    required: true,
    records: [
      {
        event_ticker: 'KXTEST-PAIR',
        event_title: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        matched_game_pk: 100001,
        markets: [
          {
            market_ticker: 'KXTEST-ML-AWAY',
            market_title: 'Will the Alpha City Aces beat the Beta Town Bears?',
            contract_title: 'Alpha City Aces',
            market_lane: 'moneyline',
            candidate_lanes: ['moneyline'],
            yes_ask: 0.44,
            team_name: 'Alpha City Aces',
            team_code: 'ACES',
          },
          {
            market_ticker: 'KXTEST-ML-HOME-PASS',
            market_title: 'Will the Beta Town Bears beat the Alpha City Aces?',
            contract_title: 'Beta Town Bears',
            market_lane: 'moneyline',
            candidate_lanes: ['moneyline'],
            yes_ask: 0.76,
            team_name: 'Beta Town Bears',
            team_code: 'BEARS',
          },
          {
            market_ticker: 'KXTEST-TOTAL-OVER-A',
            market_title: 'Alpha City Aces vs Beta Town Bears total runs',
            contract_title: 'Over 7.5 runs scored',
            market_lane: 'game_total',
            candidate_lanes: ['game_total'],
            yes_ask: 0.15,
            total_strike: 7.5,
          },
          {
            market_ticker: 'KXTEST-TOTAL-OVER-B',
            market_title: 'Alpha City Aces vs Beta Town Bears total runs alt',
            contract_title: 'Over 8.5 runs scored',
            market_lane: 'game_total',
            candidate_lanes: ['game_total'],
            yes_ask: 0.1,
            total_strike: 8.5,
          },
        ],
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const mlbEnvelope = {
    source_id: 'mlb_official',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'mlb_fixture',
    cache_path: join(discoveryDir, 'mlb_official_adapter.json'),
    required: true,
    records: [
      {
        game_pk: 100001,
        game_date: runDate,
        start_time_utc: `${runDate}T23:05:00Z`,
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        mlb_status: 'Scheduled',
        probable_pitchers: {
          away: 'Starter A',
          home: 'Starter B',
        },
        venue: 'Placeholder Park',
        venue_timezone: 'America/New_York',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const sportsbookEnvelope = {
    source_id: 'sportsbook_reference',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'sportsbook_fixture',
    cache_path: join(discoveryDir, 'sportsbook_adapter.json'),
    required: false,
    records: [
      {
        query_type: 'sportsbook_no_vig_reference',
        game: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        away_no_vig_fair: 0.63,
        home_no_vig_fair: 0.37,
        over_under: 8.5,
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const weatherEnvelope = {
    source_id: 'weather',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'weather_fixture',
    cache_path: join(discoveryDir, 'weather_adapter.json'),
    required: true,
    records: [
      {
        query_type: 'game_weather_environment',
        game_pk: 100001,
        game_date: runDate,
        game: 'Alpha City Aces at Beta Town Bears',
        venue: 'Placeholder Park',
        checked_at_utc: checkedAtUtc,
        precipitation_risk: 0.1,
        roof_status: 'open_air',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  const contextEnvelope = {
    source_id: 'lineup_injury_bullpen',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    cache_key: 'context_fixture',
    cache_path: join(discoveryDir, 'context_adapter.json'),
    required: false,
    records: [
      {
        query_type: 'lineup_injury_bullpen_context',
        game_pk: 100001,
        game_date: runDate,
        game: 'Alpha City Aces at Beta Town Bears',
        away_team: 'Alpha City Aces',
        home_team: 'Beta Town Bears',
        lineup_status: 'confirmed_or_boxscore_available',
        venue_roof_type: 'open_air',
        key_injuries: [],
        bullpen_usage_note: 'Bullpen usage normal.',
      },
    ],
    warnings: [],
    errors: [],
    source_urls: [],
  };

  try {
    writeFileSync(join(discoveryDir, 'kalshi_adapter.json'), `${JSON.stringify(kalshiEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'mlb_official_adapter.json'), `${JSON.stringify(mlbEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'sportsbook_adapter.json'), `${JSON.stringify(sportsbookEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'weather_adapter.json'), `${JSON.stringify(weatherEnvelope, null, 2)}\n`);
    writeFileSync(join(discoveryDir, 'context_adapter.json'), `${JSON.stringify(contextEnvelope, null, 2)}\n`);

    composeMlbDailyOutputs({
      runDate,
      discoveryDir,
      outDir,
      now: new Date(checkedAtUtc),
    });

    const board = JSON.parse(readFileSync(join(outDir, 'today-execution-board.json'), 'utf8'));
    assert.equal(board.same_game_combos.length, 1);
    assert.ok(Object.hasOwn(board.same_game_combos[0], 'combo_edge_pp'));
    assert.equal(board.combo_candidates.length, 1);
    assert.equal(board.combo_candidates[0].combo_member_count, 2);
    assert.ok(Object.hasOwn(board.combo_candidates[0], 'leg_1_market_lane'));
    assert.ok(Object.hasOwn(board.combo_candidates[0], 'leg_1_strike'));
    assert.ok(Object.hasOwn(board.combo_candidates[0], 'leg_2_market_lane'));
    assert.equal(board.combo_candidates[0].note, 'No trades placed');
    assert.equal(board.combo_candidates[0].leg_1_market_lane, 'moneyline');
    assert.equal(board.combo_candidates[0].leg_1_market_ticker, 'KXTEST-ML-AWAY');
    assert.equal(board.combo_candidates[0].leg_2_market_lane, 'game_total');
    assert.equal(
      board.combo_candidates[0].estimated_combo_cost,
      Math.round((board.combo_candidates[0].leg_1_ask * board.combo_candidates[0].leg_2_ask) * 10000) / 10000,
    );
    assert.equal(
      board.combo_candidates[0].estimated_combo_market_ref,
      Math.round((board.combo_candidates[0].leg_1_market_ref * board.combo_candidates[0].leg_2_market_ref) * 10000) / 10000,
    );
    assert.match(board.combo_candidates[0].display_markets, /KXTEST-ML-AWAY/);
    assert.match(board.combo_candidates[0].display_markets, /KXTEST-TOTAL-OVER-[AB]/);
    assert.doesNotMatch(board.combo_candidates[0].display_markets, /KXTEST-ML-HOME-PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live MLB context adapter surfaces batting orders when the live boxscore has them and leaves them empty otherwise', async () => {
  const fetchImpl = async url => {
    const value = typeof url === 'string' ? url : url.toString();
    if (value.includes('/game/300001/feed/live')) {
      return makeJsonResponse({
        gameData: {
          probablePitchers: {
            away: { fullName: 'Ada Ace' },
            home: { fullName: 'Byron Bear' },
          },
          weather: { condition: 'Clear', temp: '71' },
          venue: { fieldInfo: { roofType: 'Open' } },
        },
        liveData: {
          boxscore: {
            teams: {
              away: {
                batters: Array.from({ length: 9 }, (_, i) => ({ id: i + 1 })),
                battingOrder: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
              },
              home: {
                batters: Array.from({ length: 9 }, (_, i) => ({ id: i + 11 })),
                battingOrder: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
              },
            },
          },
        },
      });
    }
    if (value.includes('/game/300002/feed/live')) {
      return makeJsonResponse({
        gameData: {
          probablePitchers: {
            away: { fullName: 'Cora Cutter' },
            home: { fullName: 'Dex Darter' },
          },
          weather: { condition: 'Cloudy', temp: '69' },
          venue: { fieldInfo: { roofType: 'Open' } },
        },
        liveData: {
          boxscore: {
            teams: {
              away: {
                batters: [],
              },
              home: {
                batters: [],
              },
            },
          },
        },
      });
    }
    return makeJsonResponse({}, 404);
  };

  const envelope = await fetchContextReadonly({
    outputDir: 'state/mlb/2026-05-15/discovery',
    fixturesOnly: false,
    fetchImpl,
    now: new Date('2026-05-15T14:00:00.000Z'),
    mlbGames: [
      { game_pk: 300001, away_team: 'Alpha City Aces', home_team: 'Beta Town Bears' },
      { game_pk: 300002, away_team: 'Gamma City Gulls', home_team: 'Delta Town Ducks' },
    ],
  });

  assert.equal(envelope.records.length, 2);
  const withOrders = envelope.records.find(record => record.game_pk === 300001);
  const withoutOrders = envelope.records.find(record => record.game_pk === 300002);
  assert.equal(withOrders.away_batting_order.length, 9);
  assert.equal(withOrders.home_batting_order.length, 9);
  assert.deepEqual(withOrders.away_batting_order, ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.deepEqual(withOrders.home_batting_order, ['10', '11', '12', '13', '14', '15', '16', '17', '18']);
  assert.deepEqual(withoutOrders.away_batting_order, []);
  assert.deepEqual(withoutOrders.home_batting_order, []);
});
