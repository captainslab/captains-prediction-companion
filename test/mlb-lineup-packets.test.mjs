import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupIntoLineupBlocks,
  findDueBlocks,
  resolveDowngrade,
  applyDowngrade,
  LINEUP_STATUS,
  PACKET_DOWNGRADE,
} from '../scripts/mlb/lib/lineup-blocks.mjs';

import {
  renderPerGamePacket,
  renderBlockPacket,
} from '../scripts/mlb/lib/packet-renderer.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGame(overrides = {}) {
  return {
    game_key: 'DEFAULT',
    away: 'CHC',
    home: 'STL',
    away_full: 'Chicago Cubs',
    home_full: 'St. Louis Cardinals',
    start_utc: '2026-06-01T19:00:00Z',
    start_ct: '2026-06-01 14:00 CT',
    series: {
      ml:     { markets: [] },
      spread: { markets: [] },
      total:  { markets: [] },
      hr:     { markets: [] },
      ks:     { markets: [] },
      rfi:    { markets: [] },
    },
    ...overrides,
  };
}

// Build an ISO string offset from a base UTC time by ±minutes.
function offsetUtc(baseIso, deltaMin) {
  return new Date(Date.parse(baseIso) + deltaMin * 60_000).toISOString();
}

// Build a minimal lineup block without going through groupIntoLineupBlocks.
function makeBlock(overrides = {}) {
  const now = Date.now();
  return {
    block_id: 'LB01',
    lead_first_pitch_utc: new Date(now + 60 * 60_000).toISOString(),
    lead_first_pitch_ct:  '2026-06-01 14:00 CT',
    polling_starts_utc:   new Date(now - 30 * 60_000).toISOString(),
    polling_starts_ct:    '2026-06-01 11:00 CT',
    hard_cutoff_utc:      new Date(now + 15 * 60_000).toISOString(),
    hard_cutoff_ct:       '2026-06-01 13:15 CT',
    game_keys:            ['DEFAULT'],
    games:                [],
    lineup_status:        LINEUP_STATUS.PENDING,
    packet_status:        'scheduled',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// groupIntoLineupBlocks
// ---------------------------------------------------------------------------

test('groupIntoLineupBlocks: games within 30 min → same block', () => {
  const base = '2026-06-01T19:00:00Z';
  const games = [
    makeGame({ game_key: 'G1', start_utc: base }),
    makeGame({ game_key: 'G2', start_utc: offsetUtc(base, 10) }),
    makeGame({ game_key: 'G3', start_utc: offsetUtc(base, 20) }),
  ];
  const blocks = groupIntoLineupBlocks(games);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].game_keys.length, 3);
});

test('groupIntoLineupBlocks: games >30 min apart → separate blocks', () => {
  const base = '2026-06-01T19:00:00Z';
  const games = [
    makeGame({ game_key: 'G1', start_utc: base }),
    makeGame({ game_key: 'G2', start_utc: offsetUtc(base, 45) }),
  ];
  const blocks = groupIntoLineupBlocks(games);
  assert.equal(blocks.length, 2);
});

test('groupIntoLineupBlocks: block timing fields are correct', () => {
  // First pitch: 2026-06-01T00:00:00Z (convenient round number for math).
  const firstPitch = '2026-06-01T00:00:00Z';
  const games = [makeGame({ game_key: 'G1', start_utc: firstPitch })];
  const blocks = groupIntoLineupBlocks(games);
  assert.equal(blocks.length, 1);

  const b = blocks[0];
  const leadMs    = Date.parse(firstPitch);
  const pollingMs = Date.parse(b.polling_starts_utc);
  const cutoffMs  = Date.parse(b.hard_cutoff_utc);

  // polling_starts_utc = lead - 180 min
  assert.equal(pollingMs, leadMs - 180 * 60_000);
  // hard_cutoff_utc = lead - 45 min
  assert.equal(cutoffMs, leadMs - 45 * 60_000);
});

test('groupIntoLineupBlocks: block_id uses LB prefix with zero-padding', () => {
  const base = '2026-06-01T18:00:00Z';
  // 3 separate blocks spaced 60 min apart
  const games = [
    makeGame({ game_key: 'G1', start_utc: base }),
    makeGame({ game_key: 'G2', start_utc: offsetUtc(base, 60) }),
    makeGame({ game_key: 'G3', start_utc: offsetUtc(base, 120) }),
  ];
  const blocks = groupIntoLineupBlocks(games);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].block_id, 'LB01');
  assert.equal(blocks[1].block_id, 'LB02');
  assert.equal(blocks[2].block_id, 'LB03');
});

