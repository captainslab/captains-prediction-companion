import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolvePacketScope,
  buildInputStatusNote,
  buildKalshiGamePacket,
} from '../scripts/packets/generate-mlb-daily.mjs';

test('resolvePacketScope derives and honors explicit scope', () => {
  assert.equal(resolvePacketScope({}), 'FULL_DAY_PREVIEW');
  assert.equal(resolvePacketScope({ hasScoring: true }), 'SLATE_PREVIEW');
  assert.equal(resolvePacketScope({ perGame: true }), 'GAME_PACKET');
  assert.equal(resolvePacketScope({ explicit: 'game_packet', hasScoring: false, perGame: false }), 'GAME_PACKET');
});

test('full-day note differs from the game note', () => {
  const fullDay = buildInputStatusNote({ scope: 'FULL_DAY_PREVIEW' });
  const game = buildInputStatusNote({
    scope: 'GAME_PACKET',
    lineupInput: 'LOCKED',
    starterInput: 'PROJECTED',
    weatherInput: 'LOCKED',
  });

  assert.notEqual(fullDay, game);
  assert.match(fullDay, /projected lineups/);
  assert.match(game, /Lineup LOCKED/);
  assert.match(game, /Starter PROBABLE/);
  assert.match(game, /Weather UPDATED/);
});

test('market data alone cannot surface as a PICK when the model layer is blocked', () => {
  const packet = buildKalshiGamePacket({
    date: '2026-06-20',
    event: {
      event_ticker: 'KXMLBGAME-20260620-NYYBOS',
      title: 'New York Yankees at Boston Red Sox',
      sub_title: null,
      series_ticker: 'KXMLBGAME',
      markets: [],
    },
    artifacts: [],
    primeAttempts: [],
    kalshiSummary: { ok: true, total: 0, matched: 0, error: null },
    sourcePath: '/tmp/mlb/game.json',
    gamePicks: [],
    statsRecord: null,
    leagueRPG: null,
    scope: 'GAME_PACKET',
  });

  assert.match(packet.text, /BLOCKED_MODEL_LAYER_MISSING/);
  assert.doesNotMatch(packet.text, /\[\s*PICK\s*\]/);
});

test('game packets block ranked rows when MLB model score is missing', () => {
  const packet = buildKalshiGamePacket({
    date: '2026-06-20',
    event: {
      event_ticker: 'KXMLBGAME-20260620-NYYBOS',
      title: 'New York Yankees at Boston Red Sox',
      sub_title: null,
      series_ticker: 'KXMLBGAME',
      markets: [],
    },
    artifacts: [],
    primeAttempts: [],
    kalshiSummary: { ok: true, total: 0, matched: 0, error: null },
    sourcePath: '/tmp/mlb/game.json',
    gamePicks: [{
      market_ticker: 'KXMLB-TEST',
      game: 'New York Yankees at Boston Red Sox',
      contract_title: 'Yankees Win',
      classification: 'LEAN',
      fair_value: null,
      kalshi_ask: 0.48,
      kalshi_bid: 0.46,
      edge_pp: 5.0,
      gates_passed: ['starters', 'lineups', 'weather'],
      missing_confirmations: ['model_fair_missing'],
      market_lane: 'moneyline',
    }],
    statsRecord: null,
    leagueRPG: null,
    scope: 'GAME_PACKET',
  });

  assert.match(packet.text, /NO CLEAR PICK/);
  assert.match(packet.text, /BLOCKED_MODEL_LAYER_MISSING/);
  assert.doesNotMatch(packet.text, /BLOCKED \/ NEEDS SOURCE/);
  assert.doesNotMatch(packet.text, /score=MISSING/);
});

