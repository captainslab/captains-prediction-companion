import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildNascarRows,
  buildRacePacket,
  loadNascarCeiling,
} from '../scripts/packets/generate-nascar-sunday.mjs';
import { validatePacketText } from '../scripts/cron/cpc-packet-janitor.mjs';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';
import { looksLikeRawInventoryDump } from '../scripts/shared/decision-packet.mjs';

// A minimal Kalshi NASCAR win-market event: per-driver binary contracts keyed
// by yes_sub_title. Prices in dollars (Kalshi public listing shape).
function nascarEvent(overrides = {}) {
  return {
    event_ticker: 'KXNASCARRACE-TEST26',
    title: 'Test 400 Winner',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: [
      {
        ticker: 'KXNASCARRACE-TEST26-HAML', yes_sub_title: 'Denny Hamlin',
        yes_bid_dollars: 0.18, yes_ask_dollars: 0.20, last_price_dollars: 0.19,
        volume_fp: 5000, open_interest_fp: 12000, rules_primary: 'Wins the race',
      },
      {
        ticker: 'KXNASCARRACE-TEST26-LARS', yes_sub_title: 'Kyle Larson',
        yes_bid_dollars: 0.14, yes_ask_dollars: 0.16, last_price_dollars: 0.15,
        volume_fp: 4000, open_interest_fp: 9000, rules_primary: 'Wins the race',
      },
      {
        ticker: 'KXNASCARRACE-TEST26-BELL', yes_sub_title: 'Christopher Bell',
        yes_bid_dollars: 0.09, yes_ask_dollars: 0.11, last_price_dollars: 0.10,
        volume_fp: 2000, open_interest_fp: 6000, rules_primary: 'Wins the race',
      },
    ],
    ...overrides,
  };
}

// A real ceiling-board shape (candidates with composite_score + lanes), the
// MODEL signal. No market price in here — fair win prob is derived from score.
function ceiling(overrides = {}) {
  return {
    candidates: [
      {
        driver_name: 'Denny Hamlin', composite_score: 78,
        fundamentals_layer_coverage: 4, fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'starting_position' }, { layer: 'practice_speed' }] },
        lanes: { win: { status: 'EVIDENCE_LEAN', narrative: 'Pole + strong concrete-track history.' } },
      },
      {
        driver_name: 'Kyle Larson', composite_score: 60,
        fundamentals_layer_coverage: 3, fundamentals_layer_coverage_label: '3/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'starting_position' }] },
        lanes: { win: { status: 'WATCH', narrative: 'Top equipment, mid start.' } },
      },
    ],
    source: '/tmp/ceiling_board.json',
    lanes: ['win'],
    ...overrides,
  };
}

test('JOINED mode: ceiling model joins win markets and produces model-vs-market edge rows', () => {
  const built = buildNascarRows({ event: nascarEvent(), ceiling: ceiling() });
  assert.ok(built, 'rows built');
  assert.equal(built.mode, 'JOINED');
  assert.equal(built.joined, 2, 'two drivers joined to model');
  assert.equal(built.marketCount, 3);

  const hamlin = built.rows.find((r) => r.side_target.startsWith('Denny Hamlin'));
  // model half carries composite, NOT the market price
  assert.equal(hamlin.composite_score, 78);
  // fair win prob is normalized from composite (78/(78+60) ~ 0.565), not market
  assert.match(hamlin.fair_probability_or_range, /%$/);
  // market half carries the price
  assert.equal(hamlin.market_yes_ask, 0.20);
  // edge is numeric (fair - implied) since both halves present
  assert.ok(hamlin.edge_cents_or_pp !== null, 'numeric edge present in JOINED mode');
  // composite score must not equal the implied market price
  assert.notEqual(hamlin.composite_score, hamlin.implied_probability * 100);
});

test('MARKET_ONLY mode: no ceiling -> rows BLOCKED on missing model but keep market data', () => {
  const built = buildNascarRows({ event: nascarEvent(), ceiling: null });
  assert.ok(built, 'rows built');
  assert.equal(built.mode, 'MARKET_ONLY');
  assert.equal(built.joined, 0);
  for (const r of built.rows) {
    assert.equal(r.edge_status, 'BLOCKED');
    assert.match(r.blocker_if_any, /BLOCKED_MODEL_LAYER_MISSING/);
    // market data still present so the row is useful
    assert.ok(r.market_yes_ask !== null, 'market price retained');
    assert.ok(r.implied_probability !== null, 'implied prob retained');
    // explicit missing model layer + actionable trigger
    assert.ok(r.missing_layers.includes('ceiling_board_composite'));
    assert.match(r.trigger_event, /ceiling board/i);
  }
});

