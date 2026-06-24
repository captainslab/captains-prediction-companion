import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INPUT_STATUSES,
  SOURCE_QUALITIES,
  PACKET_SCOPES,
  buildLedgerItem,
  buildScopedLedger,
  ledgerFilename,
  buildInputStatusNote,
  buildHrWatchEntry,
  buildHrWatchlist,
} from '../scripts/mlb/lib/assumptions-ledger.mjs';

const FORBIDDEN_PRICE_KEYS = [
  'kalshi_ask',
  'yes_ask',
  'open_interest',
  'volume',
  'odds',
  'bid',
  'ask',
  'price',
  'liquidity',
];

test('exports are frozen and stable', () => {
  assert.ok(Object.isFrozen(INPUT_STATUSES));
  assert.ok(Object.isFrozen(SOURCE_QUALITIES));
  assert.ok(Object.isFrozen(PACKET_SCOPES));
  assert.deepEqual(INPUT_STATUSES, ['LOCKED', 'PROJECTED', 'ASSUMED', 'UNKNOWN']);
  assert.deepEqual(SOURCE_QUALITIES, ['A', 'B', 'C', 'D', 'F']);
  assert.deepEqual(PACKET_SCOPES, ['FULL_DAY_PREVIEW', 'SLATE_PREVIEW', 'GAME_PACKET']);
});

test('missing basis or source forces UNKNOWN and F', () => {
  const noBasis = buildLedgerItem({
    type: 'lineup',
    scope: 'SLATE_PREVIEW',
    status: 'LOCKED',
    basis: '',
    source: 'picks.json',
    source_quality: 'A',
  });
  assert.equal(noBasis.status, 'UNKNOWN');
  assert.equal(noBasis.source_quality, 'F');
  assert.equal(noBasis.supports_evidence, false);

  const noSource = buildLedgerItem({
    type: 'weather',
    scope: 'GAME_PACKET',
    status: 'PROJECTED',
    basis: 'weather feed present',
    source: ' ',
    source_quality: 'B',
  });
  assert.equal(noSource.status, 'UNKNOWN');
  assert.equal(noSource.source_quality, 'F');
  assert.equal(noSource.supports_evidence, false);
});

test('ASSUMED never means guessed', () => {
  const item = buildLedgerItem({
    type: 'starter',
    scope: 'GAME_PACKET',
    status: 'ASSUMED',
    basis: '',
    source: 'stats.json',
    source_quality: 'C',
  });
  assert.equal(item.status, 'UNKNOWN');
  assert.equal(item.source_quality, 'F');
  assert.equal(item.supports_evidence, false);
});

test('clean evidence supports evidence; F and UNKNOWN do not', () => {
  const locked = buildLedgerItem({
    type: 'starter',
    scope: 'GAME_PACKET',
    status: 'LOCKED',
    basis: 'official lineup confirmed',
    source: 'mlb_official_adapter.json',
    source_quality: 'A',
  });
  const fQuality = buildLedgerItem({
    type: 'weather',
    scope: 'SLATE_PREVIEW',
    status: 'PROJECTED',
    basis: 'trusted forecast window',
    source: 'weather_adapter.json',
    source_quality: 'F',
  });
  const unknown = buildLedgerItem({
    type: 'lineup',
    scope: 'FULL_DAY_PREVIEW',
    status: 'UNKNOWN',
    basis: ' ',
    source: ' ',
    source_quality: 'A',
  });

  assert.equal(locked.supports_evidence, true);
  assert.equal(fQuality.supports_evidence, false);
  assert.equal(unknown.supports_evidence, false);
});

test('price keys smuggled into any field throw hard', () => {
  assert.throws(() => buildLedgerItem({
    type: 'weather',
    scope: 'SLATE_PREVIEW',
    status: 'PROJECTED',
    basis: 'weather adapter',
    source: 'weather.json',
    source_quality: 'B',
    kalshi_ask: 0.71,
  }), /price-isolation/);
});

test('buildScopedLedger summarizes statuses and qualities', () => {
  const items = [
    buildLedgerItem({
      type: 'lineup',
      scope: 'SLATE_PREVIEW',
      status: 'LOCKED',
      basis: 'lineup confirmed',
      source: 'context.json',
      source_quality: 'A',
    }),
    buildLedgerItem({
      type: 'starter',
      scope: 'SLATE_PREVIEW',
      status: 'PROJECTED',
      basis: 'probable starter from stats',
      source: 'stats.json',
      source_quality: 'B',
    }),
    buildLedgerItem({
      type: 'weather',
      scope: 'SLATE_PREVIEW',
      status: 'UNKNOWN',
      basis: '',
      source: '',
      source_quality: 'A',
    }),
  ];
  const ledger = buildScopedLedger({ scope: 'SLATE_PREVIEW', date: '2026-06-20', items });
  assert.equal(ledger.summary.total, 3);
  assert.deepEqual(ledger.summary.by_status, {
    LOCKED: 1,
    PROJECTED: 1,
    ASSUMED: 0,
    UNKNOWN: 1,
  });
  assert.deepEqual(ledger.summary.by_quality, {
    A: 1,
    B: 1,
    C: 0,
    D: 0,
    F: 1,
  });
  assert.equal(ledger.summary.evidence_eligible, 2);
  assert.throws(() => buildScopedLedger({ scope: 'NOPE', date: '2026-06-20', items }), /invalid MLB assumptions scope/);
});