// ---------------------------------------------------------------------------
// findDueBlocks
// ---------------------------------------------------------------------------

test('findDueBlocks: returns nothing when polling has not started', () => {
  const now = Date.now();
  const block = makeBlock({
    polling_starts_utc: new Date(now + 60 * 60_000).toISOString(),
    hard_cutoff_utc:    new Date(now + 3 * 60 * 60_000).toISOString(),
  });
  const result = findDueBlocks([block], now);
  assert.equal(result.length, 0);
});

test('findDueBlocks: returns block when inside polling window', () => {
  const now = Date.now();
  const block = makeBlock({
    polling_starts_utc: new Date(now - 30 * 60_000).toISOString(),
    hard_cutoff_utc:    new Date(now + 15 * 60_000).toISOString(),
    packet_status: 'scheduled',
  });
  const result = findDueBlocks([block], now);
  assert.equal(result.length, 1);
});

test('findDueBlocks: excludes already-rendered blocks', () => {
  const now = Date.now();
  const block = makeBlock({
    polling_starts_utc: new Date(now - 30 * 60_000).toISOString(),
    hard_cutoff_utc:    new Date(now + 15 * 60_000).toISOString(),
    packet_status: 'rendered',
  });
  const result = findDueBlocks([block], now);
  assert.equal(result.length, 0);
});

test('findDueBlocks: block past hard cutoff + grace is excluded; within grace is included', () => {
  const now = Date.now();
  const graceMs = 5 * 60_000; // 5 min grace

  // Past grace: cutoff 10 min ago, grace 5 min → not returned
  const pastGrace = makeBlock({
    polling_starts_utc: new Date(now - 3 * 60 * 60_000).toISOString(),
    hard_cutoff_utc:    new Date(now - 10 * 60_000).toISOString(),
    packet_status: 'scheduled',
  });
  assert.equal(findDueBlocks([pastGrace], now, graceMs).length, 0);

  // Within grace: cutoff 3 min ago, grace 5 min → is returned
  const withinGrace = makeBlock({
    polling_starts_utc: new Date(now - 3 * 60 * 60_000).toISOString(),
    hard_cutoff_utc:    new Date(now - 3 * 60_000).toISOString(),
    packet_status: 'scheduled',
  });
  assert.equal(findDueBlocks([withinGrace], now, graceMs).length, 1);
});

// ---------------------------------------------------------------------------
// applyDowngrade — HR lane
// ---------------------------------------------------------------------------

test('applyDowngrade: HR always NO CLEAR PICK without both_confirmed', () => {
  // PENDING → full downgrade → NO CLEAR PICK
  const pendingFull = applyDowngrade('hr', 'LEAN', PACKET_DOWNGRADE.FULL);
  assert.equal(pendingFull.decision, 'NO CLEAR PICK');

  // ONE_CONFIRMED → partial downgrade → NO CLEAR PICK
  const onePartial = applyDowngrade('hr', 'LEAN', PACKET_DOWNGRADE.PARTIAL);
  assert.equal(onePartial.decision, 'NO CLEAR PICK');

  // BOTH_CONFIRMED → none downgrade → original decision preserved
  const bothNone = applyDowngrade('hr', 'LEAN', PACKET_DOWNGRADE.NONE);
  assert.equal(bothNone.decision, 'LEAN');
  assert.equal(bothNone.downgradeReason, null);
});

// ---------------------------------------------------------------------------
// applyDowngrade — FULL downgrade on non-HR lanes
// ---------------------------------------------------------------------------

test('applyDowngrade: FULL downgrade caps CLEAR → LEAN for non-HR lanes', () => {
  // CLEAR → LEAN
  const winnerClear = applyDowngrade('winner', 'CLEAR', PACKET_DOWNGRADE.FULL);
  assert.equal(winnerClear.decision, 'LEAN');

  // PASS → WATCH
  const spreadPass = applyDowngrade('spread', 'PASS', PACKET_DOWNGRADE.FULL);
  assert.equal(spreadPass.decision, 'WATCH');

  // LEAN → LEAN (already at cap, no further downgrade)
  const totalLean = applyDowngrade('total', 'LEAN', PACKET_DOWNGRADE.FULL);
  assert.equal(totalLean.decision, 'LEAN');
});