test('game packets ignore stale article-report format and stay on the clean wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'cpc-mlb-article-'));
  try {
    const articleDir = join(root, 'mlb', '2026-06-20', 'article-reports');
    mkdirSync(articleDir, { recursive: true });
    writeFileSync(
      join(articleDir, 'game-20260620-NYYBOS.txt'),
      [
        'New York Yankees at Boston Red Sox — EVIDENCE LEAN NYY',
        '=======================================================',
        '',
        'TLDR',
        '  Call: EVIDENCE LEAN — NYY moneyline.',
        '  Side / market: NYY ML',
        '  Why: market signal and required MLB evidence point the same way.',
        '',
        'Game Model Results',
        '  Home composite score: 48',
        '  Away composite score: 52',
        '  Coverage: Modeled families: ML/game-side, Spread, Total, YRFI/NRFI.',
        '',
        'Source Ledger',
        '  MLB_OFFICIAL: BACKED via starters/lineup provenance.',
        '  STATS_ADAPTER: BACKED via recent_form/bullpen/matchup provenance.',
        '  WEATHER_ADAPTER: BACKED via weather provenance.',
        '  CONTEXT_ADAPTER: BACKED via lineup/injury provenance.',
        '  MODEL_OUTPUT: BACKED via projection outputs.',
        '  AUDIT_ARTIFACTS_AVAILABLE: yes (customer text omits local paths; artifacts stay in inventory/meta/audit files).',
        '',
        'Final Call',
        '  EVIDENCE LEAN on NYY moneyline',
      ].join('\n'),
    );

    const packet = buildKalshiGamePacket({
      date: '2026-06-20',
      stateRoot: root,
      event: {
        event_ticker: 'KXMLBGAME-20260620-NYYBOS',
        title: 'New York Yankees at Boston Red Sox',
        sub_title: null,
        series_ticker: 'KXMLBGAME',
        markets: [],
      },
      artifacts: [],
      primeAttempts: [],
      kalshiSummary: { ok: true, total: 0, matched: 0, error: null },
      sourcePath: '/tmp/mlb/game.json',
      gamePicks: [{
        market_ticker: 'KXMLB-TEST',
        game: 'New York Yankees at Boston Red Sox',
        contract_title: 'Yankees',
        classification: 'LEAN',
        fair_value: 0.6,
        kalshi_ask: 0.5,
        kalshi_bid: 0.48,
        edge_pp: 5.0,
        gates_passed: ['starters', 'lineups', 'weather'],
        missing_confirmations: [],
        market_lane: 'moneyline',
      }],
      statsRecord: null,
      leagueRPG: null,
      scope: 'GAME_PACKET',
    });

    const lines = packet.text.split(/\r?\n/);
    assert.match(lines[0], /Captain's MLB Prediction Companion/);
    assert.match(lines[1], /Captain MLB — NYY @ BOS Game Board/);
    assert.match(lines[2], /New York Yankees at Boston Red Sox/);
    assert.match(lines.slice(0, 5).join('\n'), /CPC Packet: Game Board/);
    assert.match(lines.slice(0, 5).join('\n'), /generated_utc:/);
    assert.match(packet.text, /TLDR/);
    assert.match(packet.text, /Research Status/);
    assert.match(packet.text, /Event Preview \/ Storyline/);
    assert.match(packet.text, /Game Model Results/);
    assert.match(packet.text, /Source Ledger/);
    assert.match(packet.text, /MLB_OFFICIAL:/);
    assert.match(packet.text, /STATS_ADAPTER:/);
    assert.match(packet.text, /WEATHER_ADAPTER:/);
    assert.match(packet.text, /CONTEXT_ADAPTER:/);
    assert.match(packet.text, /MODEL_OUTPUT:/);
    assert.match(packet.text, /AUDIT_ARTIFACTS_AVAILABLE:/);
    assert.match(packet.text, /NOT IN SCORE/);
    assert.equal((packet.text.match(/No trades placed by this workflow\./g) || []).length, 1);
    assert.equal((packet.text.match(/No bankroll advice\./g) || []).length, 1);
    assert.doesNotMatch(packet.text, /\/home\/jordan\//);
    assert.doesNotMatch(packet.text, /state\/mlb\//);
    assert.doesNotMatch(packet.text, /TLDR BOARD:/);
    assert.doesNotMatch(packet.text, /Evidence Box/);
    assert.doesNotMatch(packet.text, /Market overview/);
    assert.doesNotMatch(packet.text, /Decision Process/);
    assert.doesNotMatch(packet.text, /Pick summary/);
    assert.doesNotMatch(packet.text, /Final Call/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('single-family game packets do not claim modeled families disagree and keep one footer', () => {
  const packet = buildKalshiGamePacket({
    date: '2026-06-21',
    event: {
      event_ticker: 'KXMLBGAME-20260621-NYMPHI',
      title: 'New York Mets at Philadelphia Phillies',
      away_team: 'NYM',
      home_team: 'PHI',
      venue: 'Citizens Bank Park',
      start_utc: '2026-06-21T23:20:00Z',
      start_ct: '2026-06-21 18:20 CT',
    },
    artifacts: [],
    primeAttempts: [],
    kalshiSummary: { ok: true, total: 2, matched: 2, error: null },
    sourcePath: '/tmp/mlb/game.json',
    gamePicks: [
      {
        market_ticker: 'KXMLBGAME-20260621-NYMPHI-PHI',
        game: 'New York Mets at Philadelphia Phillies',
        contract_title: 'Philadelphia Phillies',
        classification: 'PASS',
        fair_value: null,
        kalshi_ask: 0.64,
        kalshi_bid: 0.62,
        edge_pp: null,
        gates_passed: ['starter projected', 'lineup projected', 'weather projected'],
        missing_confirmations: [],
        market_lane: 'moneyline',
      },
      {
        market_ticker: 'KXMLBGAME-20260621-NYMPHI-NYM',
        game: 'New York Mets at Philadelphia Phillies',
        contract_title: 'New York Mets',
        classification: 'PASS',
        fair_value: null,
        kalshi_ask: 0.36,
        kalshi_bid: 0.34,
        edge_pp: null,
        gates_passed: ['starter projected', 'lineup projected', 'weather projected'],
        missing_confirmations: [],
        market_lane: 'moneyline',
      },
    ],
    statsRecord: {
      game: 'New York Mets at Philadelphia Phillies',
      game_pk: 823449,
      game_date: '2026-06-21',
      venue: 'Citizens Bank Park',
      away_team: 'New York Mets',
      home_team: 'Philadelphia Phillies',
      away_pitcher: { name: 'David Peterson', mlb_id: 123, era: 5.91, k_pct: 0.22, games_started: 14, batters_faced: 324 },
      home_pitcher: { name: 'Zack Wheeler', mlb_id: 456, era: 2.01, k_pct: 0.28, games_started: 15, batters_faced: 365 },
      away_team_stats: { runs_scored: 308, runs_allowed: 338, gamesPlayed: 76 },
      home_team_stats: { runs_scored: 365, runs_allowed: 294, gamesPlayed: 77 },
      away_bullpen: { era: 3.41 },
      home_bullpen: { era: 3.93 },
    },
    leagueRPG: 4.36,
    scope: 'GAME_PACKET',
    sourceRefs: {
      event: 'state/mlb/2026-06-21/discovery/mlb_official_adapter.json',
      stats: 'state/mlb/2026-06-21/discovery/stats_adapter.json',
      weather: 'state/mlb/2026-06-21/discovery/weather_adapter.json',
      context: 'state/mlb/2026-06-21/discovery/context_adapter.json',
    },
  });

  assert.doesNotMatch(packet.text, /modeled families disagree/i);
  assert.match(packet.text, /single modeled family only/i);
  assert.equal((packet.text.match(/No trades placed by this workflow\./g) || []).length, 1);
  assert.equal((packet.text.match(/No bankroll advice\./g) || []).length, 1);
});

test('single-family fully sourced packets render a sharp model-backed storyline', () => {
  const statsPath = join('state', 'mlb', '2026-06-21', 'discovery', 'stats_adapter.json');
  const statsJson = JSON.parse(readFileSync(statsPath, 'utf8'));
  const statsRecord = statsJson.records.find((record) =>
    record?.game_pk === 824987
    || record?.game === 'Los Angeles Angels at Athletics'
    || record?.away_team === 'Los Angeles Angels');

  assert.ok(statsRecord, 'expected LAA @ ATH stats record');

  const packet = buildKalshiGamePacket({
    date: '2026-06-21',
    event: {
      event_ticker: 'KXMLBGAME-26JUN211605LAAATH',
      title: 'Los Angeles Angels at Athletics',
      series_ticker: 'KXMLBGAME',
      away_team: 'LAA',
      home_team: 'ATH',
      away_full: 'Los Angeles Angels',
      home_full: 'Athletics',
      venue: 'Sutter Health Park',
      start_utc: '2026-06-21T19:05:00Z',
    },
    artifacts: [],
    primeAttempts: [],
    kalshiSummary: { ok: true, total: 1, matched: 1, error: null },
    sourcePath: '/tmp/mlb/game.json',
    gamePicks: [{
      market_ticker: 'KXMLBGAME-26JUN211605LAAATH-LAA',
      game: 'Los Angeles Angels at Athletics',
      contract_title: 'Los Angeles Angels',
      classification: 'PASS',
      fair_value: null,
      kalshi_ask: 0.4,
      kalshi_bid: 0.38,
      edge_pp: null,
      gates_passed: ['starter confirmed', 'lineup locked', 'weather updated'],
      missing_confirmations: [],
      market_lane: 'moneyline',
    }],
    statsRecord,
    leagueRPG: 4.36,
    scope: 'GAME_PACKET',
    sourceRefs: {
      event: statsPath.replace('stats_adapter.json', 'mlb_official_adapter.json'),
      stats: statsPath,
      weather: statsPath.replace('stats_adapter.json', 'weather_adapter.json'),
      context: statsPath.replace('stats_adapter.json', 'context_adapter.json'),
    },
  });

  assert.match(packet.text, /Event Preview \/ Storyline/);
  assert.match(packet.text, /The model leans Los Angeles Angels because the projected run split favors Los Angeles Angels 5\.9 to 4\.8 and the win split lands at 64\.1%/);
  assert.match(packet.text, /NO CLEAR PICK because only the MONEYLINE family is fully modeled/);
  assert.match(packet.text, /projected total ~10\.7/);
  assert.match(packet.text, /YRFI 73%/);
  assert.match(packet.text, /Reid Detmers projects around 6\.4 K/);
  assert.match(packet.text, /Jack Perkins projects around 12\.3 K/);
  assert.match(packet.text, /Upgrade trigger: add a confirmed second modeled family/);
  assert.doesNotMatch(packet.text, /Evidence Box/);
  assert.doesNotMatch(packet.text, /Decision Process/);
  assert.doesNotMatch(packet.text, /Market overview/);
  assert.doesNotMatch(packet.text, /YES ¢|bid|ask|volume|open interest|liquidity/i);
  assert.doesNotMatch(packet.text, /\/home\/jordan\//);
  assert.doesNotMatch(packet.text, /state\/mlb\//);
  assert.equal((packet.text.match(/No trades placed by this workflow\./g) || []).length, 1);
  assert.equal((packet.text.match(/No bankroll advice\./g) || []).length, 1);
});

test('game packets show projected lineup status when alpha is still pending', () => {
  const packet = buildKalshiGamePacket({
    date: '2026-06-21',
    event: {
      event_ticker: 'KXMLBGAME-20260621-NYMPHI',
      title: 'New York Mets at Philadelphia Phillies',
      away_team: 'NYM',
      home_team: 'PHI',
      venue: 'Citizens Bank Park',
      start_utc: '2026-06-21T23:20:00Z',
      start_ct: '2026-06-21 18:20 CT',
    },
    artifacts: [],
    primeAttempts: [],
    kalshiSummary: { ok: true, total: 1, matched: 1, error: null },
    sourcePath: '/tmp/mlb/game.json',
    gamePicks: [{
      market_ticker: 'KXMLBGAME-20260621-NYMPHI-PHI',
      game: 'New York Mets at Philadelphia Phillies',
      contract_title: 'Philadelphia Phillies',
      classification: 'PASS',
      fair_value: null,
      kalshi_ask: 0.64,
      kalshi_bid: 0.62,
      edge_pp: null,
      gates_passed: ['starter projected', 'lineup pending', 'weather projected'],
      missing_confirmations: ['lineup_pending'],
      market_lane: 'moneyline',
    }],
    statsRecord: {
      game: 'New York Mets at Philadelphia Phillies',
      game_pk: 823934,
      game_date: '2026-06-21',
      venue: 'Citizens Bank Park',
      away_team: 'New York Mets',
      home_team: 'Philadelphia Phillies',
      away_pitcher: { name: 'David Peterson', mlb_id: 123, era: 5.91, k_pct: 0.22, games_started: 14, batters_faced: 324 },
      home_pitcher: { name: 'Zack Wheeler', mlb_id: 456, era: 2.01, k_pct: 0.28, games_started: 15, batters_faced: 365 },
      away_team_stats: { runs_scored: 308, runs_allowed: 338, gamesPlayed: 76 },
      home_team_stats: { runs_scored: 365, runs_allowed: 294, gamesPlayed: 77 },
      away_bullpen: { era: 3.41 },
      home_bullpen: { era: 3.93 },
    },
    leagueRPG: 4.36,
    scope: 'GAME_PACKET',
    sourceRefs: {
      event: 'state/mlb/2026-06-21/discovery/mlb_official_adapter.json',
      stats: 'state/mlb/2026-06-21/discovery/stats_adapter.json',
      weather: 'state/mlb/2026-06-21/discovery/weather_adapter.json',
      context: 'state/mlb/2026-06-21/discovery/context_adapter.json',
    },
  });

  assert.match(packet.text, /Research Status/);
  assert.match(packet.text, /Lineup PROJECTED · Starter PROBABLE · Weather UPDATED/);
  assert.match(packet.text, /Event Preview \/ Storyline/);
  assert.match(packet.text, /the line is still provisional on lineup alpha/);
});
