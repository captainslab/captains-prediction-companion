import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildNascarRows,
  buildRacePacket,
  loadNascarCeiling,
} from '../scripts/packets/generate-nascar-sunday.mjs';
import { evaluateNascarRaceReadiness } from '../scripts/nascar/lib/race-quality-gate.mjs';
import { validatePacketText } from '../scripts/cron/cpc-packet-janitor.mjs';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';
import { looksLikeRawInventoryDump } from '../scripts/shared/decision-packet.mjs';
import { deliverDocumentEntry } from '../scripts/packets/send-packets-telegram.mjs';

// A minimal Kalshi NASCAR win-market event: per-driver binary contracts keyed
// by yes_sub_title. Prices in dollars (Kalshi public listing shape).
function nascarEvent(overrides = {}) {
  return {
    event_ticker: 'KXNASCARRACE-TEST26',
    title: 'Test 400 Winner',
    venue: 'Test Speedway',
    scheduled_start_utc: '2026-07-05T19:00:00.000Z',
    product_metadata: {
      competition: 'NASCAR Cup Series',
      race_name: 'Test 400',
      track: 'Test Speedway',
      scheduled_start_utc: '2026-07-05T19:00:00.000Z',
      date: '2026-07-05',
    },
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

function fullFieldDrivers(count = 38) {
  return Array.from({ length: count }, (_, idx) => `Driver ${String(idx + 1).padStart(2, '0')}`);
}

const OFFICIAL_DRIVERS = [
  'Ryan Blaney', 'Joey Logano', 'Kyle Larson', 'Austin Dillon', 'Daniel Suarez',
  'Alex Bowman', 'Chase Elliott', 'Austin Cindric', 'Ross Chastain', 'Brad Keselowski',
  'Erik Jones', 'Shane Van Gisbergen', 'Chris Buescher', 'Carson Hocevar', 'Ricky Stenhouse Jr',
  'Ty Dillon', 'Josh Berry', 'Michael McDowell', 'Ryan Preece', 'Chase Briscoe',
  'Todd Gilliland', 'Bubba Wallace', 'Ty Gibbs', 'John Nemechek', 'Connor Zilisch',
  'William Byron', 'AJ Allmendinger', 'Denny Hamlin', 'Riley Herbst', 'Austin Hill',
  'Tyler Reddick', 'Christopher Bell', 'Cole Custer', 'Zane Smith', 'Cody Ware',
  'Noah Gragson', 'BJ McLeod', 'Chad Finchum',
];

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

const READY_TS = '2026-07-05T12:00:00.000Z';

function liveResearchFixture() {
  return {
    generated_utc: READY_TS,
    event_ticker: 'KXNASCARRACE-TEST26',
    model: 'sonar',
    source_urls: [{ url: 'https://www.nascar.com/schedule', title: 'NASCAR schedule' }],
    layers: {
      race_event_identity: { status: 'ok', notes: 'Test 400 at Test Speedway.', sources: [], fetched_utc: READY_TS },
      entry_list_drivers: { status: 'ok', notes: 'Hamlin, Larson, and Bell are entered.', sources: [], fetched_utc: READY_TS },
      qualifying_starting_order: { status: 'ok', notes: 'Final order is posted.', sources: [], fetched_utc: READY_TS },
      practice_speed: { status: 'ok', notes: 'Practice complete.', sources: [], fetched_utc: READY_TS },
      recent_driver_form: { status: 'ok', notes: 'Recent form complete.', sources: [], fetched_utc: READY_TS },
      track_history_gen7_comparables: { status: 'ok', notes: 'Track history complete.', sources: [], fetched_utc: READY_TS },
      team_manufacturer_notes: { status: 'ok', notes: 'Team notes complete.', sources: [], fetched_utc: READY_TS },
      penalties_inspection_news: { status: 'ok', notes: 'No penalties.', sources: [], fetched_utc: READY_TS },
      weather_track_condition: { status: 'ok', notes: 'Dry track.', sources: [], fetched_utc: READY_TS },
    },
    drivers: [],
  };
}

function writeRaceQualityState(tmpRoot, date, drivers = ['Denny Hamlin', 'Kyle Larson', 'Christopher Bell']) {
  const root = join(tmpRoot, 'nascar', date);
  const discoveryDir = join(root, 'discovery');
  mkdirSync(discoveryDir, { recursive: true });
  const sourceRegistry = {
    schema_version: 'nascar_source_registry_v1',
    checked_at_utc: READY_TS,
    sources: { nascar_official: { source_id: 'nascar_official', checked_at_utc: READY_TS } },
  };
  const discovery = { schema_version: 'nascar_discovery_v1', checked_at_utc: READY_TS };
  const official = {
    source_id: 'nascar_official',
    status: 'ok',
    checked_at_utc: READY_TS,
    records: [
      {
        race_id: 901,
        track_id: 44,
        series_id: 1,
        race_name: 'Test 400',
        track: 'Test Speedway',
        scheduled_start_utc: '2026-07-05T19:00:00.000Z',
        source_urls: [
          'https://cf.nascar.com/cacher/2026/race_list_basic.json',
          'https://cf.nascar.com/cacher/2026/1/901/weekend-feed.json',
        ],
      },
    ],
  };
  const activeField = {
    source_id: 'active_field_pool',
    status: 'ok',
    checked_at_utc: READY_TS,
    records: drivers.map((driver_name, idx) => ({ driver_name, race_id: 901, track_id: 44, starting_grid_position: idx + 1 })),
  };
  const practice = {
    source_id: 'practice_qualifying',
    status: 'ok',
    checked_at_utc: READY_TS,
    records: drivers.map((driver_name, idx) => ({ driver_name, race_id: 901, effective_race_start: idx + 1 })),
  };
  writeFileSync(join(root, 'source_registry.json'), `${JSON.stringify(sourceRegistry, null, 2)}\n`);
  writeFileSync(join(root, 'discovery.json'), `${JSON.stringify(discovery, null, 2)}\n`);
  writeFileSync(join(discoveryDir, 'nascar_official_adapter.json'), `${JSON.stringify(official, null, 2)}\n`);
  writeFileSync(join(discoveryDir, 'active_field_pool_adapter.json'), `${JSON.stringify(activeField, null, 2)}\n`);
  writeFileSync(join(discoveryDir, 'practice_qualifying_adapter.json'), `${JSON.stringify(practice, null, 2)}\n`);
  writeFileSync(join(root, 'live-research.json'), `${JSON.stringify(liveResearchFixture(), null, 2)}\n`);
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

test('NASCAR MARKET_ONLY: generator marks packet as BLOCKED_PACKET_INCOMPLETE', () => {
  const packet = buildRacePacket({
    date: '2026-05-31',
    event: nascarEvent(),
    sourcePath: '/tmp/event.json',
    artifacts: [], // no ceiling artifact -> MARKET_ONLY/BLOCKED path
    workspaceResult: null,
    nowMs: Date.parse('2026-05-31T12:00:00.000Z'),
  });
  assert.ok(packet, 'packet built');

  assert.match(packet.text, /BLOCKED_PACKET_INCOMPLETE/);
  const validation = validatePacketText(packet.text, {
    packetType: 'nascar-sunday',
    filePath: 'state/packets/2026-05-31/nascar-sunday/x.txt',
  });
  assert.equal(validation.verdict, 'JANITOR_BLOCKED');
  assert.ok(validation.errors.some((error) => error.code === 'BLOCKED_PACKET_INCOMPLETE'));
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

test('ready NASCAR packet renders required sections and passes both validators', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nascar-ceiling-'));
  const date = '2026-07-05';
  const ceilingPath = join(dir, 'ceiling_board.json');
  writeRaceQualityState(dir, date);
  writeFileSync(ceilingPath, JSON.stringify({
    candidates: [
      {
        driver_name: 'Denny Hamlin',
        composite_score: 78,
        fundamentals_layer_coverage: 4,
        fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'practice_speed' }] },
        lanes: { win: { status: 'EVIDENCE_LEAN', narrative: 'Best full-field profile.' } },
      },
      {
        driver_name: 'Kyle Larson',
        composite_score: 69,
        fundamentals_layer_coverage: 4,
        fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'track_history' }] },
        lanes: { win: { status: 'LEAN', narrative: 'Strong but not top profile.' } },
      },
      {
        driver_name: 'Christopher Bell',
        composite_score: 58,
        fundamentals_layer_coverage: 4,
        fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'recent_form' }] },
        lanes: { win: { status: 'WATCH', narrative: 'Live if pace upgrades.' } },
      },
    ],
    source: ceilingPath,
    lanes: ['win'],
  }, null, 2));

  const event = nascarEvent({
    event_ticker: 'KXNASCARRACE-TOYSM26',
    title: 'Test 400 Winner',
  });
  const packet = buildRacePacket({
    date,
    event,
    sourcePath: `state/nascar/${date}/kalshi-events/KXNASCARRACE-TOYSM26.json`,
    artifacts: [ceilingPath],
    workspaceResult: null,
    stateRoot: dir,
    liveResearch: { ...liveResearchFixture(), event_ticker: 'KXNASCARRACE-TOYSM26' },
    nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
  });

  assert.ok(packet.text.includes('CPC Packet: Test 400 Winner'));
  assert.doesNotMatch(packet.text, /BLOCKED_PACKET_INCOMPLETE/);
  for (const section of ['FULL FIELD', 'STRONGEST', 'SECONDARY', 'LONGSHOTS', 'FADES', 'EVIDENCE', 'CONFIDENCE', 'LIMITS']) {
    assert.match(packet.text, new RegExp(section));
  }
  assert.match(packet.text, /Market Context - NOT IN SCORE/);
  assert.doesNotMatch(packet.text, /yes_bid|yes_ask|last=|bid=|ask=|implied=/i);
  assert.match(packet.inventoryText, /ask=0\./i);
  assert.equal(looksLikeRawInventoryDump(packet.text), false);
  assert.equal(looksLikeRawInventoryDump(packet.inventoryText), true);
  const contract = validateCpcCustomerPacket(packet.text);
  assert.equal(contract.valid, true, contract.errors.join('; '));
  const janitor = validatePacketText(packet.text, {
    packetType: 'nascar-sunday',
    filePath: `state/packets/${date}/nascar-sunday/x.txt`,
  });
  assert.equal(janitor.verdict, 'SEND_ALLOWED');

  rmSync(dir, { recursive: true, force: true });
});