// ---------------------------------------------------------------------------
// applyDowngrade — PARTIAL downgrade
// ---------------------------------------------------------------------------

test('applyDowngrade: PARTIAL downgrade preserves decision with note', () => {
  // Non-HR: decision preserved, downgradeReason non-null
  const winnerClear = applyDowngrade('winner', 'CLEAR', PACKET_DOWNGRADE.PARTIAL);
  assert.equal(winnerClear.decision, 'CLEAR');
  assert.ok(winnerClear.downgradeReason !== null, 'expected a downgrade reason note');

  // HR with PARTIAL → NO CLEAR PICK regardless of raw decision
  const hrLean = applyDowngrade('hr', 'LEAN', PACKET_DOWNGRADE.PARTIAL);
  assert.equal(hrLean.decision, 'NO CLEAR PICK');
});

// ---------------------------------------------------------------------------
// resolveDowngrade
// ---------------------------------------------------------------------------

test('resolveDowngrade: maps lineup status correctly', () => {
  assert.equal(resolveDowngrade(LINEUP_STATUS.BOTH_CONFIRMED), PACKET_DOWNGRADE.NONE);
  assert.equal(resolveDowngrade(LINEUP_STATUS.ONE_CONFIRMED),  PACKET_DOWNGRADE.PARTIAL);
  assert.equal(resolveDowngrade(LINEUP_STATUS.PENDING),        PACKET_DOWNGRADE.FULL);
});

// ---------------------------------------------------------------------------
// renderPerGamePacket — required sections present
// ---------------------------------------------------------------------------

const fakeGame = makeGame({
  game_key: '26JUN011900CHCSTL',
  away: 'CHC', home: 'STL',
  away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals',
  start_utc: '2026-06-01T19:00:00Z',
  start_ct: '2026-06-01 14:00 CT',
});

test('renderPerGamePacket: includes all required sections', () => {
  const pkt = renderPerGamePacket(fakeGame, { lineupStatus: LINEUP_STATUS.PENDING });
  const { text, gameMatchup } = pkt;
  // Full team names are on the returned gameMatchup string, not in the text body.
  assert.match(gameMatchup, /Chicago Cubs/);
  // The text body contains the section headers and key phrases.
  assert.match(text, /Lineup Status/i);
  assert.match(text, /Starters/i);
  assert.match(text, /Market Lanes/i);
  assert.match(text, /Research Completeness/i);
  assert.match(text, /Overall Decision/i);
  assert.match(text, /No trades placed/i);
});

test('renderPerGamePacket: HR shows NO CLEAR PICK when lineups pending', () => {
  const { text } = renderPerGamePacket(fakeGame, { lineupStatus: LINEUP_STATUS.PENDING });
  assert.match(text, /HR props:/i);
  // After the "HR props:" marker, the aggregate line should reflect NO CLEAR PICK.
  const hrIdx = text.indexOf('HR props:');
  assert.ok(hrIdx >= 0, 'expected HR props section');
  const hrSection = text.slice(hrIdx, hrIdx + 300);
  assert.match(hrSection, /NO CLEAR PICK/i);
});

test('renderPerGamePacket: HR shows NO CLEAR PICK when one lineup confirmed', () => {
  const { text } = renderPerGamePacket(fakeGame, { lineupStatus: LINEUP_STATUS.ONE_CONFIRMED });
  const hrIdx = text.indexOf('HR props:');
  assert.ok(hrIdx >= 0, 'expected HR props section');
  const hrSection = text.slice(hrIdx, hrIdx + 300);
  assert.match(hrSection, /NO CLEAR PICK/i);
});

test('renderPerGamePacket: anti-price proof statement present', () => {
  const { text } = renderPerGamePacket(fakeGame, { lineupStatus: LINEUP_STATUS.PENDING });
  assert.ok(
    /market-internal/i.test(text) || /anti-price/i.test(text) || /price-only/i.test(text),
    'expected anti-price proof statement in packet text',
  );
});

// ---------------------------------------------------------------------------
// renderBlockPacket
// ---------------------------------------------------------------------------