test('NASCAR MARKET_ONLY: compact event-level block, no per-driver dump', () => {
  const packet = buildRacePacket({
    date: '2026-05-31',
    event: nascarEvent(),
    sourcePath: '/tmp/event.json',
    artifacts: [], // no ceiling artifact -> MARKET_ONLY/BLOCKED path
    workspaceResult: null,
  });
  assert.ok(packet, 'packet built');

  // compact block instead of full sectioned board
  assert.match(packet.text, /TLDR BOARD:/);
  assert.match(packet.text, /BLOCKED_MODEL_LAYER_MISSING/);
  assert.match(packet.text, /BLOCKED — MODEL LAYER MISSING/);
  assert.match(packet.text, /NOT IN SCORE/);

  // no per-driver rows in customer packet
  const lines = packet.text.split('\n');
  const blockedRowCount = lines.filter(l => /^#\d+\s+\[BLOCKED\]/.test(l)).length;
  assert.equal(blockedRowCount, 0, 'compact block must not render individual BLOCKED rows');
  assert.ok(!/score=MISSING/.test(packet.text), 'no score=MISSING in customer packet');
  assert.ok(!/Rank reflects market implied only/.test(packet.text), 'no legacy phrase');

  // raw inventory NOT in main packet
  assert.equal(looksLikeRawInventoryDump(packet.text), false);
  // raw inventory lives in its own audit artifact
  assert.ok(looksLikeRawInventoryDump(packet.inventoryText), 'inventory artifact is the raw dump');
  assert.equal(packet.marketCount, 3);
});

test('JOINED packet: real model edge rows with composite scores surface above BLOCKED', () => {
  // Event with ONLY the two modeled drivers -> every market joins the model.
  const ev = nascarEvent({
    markets: nascarEvent().markets.filter((m) =>
      m.yes_sub_title === 'Denny Hamlin' || m.yes_sub_title === 'Kyle Larson'),
  });
  const cb = ceiling();
  const loaded = { candidates: cb.candidates, source: cb.source, lanes: cb.lanes };
  const built = buildNascarRows({ event: ev, ceiling: loaded });
  // No row should be BLOCKED when every driver joined the model.
  const blocked = built.rows.filter((r) => r.edge_status === 'BLOCKED');
  assert.equal(blocked.length, 0, 'fully-joined board has no BLOCKED rows');
  // composite score present on every joined row
  for (const r of built.rows) assert.ok(r.composite_score !== null, 'composite score present');
});

test('loadNascarCeiling ignores artifacts without candidates', () => {
  assert.equal(loadNascarCeiling([]), null);
});

// The real `ceilings[]` board shape (schema nascar_ceiling_board_v1). No market
// price, score, or probability — the board carries lane labels + qualitative
// basis only, so the packet renders user-facing lines without fabricating model
// fields. Written to a temp file so the test is self-contained (the live
// state/nascar/<date> artifacts are gitignored and absent on a clean checkout).
function ceilingBoardV1() {
  return {
    schema_version: 'nascar_ceiling_board_v1',
    mode: 'fixtures-only',
    supported_market_lanes: [
      { market_lane: 'win', lane_type: 'finish_position', source_available: true },
      { market_lane: 'top10', lane_type: 'finish_position', source_available: true },
    ],
    ceilings: [
      {
        driver_id: 'driver-a-11', driver_name: 'Driver A', car_number: 11,
        ceiling_market: 'win', ceiling_label: 'Win', lane_type: 'finish_position',
        basis: 'Composite of starting position 2, practice rank 3, and multi-lap rank 2.',
        pool_entry_reason: 'current_points_top_20',
        override_reasons: ['top5_starting_position', 'top5_practice_speed'],
      },
      {
        driver_id: 'driver-b-24', driver_name: 'Driver B', car_number: 24,
        ceiling_market: 'top10', ceiling_label: 'Top 10', lane_type: 'finish_position',
        basis: 'Composite of starting position 8, practice rank 12, and multi-lap rank 9.',
        pool_entry_reason: 'current_points_top_20', override_reasons: [],
      },
    ],
    field_bucket: {
      bucket_id: 'FIELD', longshot_driver_count: 1, driver_names: ['Driver C'],
      summary: '1 non-active driver(s) collapsed into FIELD longshot bucket; no individual modeling output emitted.',
    },
    user_facing_lines: ['Driver A Win', 'Driver B Top 10'],
  };
}

test('Toyota / Save Mart 350 packet joins the ceiling_board.json shape without fabricating model fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nascar-ceiling-'));
  const ceilingPath = join(dir, 'ceiling_board.json');
  writeFileSync(ceilingPath, JSON.stringify(ceilingBoardV1(), null, 2));

  const loaded = loadNascarCeiling([ceilingPath]);
  assert.ok(loaded, 'real ceiling board must load');
  assert.equal(loaded.source, ceilingPath);
  assert.equal(Array.isArray(loaded.ceilings), true);
  assert.equal(loaded.ceilings.length, 2);

  const event = nascarEvent({
    event_ticker: 'KXNASCARRACE-TOYSM26',
    title: 'Toyota / Save Mart 350 Winner',
  });
  const packet = buildRacePacket({
    date: '2026-06-28',
    event,
    sourcePath: 'state/nascar/2026-06-28/kalshi-events/KXNASCARRACE-TOYSM26.json',
    artifacts: [ceilingPath],
    workspaceResult: null,
  });

  assert.ok(packet.text.includes('CPC Packet: Toyota / Save Mart 350 Winner'));
  assert.ok(packet.text.includes('Driver A Win'));
  assert.ok(packet.text.includes('Driver B Top 10'));
  assert.doesNotMatch(packet.text, /BLOCKED_MODEL_LAYER_MISSING/);
  assert.doesNotMatch(packet.text, /score=|probability=|edge=|odds=|ranking=|confidence=/i);
  assert.doesNotMatch(packet.inventoryText, /score=|probability=|edge=|odds=|ranking=|confidence=/i);
  assert.equal(looksLikeRawInventoryDump(packet.text), false);
  assert.equal(looksLikeRawInventoryDump(packet.inventoryText), true);
  const contract = validateCpcCustomerPacket(packet.text);
  assert.equal(contract.valid, true, contract.errors.join('; '));

  rmSync(dir, { recursive: true, force: true });
});

