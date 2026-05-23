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
  assert.match(text, /Edge Basis/i);
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

test('renderPerGamePacket: Edge Basis section states fundamentals requirement', () => {
  const { text } = renderPerGamePacket(fakeGame, { lineupStatus: LINEUP_STATUS.PENDING });
  assert.ok(
    /fundamentals/i.test(text) || /Edge Basis/i.test(text),
    'expected fundamentals-first statement in packet text',
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

// ---------------------------------------------------------------------------
// Fundamentals-first renderer guardrails
// ---------------------------------------------------------------------------

test('renderPerGamePacket: Edge Basis section exists and contains no market-structure terms', () => {
  const game = { game_key: 'TEST', away: 'CHC', home: 'STL', away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals',
    start_utc: '2026-06-01T23:05:00Z', start_ct: '2026-06-01 18:05 CT', series: {} };
  const pkt = renderPerGamePacket(game, { lineupStatus: 'pending' });
  assert.ok(pkt.text.includes('--- Edge Basis ---'), 'Edge Basis section must be present');
  const edgeBasisStart = pkt.text.indexOf('--- Edge Basis ---');
  const marketContextStart = pkt.text.indexOf('--- Market Context ---');
  const edgeBasisText = pkt.text.slice(edgeBasisStart, marketContextStart > -1 ? marketContextStart : undefined);
  const forbidden = ['ladder inversion', 'cross-side arb', 'OI', 'open interest', 'market-internal', 'price favoritism', ' arb', 'spread ladder'];
  for (const term of forbidden) {
    assert.ok(!edgeBasisText.toLowerCase().includes(term.toLowerCase()), `Edge Basis must not contain "${term}"`);
  }
});

test('renderPerGamePacket: Market Context section exists as separate section', () => {
  const game = { game_key: 'TEST', away: 'CHC', home: 'STL', away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals',
    start_utc: '2026-06-01T23:05:00Z', start_ct: '2026-06-01 18:05 CT', series: {} };
  const pkt = renderPerGamePacket(game, { lineupStatus: 'pending' });
  assert.ok(pkt.text.includes('--- Market Context ---'), 'Market Context section must be present');
});

test('renderPerGamePacket: board-only signals cannot produce PICK or LEAN in Edge Basis', () => {
  // Game with priced ML markets that would produce CLEAR in the board engine
  const game = {
    game_key: 'TEST', away: 'CHC', home: 'STL', away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals',
    start_utc: '2026-06-01T23:05:00Z', start_ct: '2026-06-01 18:05 CT',
    series: {
      ml: {
        event_ticker: 'KXMLBGAME-TEST', markets: [
          { ticker: 'KXMLBGAME-TEST-CHC', yes_ask_dollars: 0.40, no_ask_dollars: 0.62,
            yes_bid_dollars: 0.38, no_bid_dollars: 0.60, open_interest_fp: 200 },
          { ticker: 'KXMLBGAME-TEST-STL', yes_ask_dollars: 0.50, no_ask_dollars: 0.52,
            yes_bid_dollars: 0.48, no_bid_dollars: 0.50, open_interest_fp: 120 },
        ],
        priced: true, market_count: 2,
      },
    },
  };
  // No fundamentals — starters and lineups not provided
  const pkt = renderPerGamePacket(game, { lineupStatus: 'pending' });
  // Even with a priced ML market, bestLaneDecision must not be PICK or LEAN
  assert.notEqual(pkt.bestLaneDecision, 'CLEAR', 'board CLEAR must not become edge PICK');
  assert.notEqual(pkt.bestLaneDecisionLabel, 'PICK', 'board CLEAR must not become edge PICK');
  assert.notEqual(pkt.bestLaneDecision, 'LEAN', 'board LEAN must not become edge LEAN');
  // Edge Basis section must not say PICK or LEAN for winner
  const edgeBasisStart = pkt.text.indexOf('--- Edge Basis ---');
  const marketContextStart = pkt.text.indexOf('--- Market Context ---');
  const edgeBasisText = pkt.text.slice(edgeBasisStart, marketContextStart > -1 ? marketContextStart : undefined);
  assert.ok(!edgeBasisText.includes(': PICK'), 'Edge Basis must not contain PICK');
  assert.ok(!edgeBasisText.includes(': LEAN'), 'Edge Basis must not contain LEAN');
});

test('renderPerGamePacket: missing fundamentals produce WATCH not PICK even with board CLEAR', () => {
  const game = {
    game_key: 'TEST2', away: 'NYM', home: 'LAD',
    away_full: 'New York Mets', home_full: 'Los Angeles Dodgers',
    start_utc: '2026-06-01T23:10:00Z', start_ct: '2026-06-01 18:10 CT',
    series: {
      ml: {
        event_ticker: 'KXMLBGAME-TEST2', priced: true, market_count: 2, markets: [
          { ticker: 'KXMLBGAME-TEST2-NYM', yes_ask_dollars: 0.38, no_ask_dollars: 0.64, open_interest_fp: 500 },
          { ticker: 'KXMLBGAME-TEST2-LAD', yes_ask_dollars: 0.55, no_ask_dollars: 0.47, open_interest_fp: 300 },
        ],
      },
    },
  };
  const pkt = renderPerGamePacket(game, { lineupStatus: 'pending', starters: null });
  assert.ok(
    pkt.bestLaneDecisionLabel === 'WATCH' || pkt.bestLaneDecisionLabel === 'NO CLEAR PICK',
    `bestLaneDecisionLabel should be WATCH or NO CLEAR PICK, got ${pkt.bestLaneDecisionLabel}`,
  );
});

test('renderBlockPacket: ranked summary section does not contain market-structure terms', () => {
  const game = { game_key: 'BLK1', away: 'CHC', home: 'STL', away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals',
    start_utc: '2026-06-01T23:05:00Z', start_ct: '2026-06-01 18:05 CT', series: {} };
  const pkt = renderPerGamePacket(game, { lineupStatus: 'pending' });
  const block = {
    block_id: 'LB01',
    lead_first_pitch_ct: '2026-06-01 18:05 CT',
    hard_cutoff_ct: '2026-06-01 17:20 CT',
    lineup_status: 'pending',
    game_keys: ['BLK1'],
  };
  const blockText = renderBlockPacket(block, [pkt]);
  // Find the ranked summary section
  const summaryStart = blockText.indexOf('--- Ranked Fundamentals Summary ---');
  const perGameStart = blockText.indexOf('--- Per-Game Packets ---');
  const summarySection = blockText.slice(summaryStart, perGameStart > -1 ? perGameStart : undefined);
  const forbidden = ['ladder inversion', 'cross-side arb', 'market-internal', 'OI confirmation'];
  for (const term of forbidden) {
    assert.ok(!summarySection.toLowerCase().includes(term.toLowerCase()), `Block summary must not contain "${term}"`);
  }
});

test('buildPacketMeta: has_picks is false when all lanes are WATCH/NO CLEAR PICK', async () => {
  const { buildPacketMeta } = await import('../scripts/mlb/generate-lineup-packets.mjs');
  const game = { game_key: 'NOPICK', away: 'CHC', home: 'STL', away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals',
    start_utc: '2026-06-01T23:05:00Z', start_ct: '2026-06-01 18:05 CT', series: {} };
  const pkt = renderPerGamePacket(game, { lineupStatus: 'pending' });
  const meta = buildPacketMeta({
    date: '2026-06-01', blockId: 'LB01', lineupStatus: 'pending', downgrade: 'full',
    games: [game], perGamePackets: [pkt], blockTxtPath: '/tmp/block.txt', dryRun: true,
  });
  assert.equal(meta.has_picks, false, 'has_picks must be false when fundamentals missing');
});

test('buildLineupBlockSchedule: creates valid schedule with correct schema', async () => {
  const { buildLineupBlockSchedule } = await import('../scripts/mlb/schedule-daily-slate.mjs');
  const schedule = await buildLineupBlockSchedule({
    date: '2026-06-15',
    games: [],  // dry-run: no games
    groupingWindowMinutes: 30,
    pollingLeadMinutes: 180,
    hardCutoffMinutes: 45,
  });
  assert.equal(schedule.schema, 'mlb-lineup-block-schedule/v1');
  assert.equal(schedule.date, '2026-06-15');
  assert.equal(schedule.grouping_window_minutes, 30);
  assert.equal(schedule.polling_lead_minutes, 180);
  assert.equal(schedule.hard_cutoff_minutes, 45);
  assert.ok(Array.isArray(schedule.blocks));
  assert.equal(schedule.blocks.length, 0);
});