const fakeGame2 = makeGame({
  game_key: '26JUN011905MILCHC',
  away: 'MIL', home: 'CHC',
  away_full: 'Milwaukee Brewers', home_full: 'Chicago Cubs',
  start_utc: '2026-06-01T19:05:00Z',
  start_ct: '2026-06-01 14:05 CT',
});

test('renderBlockPacket: includes all games', () => {
  const pkt1 = renderPerGamePacket(fakeGame,  { lineupStatus: LINEUP_STATUS.PENDING });
  const pkt2 = renderPerGamePacket(fakeGame2, { lineupStatus: LINEUP_STATUS.PENDING });

  const block = makeBlock({
    block_id: 'LB01',
    lead_first_pitch_ct: '2026-06-01 14:00 CT',
    hard_cutoff_ct: '2026-06-01 13:15 CT',
    game_keys: [fakeGame.game_key, fakeGame2.game_key],
    games: [
      { game_key: fakeGame.game_key,  away: 'CHC', home: 'STL' },
      { game_key: fakeGame2.game_key, away: 'MIL', home: 'CHC' },
    ],
  });

  const blockText = renderBlockPacket(block, [pkt1, pkt2]);

  // Block ID and both matchup abbreviations must appear.
  assert.match(blockText, /LB01/);
  assert.match(blockText, /CHC/);
  assert.match(blockText, /MIL/);
});

test('renderBlockPacket: NO CLEAR PICK games appear in brief section', () => {
  // Both games have empty series — analyzeGame returns NO CLEAR PICK for each.
  const pkt1 = renderPerGamePacket(fakeGame,  { lineupStatus: LINEUP_STATUS.PENDING });
  const pkt2 = renderPerGamePacket(fakeGame2, { lineupStatus: LINEUP_STATUS.PENDING });

  const block = makeBlock({
    block_id: 'LB01',
    game_keys: [fakeGame.game_key, fakeGame2.game_key],
    games: [],
  });

  const blockText = renderBlockPacket(block, [pkt1, pkt2]);
  assert.match(blockText, /NO CLEAR PICK/i);
});

// ---------------------------------------------------------------------------
// Anti-price regression guard
// ---------------------------------------------------------------------------

test('price-only signal cannot become PICK for any downgrade level', () => {
  for (const downgrade of Object.values(PACKET_DOWNGRADE)) {
    const result = applyDowngrade('winner', 'PASS', downgrade);
    assert.notEqual(
      result.decision,
      'PICK',
      `applyDowngrade('winner','PASS','${downgrade}') should never return PICK`,
    );
    // Verify the concrete expected outcomes so this stays mechanical.
    if (downgrade === PACKET_DOWNGRADE.NONE) {
      assert.equal(result.decision, 'PASS');
    } else if (downgrade === PACKET_DOWNGRADE.FULL) {
      assert.equal(result.decision, 'WATCH');
    } else if (downgrade === PACKET_DOWNGRADE.PARTIAL) {
      assert.equal(result.decision, 'PASS'); // preserved with note
    }
  }
});

// ---------------------------------------------------------------------------
// Block scheduling safety
// ---------------------------------------------------------------------------

test('hard cutoff is always before first pitch', () => {
  const firstPitches = [
    '2026-06-01T18:05:00Z',
    '2026-06-01T20:10:00Z',
    '2026-06-02T00:00:00Z',
  ];
  for (const fp of firstPitches) {
    const blocks = groupIntoLineupBlocks([makeGame({ start_utc: fp })]);
    assert.equal(blocks.length, 1);
    const b = blocks[0];
    assert.ok(
      Date.parse(b.hard_cutoff_utc) < Date.parse(b.lead_first_pitch_utc),
      `hard_cutoff_utc should be before lead_first_pitch_utc for first pitch ${fp}`,
    );
  }
});

test('polling starts before hard cutoff', () => {
  const firstPitches = [
    '2026-06-01T18:05:00Z',
    '2026-06-01T20:10:00Z',
    '2026-06-02T00:00:00Z',
  ];
  for (const fp of firstPitches) {
    const blocks = groupIntoLineupBlocks([makeGame({ start_utc: fp })]);
    assert.equal(blocks.length, 1);
    const b = blocks[0];
    assert.ok(
      Date.parse(b.polling_starts_utc) < Date.parse(b.hard_cutoff_utc),
      `polling_starts_utc should be before hard_cutoff_utc for first pitch ${fp}`,
    );
  }
});