test('ceiling-only NASCAR packet avoids dry-run chatter and janitor dry-run codes', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-ceiling-only-'));
  const ceilingPath = join(tmpRoot, 'ceiling_board.json');
  const ceilingArtifact = {
    ceilings: [
      {
        driver_name: 'Denny Hamlin',
        ceiling_label: 'Win lane ceiling',
        lane_type: 'win',
        pool_entry_reason: 'top-tier model fit',
        basis: 'composite score',
      },
    ],
    source: ceilingPath,
    userFacingLines: ['- Denny Hamlin win lane ceiling'],
    fieldBucket: { summary: 'field bucket summary' },
  };
  writeFileSync(ceilingPath, `${JSON.stringify(ceilingArtifact, null, 2)}\n`);

  try {
    const packet = buildRacePacket({
      date: '2026-07-05',
      event: nascarEvent({ markets: [] }),
      sourcePath: '/tmp/nascar-event.json',
      artifacts: [ceilingPath],
      workspaceResult: null,
    });

    assert.ok(packet, 'packet built');
    assert.match(packet.text, /source of truth for this packet\./);
    assert.doesNotMatch(packet.text, /\b(would send|dry-run|dry run|no telegram send|preview only)\b/i);

    const validation = validatePacketText(packet.text, {
      packetType: 'nascar-sunday',
      filePath: 'state/packets/2026-07-05/nascar-sunday/x.txt',
    });
    const dryRunErrors = validation.errors.filter((err) =>
      err.code === 'DRY_RUN_CHATTER_PRESENT' || err.code === 'DRY_RUN_ONLY_OUTPUT');
    assert.equal(dryRunErrors.length, 0, dryRunErrors.map((err) => err.code).join(', '));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ceiling-only NASCAR packet clears source-health gate when stale disclosure is present', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-source-health-'));
  const date = '2026-07-05';
  const ceilingPath = join(tmpRoot, 'nascar', date, 'ceiling_board.json');
  const sourceRegistryPath = join(tmpRoot, 'nascar', date, 'source_registry.json');
  const ceilingArtifact = {
    ceilings: [
      {
        driver_name: 'Denny Hamlin',
        ceiling_label: 'Win lane ceiling',
        lane_type: 'win',
        pool_entry_reason: 'top-tier model fit',
        basis: 'composite score',
      },
    ],
    source: ceilingPath,
    userFacingLines: ['- Denny Hamlin win lane ceiling'],
    fieldBucket: { summary: 'field bucket summary' },
  };
  const sourceRegistry = {
    schema_version: 'nascar_source_registry_v1',
    mode: 'fixtures-only',
    checked_at_utc: '2026-02-13T12:00:00.000Z',
    sources: {
      official: {
        status: 'ok',
        record_count: 1,
        errors: [],
      },
    },
  };
  mkdirSync(dirname(ceilingPath), { recursive: true });
  writeFileSync(ceilingPath, `${JSON.stringify(ceilingArtifact, null, 2)}\n`);
  writeFileSync(sourceRegistryPath, `${JSON.stringify(sourceRegistry, null, 2)}\n`);

  try {
    const packet = buildRacePacket({
      date,
      event: nascarEvent({ markets: [] }),
      sourcePath: '/tmp/nascar-event.json',
      artifacts: [ceilingPath],
      workspaceResult: null,
      stateRoot: tmpRoot,
    });

    assert.ok(packet, 'packet built');
    assert.match(packet.text, /cache-only|stale-source|Live fetch unavailable/i);

    const validation = validatePacketText(packet.text, {
      packetType: 'nascar-sunday',
      filePath: 'state/packets/2026-07-05/nascar-sunday/x.txt',
      requireSourceHealth: true,
      date,
      stateRoot: tmpRoot,
      packetText: packet.text,
    });

    const errorCodes = validation.errors.map((err) => err.code);
    const warningCodes = validation.warnings.map((warn) => warn.code);
    assert.notEqual(validation.verdict, 'JANITOR_BLOCKED');
    assert.ok(!errorCodes.includes('FETCH_SOURCE_MISSING'), errorCodes.join(', '));
    assert.ok(!errorCodes.includes('FETCH_SOURCE_STALE'), errorCodes.join(', '));
    assert.ok(warningCodes.includes('FETCH_SOURCE_STALE'), warningCodes.join(', '));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