test('sender refuses BLOCKED_PACKET_INCOMPLETE before janitor, Telegram, or ledger write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nascar-send-refusal-'));
  const name = '2026-07-05-KXNASCARRACE-TEST26';
  const filePath = join(dir, `${name}.txt`);
  writeFileSync(filePath, [
    '=== Captain NASCAR — CPC Packet: Test 400 Winner ===',
    'date: 2026-07-05',
    'packet_type: nascar-sunday',
    'generated_utc: 2026-07-05T12:00:00.000Z',
    '',
    'TLDR BOARD:',
    '  BLOCKED_PACKET_INCOMPLETE',
  ].join('\n'));
  const ledger = { delivered: {} };
  let touched = false;
  const outcome = await deliverDocumentEntry({
    entry: { name, files: [`${name}.txt`] },
    dir,
    packetType: 'nascar-sunday',
    date: '2026-07-05',
    stateRoot: 'state',
    ledgerPath: join(dir, '.delivery-ledger.json'),
    ledger,
    force: false,
    dryRun: false,
    inspect: () => { touched = true; throw new Error('janitor should not run'); },
    sendMessage: async () => { touched = true; throw new Error('Telegram should not run'); },
    sendDocument: async () => { touched = true; throw new Error('Telegram should not run'); },
  });
  assert.equal(outcome.status, 'blocked_incomplete');
  assert.equal(touched, false);
  assert.equal(Object.keys(ledger.delivered).length, 0);
  assert.equal(existsSync(join(dir, '.delivery-ledger.json')), false);
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
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
    });

    assert.ok(packet, 'packet built');
    assert.match(packet.text, /BLOCKED_PACKET_INCOMPLETE/);
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
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
    });

    assert.ok(packet, 'packet built');
    assert.match(packet.text, /BLOCKED_PACKET_INCOMPLETE/);

    const validation = validatePacketText(packet.text, {
      packetType: 'nascar-sunday',
      filePath: 'state/packets/2026-07-05/nascar-sunday/x.txt',
      requireSourceHealth: true,
      date,
      stateRoot: tmpRoot,
      packetText: packet.text,
    });

    assert.equal(validation.verdict, 'JANITOR_BLOCKED');
    assert.ok(validation.errors.some((err) => err.code === 'BLOCKED_PACKET_INCOMPLETE'));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('race readiness passes only with a complete 38-driver field, 38 markets, 38 candidates, and all nine live-research layers', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'nascar-race-ready-38-'));
  const date = '2026-07-05';
  const drivers = fullFieldDrivers(38);
  writeRaceQualityState(tmpRoot, date, drivers);

  const event = nascarEvent({
    title: 'Test 400 Winner',
    markets: drivers.map((driver, idx) => ({
      ticker: `KXNASCARRACE-TEST26-${String(idx + 1).padStart(2, '0')}`,
      yes_sub_title: driver,
      yes_bid_dollars: 0.05 + idx * 0.001,
      yes_ask_dollars: 0.06 + idx * 0.001,
      last_price_dollars: 0.055 + idx * 0.001,
      rules_primary: 'Wins the race',
    })),
  });
  const candidateCount = drivers.length;
  const ceiling = {
    candidates: drivers.map((driver, idx) => ({
      driver_name: driver,
      composite_score: candidateCount - idx,
      fundamentals_layer_coverage: 4,
      fundamentals_layer_coverage_label: '4/4 layers',
      score_breakdown: { inputs_used: [{ layer: 'practice_speed' }] },
      lanes: { win: { status: idx < 3 ? 'EVIDENCE_LEAN' : 'WATCH', narrative: `Profile for ${driver}.` } },
    })),
  };

  const quality = evaluateNascarRaceReadiness({
    date,
    event,
    ceiling,
    winMarkets: event.markets.map((market) => ({ ticker: market.ticker, driver_name: market.yes_sub_title })),
    stateRoot: tmpRoot,
    liveResearch: liveResearchFixture(),
    nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
  });

  assert.equal(quality.ok, true, quality.errors.map((error) => error.code).join(', '));
  assert.equal(quality.context.activeFieldCount, 38);

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('race readiness rejects duplicate active-field records instead of set-collapsing them', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'nascar-duplicate-active-'));
  const date = '2026-07-05';
  try {
    writeRaceQualityState(tmpRoot, date);
    const activePath = join(tmpRoot, 'nascar', date, 'discovery', 'active_field_pool_adapter.json');
    const active = JSON.parse(readFileSync(activePath, 'utf8'));
    active.records.push({ ...active.records[0], starting_grid_position: 4 });
    writeFileSync(activePath, `${JSON.stringify(active, null, 2)}\n`);

    const event = nascarEvent();
    const quality = evaluateNascarRaceReadiness({
      date,
      event,
      ceiling: {
        candidates: event.markets.map((market, index) => ({
          driver_name: market.yes_sub_title,
          composite_score: 80 - index,
          lanes: { win: { status: 'WATCH' } },
        })),
      },
      winMarkets: event.markets.map((market) => ({ driver_name: market.yes_sub_title, ticker: market.ticker })),
      stateRoot: tmpRoot,
      liveResearch: liveResearchFixture(),
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
    });

    assert.equal(quality.ok, false);
    assert.ok(quality.errors.some((error) => error.code === 'ACTIVE_FIELD_DRIVER_NAMES_NOT_UNIQUE'));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('38-driver official packet renders all sections and customer bucketing ignores price fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nascar-full-field-'));
  const date = '2026-07-05';
  const ceilingPath = join(dir, 'ceiling_board.json');
  const markets = OFFICIAL_DRIVERS.map((driver_name, idx) => ({
    ticker: `KXNASCARRACE-TEST26-${String(idx + 1).padStart(2, '0')}`,
    yes_sub_title: driver_name,
    yes_bid_dollars: 0.02 + idx / 1000,
    yes_ask_dollars: 0.04 + idx / 1000,
    last_price_dollars: 0.03 + idx / 1000,
    volume_fp: 100 + idx,
    open_interest_fp: 200 + idx,
    rules_primary: 'Wins the race',
  }));
  const event = nascarEvent({ markets });
  const candidates = OFFICIAL_DRIVERS.map((driver_name, idx) => ({
    driver_name,
    composite_score: 100 - idx,
    fundamentals_layer_coverage: 4,
    fundamentals_layer_coverage_label: '4/4 layers',
    score_breakdown: { inputs_used: [{ layer: idx % 2 ? 'track_history' : 'starting_position' }] },
    lanes: { win: { status: idx < 3 ? 'EVIDENCE_LEAN' : (idx < 8 ? 'LEAN' : 'WATCH'), narrative: `Model evidence for ${driver_name}.` } },
  }));
  writeRaceQualityState(dir, date, OFFICIAL_DRIVERS);
  writeFileSync(ceilingPath, `${JSON.stringify({ candidates, source: ceilingPath }, null, 2)}\n`);

  try {
    const common = {
      date,
      event,
      sourcePath: '/tmp/nascar-full-field.json',
      artifacts: [ceilingPath],
      workspaceResult: null,
      stateRoot: dir,
      liveResearch: liveResearchFixture(),
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
    };
    const packet = buildRacePacket(common);
    assert.doesNotMatch(packet.text, /BLOCKED_PACKET_INCOMPLETE/);
    for (const section of ['FULL FIELD', 'STRONGEST', 'SECONDARY', 'LONGSHOTS', 'FADES', 'EVIDENCE', 'CONFIDENCE', 'LIMITS']) {
      assert.match(packet.text, new RegExp(section));
    }
    assert.match(packet.text, /ranked win board \(model-side composite score\)/);
    assert.match(packet.text, /Ryan Blaney/);
    assert.match(packet.text, /Chad Finchum/);
    assert.doesNotMatch(packet.text, /yes_bid|yes_ask|last=|bid=|ask=|implied=|volume[:=]|open_interest/i);
    const fullFieldValidation = validatePacketText(packet.text, {
      packetType: 'nascar-sunday',
      filePath: `${dir}/packets/${date}/nascar-sunday/full.txt`,
      stateRoot: dir,
      documentDelivery: true,
    });
    assert.equal(fullFieldValidation.verdict, 'SEND_ALLOWED', JSON.stringify(fullFieldValidation));

    const strippedEvent = {
      ...event,
      markets: markets.map(({ ticker, yes_sub_title, rules_primary }) => ({ ticker, yes_sub_title, rules_primary })),
    };
    const stripped = buildRacePacket({ ...common, event: strippedEvent });
    const normalizeGenerated = (text) => text.replace(/^generated_utc: .*$/m, 'generated_utc: <normalized>');
    assert.equal(normalizeGenerated(stripped.text), normalizeGenerated(packet.text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sender rejects any NASCAR quality-gate error before callbacks or ledger mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nascar-send-any-gate-error-'));
  const name = '2026-07-05-KXNASCARRACE-BAD';
  writeFileSync(join(dir, `${name}.txt`), [
    '=== Captain NASCAR — CPC Packet: Test 400 Winner ===',
    'date: 2026-07-05',
    'packet_type: nascar-sunday',
    'generated_utc: 2026-07-05T12:00:00.000Z',
    '',
    '=== FULL FIELD ===',
    '=== STRONGEST ===',
    '=== SECONDARY ===',
    '=== LONGSHOTS ===',
    '=== FADES ===',
    '=== EVIDENCE ===',
    '=== CONFIDENCE ===',
    '=== LIMITS ===',
    'yes_ask: 0.20',
  ].join('\n'));
  const ledger = { delivered: {} };
  let callbacks = 0;
  try {
    const outcome = await deliverDocumentEntry({
      entry: { name, files: [`${name}.txt`] },
      dir,
      packetType: 'nascar-sunday',
      date: '2026-07-05',
      stateRoot: dir,
      ledgerPath: join(dir, '.delivery-ledger.json'),
      ledger,
      force: false,
      dryRun: false,
      inspect: () => { callbacks += 1; throw new Error('janitor must not run'); },
      sendMessage: async () => { callbacks += 1; throw new Error('Telegram must not run'); },
      sendDocument: async () => { callbacks += 1; throw new Error('Telegram must not run'); },
    });
    assert.equal(outcome.status, 'blocked_incomplete');
    assert.equal(callbacks, 0);
    assert.deepEqual(ledger.delivered, {});
    assert.equal(existsSync(join(dir, '.delivery-ledger.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