test('ledgerFilename is deterministic and scoped', () => {
  assert.equal(ledgerFilename('FULL_DAY_PREVIEW'), 'full-day-preview.json');
  assert.equal(ledgerFilename('SLATE_PREVIEW'), 'slate.json');
  assert.equal(ledgerFilename('GAME_PACKET', { gameId: '824434' }), 'game-824434.json');
  assert.throws(() => ledgerFilename('GAME_PACKET'), /gameId is required/);
});

test('input status notes use the requested labels', () => {
  const fullDay = buildInputStatusNote({ scope: 'FULL_DAY_PREVIEW' });
  assert.match(fullDay, /projected lineups/);
  assert.match(fullDay, /probable starters/);
  assert.match(fullDay, /preliminary weather/);
  assert.match(fullDay, /current injury\/news/);
  assert.match(fullDay, /locked lineups arrive in the slate and game packets/);
  assert.match(fullDay, /unconfirmed players are removed or downgraded before final game packets/);

  const gameLocked = buildInputStatusNote({
    scope: 'GAME_PACKET',
    lineupInput: 'LOCKED',
    starterInput: 'PROJECTED',
    weatherInput: 'LOCKED',
  });
  assert.match(gameLocked, /Lineup LOCKED/);
  assert.match(gameLocked, /Starter PROBABLE/);
  assert.match(gameLocked, /Weather UPDATED/);

  const gameUnknown = buildInputStatusNote({
    scope: 'SLATE_PREVIEW',
    lineupInput: 'UNKNOWN',
    starterInput: 'ASSUMED',
    weatherInput: 'PROJECTED',
  });
  assert.match(gameUnknown, /Lineup UNKNOWN/);
  assert.match(gameUnknown, /Starter PROBABLE/);
  assert.match(gameUnknown, /Weather PRELIMINARY/);
});

test('HR watch guards unknowns and preserves evidence-backed entries', () => {
  assert.throws(() => buildHrWatchEntry({
    scope: 'GAME_PACKET',
    player: null,
    status: 'PROJECTED',
    basis: 'confirmed lineup',
    source: 'stats.json',
    source_quality: 'A',
  }), /non-empty player/);

  assert.equal(buildHrWatchEntry({
    scope: 'GAME_PACKET',
    player: 'Aaron Judge',
    status: 'PROJECTED',
    basis: 'confirmed lineup',
    source: 'stats.json',
    source_quality: 'F',
  }), null);

  const good = buildHrWatchEntry({
    scope: 'GAME_PACKET',
    player: 'Aaron Judge',
    team: 'NYY',
    game: 'NYY at BOS',
    status: 'LOCKED',
    basis: 'confirmed lineup and batter-specific HR context',
    source: 'stats.json',
    source_quality: 'A',
    projected_hr_prob: 0.31,
  });
  assert.ok(good);
  assert.equal(good.basis, 'confirmed lineup and batter-specific HR context');
  assert.equal(good.source, 'stats.json');
  assert.equal(good.source_quality, 'A');
  assert.equal(good.supports_evidence, true);
  assert.equal(good.removal_rule, 'Remove/downgrade if not in confirmed lineup.');
  assert.equal(good.value, 0.31);

  const watchlist = buildHrWatchlist([
    { scope: 'GAME_PACKET', player: 'Unknown Batter', status: 'UNKNOWN', basis: 'confirmed lineup', source: 'stats.json', source_quality: 'A' },
    { scope: 'GAME_PACKET', player: 'F-Quality', status: 'PROJECTED', basis: 'confirmed lineup', source: 'stats.json', source_quality: 'F' },
    { scope: 'GAME_PACKET', player: 'Aaron Judge', team: 'NYY', game: 'NYY at BOS', status: 'LOCKED', basis: 'confirmed lineup and batter-specific HR context', source: 'stats.json', source_quality: 'A', projected_hr_prob: 0.31 },
  ], { scope: 'GAME_PACKET' });
  assert.equal(watchlist.length, 1);
  assert.equal(watchlist[0].player, 'Aaron Judge');
  assert.equal(watchlist[0].removal_rule, 'Remove/downgrade if not in confirmed lineup.');
});

test('ledger and HR watchlist JSON contain no forbidden price keys', () => {
  const ledger = buildScopedLedger({
    scope: 'GAME_PACKET',
    date: '2026-06-20',
    items: [
      buildLedgerItem({
        type: 'lineup',
        scope: 'GAME_PACKET',
        status: 'LOCKED',
        basis: 'confirmed lineup',
        source: 'context.json',
        source_quality: 'A',
      }),
      buildLedgerItem({
        type: 'starter',
        scope: 'GAME_PACKET',
        status: 'PROJECTED',
        basis: 'probable starter',
        source: 'stats.json',
        source_quality: 'B',
      }),
      buildLedgerItem({
        type: 'weather',
        scope: 'GAME_PACKET',
        status: 'UNKNOWN',
        basis: '',
        source: '',
        source_quality: 'A',
      }),
    ],
  });
  const hrWatchlist = buildHrWatchlist([
    {
      scope: 'GAME_PACKET',
      player: 'Aaron Judge',
      team: 'NYY',
      game: 'NYY at BOS',
      status: 'LOCKED',
      basis: 'confirmed lineup and batter-specific HR context',
      source: 'stats.json',
      source_quality: 'A',
      projected_hr_prob: 0.31,
    },
  ], { scope: 'GAME_PACKET' });
  const json = JSON.stringify({ ledger, hrWatchlist });
  for (const key of FORBIDDEN_PRICE_KEYS) {
    assert.ok(!json.includes(key), `forbidden key leaked: ${key}`);
  }
});
