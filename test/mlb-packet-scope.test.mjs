import test from 'node:test';
import assert from 'node:assert/strict';

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

