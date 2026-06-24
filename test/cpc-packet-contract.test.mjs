// CPC Customer Packet Contract tests.
// Validates that every outgoing CPC packet type passes the shared validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCpcCustomerPacket,
  assertCpcPacketValid,
  CPC_CONTRACT_VERSION,
} from '../scripts/packets/lib/cpc-packet-validator.mjs';
import {
  buildRacePacket,
  buildNascarRows,
} from '../scripts/packets/generate-nascar-sunday.mjs';
import {
  buildKalshiEventPacket as buildUfcKalshiPacket,
  buildEmptyPacket as buildUfcEmptyPacket,
  buildUfcProcess,
  weekendDates,
  PACKET_TYPE as UFC_PACKET_TYPE,
} from '../scripts/packets/generate-ufc-weekly.mjs';
import {
  buildMlbSlatePacket,
  mlbPickToDecisionRow,
} from '../scripts/packets/generate-mlb-daily.mjs';
import {
  renderMentionPacket,
  validateRenderedPacket,
  CUSTOMER_RENDERER_ID,
} from '../scripts/mentions/render-mention-packet.mjs';
import { renderWorldCupPacket } from '../scripts/worldcup/lib/packet-renderer.mjs';
import {
  cpcPacketCaption,
  mentionsPacketNotice,
  planDeliveries,
} from '../scripts/packets/send-packets-telegram.mjs';

// --- Shared validator tests ---

test('validator rejects empty text', () => {
  const r = validateCpcCustomerPacket('');
  assert.equal(r.valid, false);
});

test('validator rejects missing CPC Packet: title', () => {
  const text = '=== Some Title ===\ngenerated_utc: now\nNOT IN SCORE\nResearch only. No trades.';
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /CPC Packet:/i.test(e)));
});

test('validator rejects raw inventory dump', () => {
  const text = '=== CPC Packet: Test ===\ngenerated_utc: now\nNOT IN SCORE\nRAW CONTRACT INVENTORY\nResearch only. No trades.';
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /raw inventory/i.test(e)));
});

test('validator rejects "Rank reflects market implied only"', () => {
  const text = '=== CPC Packet: Test ===\ngenerated_utc: now\nNOT IN SCORE\nRank reflects market implied only\nResearch only. No trades.';
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /Rank reflects market implied only/i.test(e)));
});

test('validator rejects missing NOT IN SCORE', () => {
  const text = '=== CPC Packet: Test ===\ngenerated_utc: now\nResearch only. No trades.';
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /NOT IN SCORE/i.test(e)));
});

test('validator accepts a well-formed minimal packet', () => {
  const text = '=== CPC Packet: Test ===\ngenerated_utc: now\nMarket Context — NOT IN SCORE.\nResearch only. No trades.';
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, true, `errors: ${r.errors.join('; ')}`);
});

test('validator rejects ranked non-BLOCKED rows with score=MISSING', () => {
  const text = [
    '=== CPC Packet: Test ===', 'generated_utc: now', 'NOT IN SCORE',
    '#1 [WATCH] TICK :: target',
    '    model: fair=50% score=MISSING posture=WATCH layers=0/4 conf=low',
    'Research only. No trades.',
  ].join('\n');
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /score=MISSING/i.test(e)));
});

test('validator rejects >10 BLOCKED rows with score=MISSING (should compact-block)', () => {
  const textLines = ['=== CPC Packet: Test ===', 'generated_utc: now', 'NOT IN SCORE'];
  for (let i = 1; i <= 15; i++) {
    textLines.push(`#${i} [BLOCKED] TICK${i} :: driver ${i}`);
    textLines.push(`    model: fair=pending score=MISSING posture=NO_CLEAR_PICK layers=0/4 conf=low`);
  }
  textLines.push('Research only. No trades.');
  const r = validateCpcCustomerPacket(textLines.join('\n'));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /BLOCKED rows with score=MISSING/i.test(e)));
});

test('assertCpcPacketValid throws on invalid packet', () => {
  assert.throws(() => assertCpcPacketValid(''), /CPC contract violation/);
});

// --- Mentions v2 passes validator ---

test('mentions v2 rendered packet passes CPC validator', () => {
  const input = {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-06-14',
    event: {
      title: 'Test Event',
      subtitle: null,
      date_time: '2026-06-14T20:00:00Z',
      settlement_source_link: 'https://kalshi.com/events/TEST',
      rules_primary: 'test rules',
    },
    synthesis_rules: {
      output_style: 'concise',
      research_only: true,
      no_trade: true,
      model_written_final_packet_allowed: false,
      use_full_strike_text_only: true,
      market_context_not_in_score: true,
      all_terms_proximity_only: false,
    },
    summary: { market_count: 2, source_backed_count: 1 },
    terms: [
      {
        full_strike_text: 'Test Event -- Alpha',
        short_term: 'Alpha',
        cpc_score: 65,
        bucket: 'most-likely',
        evidence_status: 'source evidence present: transcript, historical_tendency',
        layers_present: ['transcript', 'historical_tendency'],
        composite_posture: 'LEAN',
        missing_research_layers: ['topic_path'],
        upgrade_trigger: 'confirm exact settlement wording',
        market_context: { implied: 0.35, bid_cents: 33, ask_cents: 37, note: 'NOT IN SCORE' },
      },
      {
        full_strike_text: 'Test Event -- Beta',
        short_term: 'Beta',
        cpc_score: 20,
        bucket: 'blocked/no-source',
        evidence_status: 'blocked/no-source',
        layers_present: [],
        composite_posture: 'NO_CLEAR_PICK',
        missing_research_layers: ['transcript', 'historical_tendency', 'topic_path'],
        upgrade_trigger: 'run mentions research',
        market_context: { implied: 0.10, bid_cents: 8, ask_cents: 12, note: 'NOT IN SCORE' },
      },
    ],
    deterministic_provenance_lines: ['research_route: political_speech'],
  };
  const text = renderMentionPacket(input, { generatedAtUtc: '2026-06-14T12:00:00Z', analystTier: 'none' });
  validateRenderedPacket(text, input);
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, true, `mentions v2 failed CPC validator: ${r.errors.join('; ')}`);
});

// --- NASCAR passes validator ---

function nascarEvent(marketCount = 3) {
  const markets = [];
  for (let i = 0; i < marketCount; i++) {
    markets.push({
      ticker: `KXNASCAR-D${i}`,
      yes_sub_title: `Driver ${i}`,
      yes_bid_dollars: 0.05 + i * 0.02,
      yes_ask_dollars: 0.07 + i * 0.02,
      last_price_dollars: 0.06 + i * 0.02,
      volume_fp: 1000,
      open_interest_fp: 2000,
      rules_primary: 'Wins the race',
    });
  }
  return {
    event_ticker: 'KXNASCARRACE-TEST',
    title: 'Michigan 400 Winner',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets,
  };
}

function nascarCeiling() {
  return {
    candidates: [
      {
        driver_name: 'Driver 0',
        composite_score: 78,
        fundamentals_layer_coverage: 4,
        fundamentals_layer_coverage_label: '4/4',
        score_breakdown: { inputs_used: [{ layer: 'speed' }] },
        lanes: { win: { status: 'EVIDENCE_LEAN', narrative: 'Strong form.' } },
      },
    ],
    source: '/tmp/test-ceiling.json',
    lanes: ['win'],
  };
}

test('NASCAR with ceiling model passes CPC validator', () => {
  const packet = buildRacePacket({
    date: '2026-06-14',
    event: nascarEvent(),
    sourcePath: '/tmp/test.json',
    artifacts: [],
    workspaceResult: null,
  });
  const r = validateCpcCustomerPacket(packet.text);
  assert.equal(r.valid, true, `NASCAR JOINED failed: ${r.errors.join('; ')}`);
});

test('NASCAR MARKET_ONLY mode compact-blocks and passes CPC validator', () => {
  const packet = buildRacePacket({
    date: '2026-06-14',
    event: nascarEvent(20),
    sourcePath: '/tmp/test.json',
    artifacts: [],
    workspaceResult: null,
  });
  assert.ok(/BLOCKED_MODEL_LAYER_MISSING/.test(packet.text));
  assert.ok(!/Rank reflects market implied only/.test(packet.text));
  const lines = packet.text.split('\n');
  const blockedRowCount = lines.filter(l => /^#\d+\s+\[BLOCKED\]/.test(l)).length;
  assert.equal(blockedRowCount, 0, 'MARKET_ONLY should not render individual BLOCKED rows');
  const r = validateCpcCustomerPacket(packet.text);
  assert.equal(r.valid, true, `NASCAR MARKET_ONLY failed: ${r.errors.join('; ')}`);
});

test('NASCAR MARKET_ONLY does not contain score=MISSING ranked board', () => {
  const packet = buildRacePacket({
    date: '2026-06-14',
    event: nascarEvent(30),
    sourcePath: '/tmp/test.json',
    artifacts: [],
    workspaceResult: null,
  });
  assert.ok(!/score=MISSING/.test(packet.text));
});

test('NASCAR title includes CPC Packet:', () => {
  const packet = buildRacePacket({
    date: '2026-06-14',
    event: nascarEvent(),
    sourcePath: '/tmp/test.json',
    artifacts: [],
    workspaceResult: null,
  });
  assert.ok(/CPC Packet:/.test(packet.text));
});

// --- UFC passes validator ---

test('UFC Kalshi event packet passes CPC validator', () => {
  const event = {
    event_ticker: 'KXUFC-TEST',
    title: 'UFC 310',
    sub_title: 'Main Card',
    series_ticker: 'KXUFC',
    markets: [
      { ticker: 'KXUFC-TEST-A', title: 'Fighter A', yes_sub_title: 'Fighter A', yes_bid_dollars: 0.60, yes_ask_dollars: 0.62, volume_fp: 500 },
    ],
  };
  const dates = weekendDates('2026-06-14');
  const built = buildUfcKalshiPacket({ event, dates, sourcePath: '/tmp/ufc.json' });
  const r = validateCpcCustomerPacket(built.text);
  assert.equal(r.valid, true, `UFC Kalshi failed: ${r.errors.join('; ')}`);
});

test('UFC empty packet passes CPC validator', () => {
  const dates = weekendDates('2026-06-14');
  const text = buildUfcEmptyPacket('2026-06-14', dates, { ok: true, events: [], error: null });
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, true, `UFC empty failed: ${r.errors.join('; ')}`);
});

test('UFC title includes CPC Packet:', () => {
  const event = {
    event_ticker: 'KXUFC-TEST',
    title: 'UFC 310',
    markets: [],
  };
  const dates = weekendDates('2026-06-14');
  const built = buildUfcKalshiPacket({ event, dates, sourcePath: '/tmp/ufc.json' });
  assert.ok(/CPC Packet:/.test(built.text));
});

test('UFC packet contains NOT IN SCORE', () => {
  const event = {
    event_ticker: 'KXUFC-TEST',
    title: 'UFC 310',
    markets: [],
  };
  const dates = weekendDates('2026-06-14');
  const built = buildUfcKalshiPacket({ event, dates, sourcePath: '/tmp/ufc.json' });
  assert.ok(/NOT IN SCORE/.test(built.text));
});

// --- MLB passes validator ---

test('MLB slate packet passes CPC validator', () => {
  const scoring = {
    picks: [
      {
        market_ticker: 'KXMLB-TEST',
        game: 'NYY at BOS',
        contract_title: 'Yankees Win',
        classification: 'LEAN',
        fair_value: 0.55,
        kalshi_ask: 0.48,
        kalshi_bid: 0.46,
        edge_pp: 7.0,
        gates_passed: ['starters', 'lineups', 'weather'],
        missing_confirmations: [],
        market_lane: 'moneyline',
      },
    ],
    source: '/tmp/picks.json',
    summaryCounts: { lean: 1 },
  };
  const slate = buildMlbSlatePacket({ date: '2026-06-14', scoring });
  assert.ok(slate != null);
  const r = validateCpcCustomerPacket(slate.text);
  assert.equal(r.valid, true, `MLB slate failed: ${r.errors.join('; ')}`);
});

test('MLB slate title includes CPC Packet:', () => {
  const scoring = {
    picks: [
      {
        market_ticker: 'KXMLB-TEST',
        game: 'NYY at BOS',
        classification: 'WATCH_FOR_PRICE',
        fair_value: 0.50,
        kalshi_ask: 0.50,
        edge_pp: 0,
        gates_passed: [],
        missing_confirmations: ['lineup'],
      },
    ],
    source: '/tmp/picks.json',
  };
  const slate = buildMlbSlatePacket({ date: '2026-06-14', scoring });
  assert.ok(/CPC Packet:/.test(slate.text));
});

// --- World Cup passes validator ---

test('World Cup packet passes CPC validator', () => {
  const matches = [{
    match_id: 'WC001',
    home_team: 'Mexico',
    away_team: 'Poland',
    stage: 'group',
    kickoff_utc: '2026-06-14T16:00:00Z',
    lineup_status: 'lineup_pending',
  }];
  const boards = [{
    lanes: [
      {
        lane: 'match_winner',
        label: 'Match Winner',
        recommendation: 'WATCH',
        composite_score_home: 72,
        composite_score_away: 58,
        confidence: 'medium',
        p_home: 0.45,
        p_draw: 0.28,
        p_away: 0.27,
        winner_lean: 'Mexico',
        draw_risk: 'moderate',
        draw_evaluation: 'possible',
        explanation: 'Home advantage, early group match.',
        market_context: null,
      },
    ],
    overall_confidence: 'medium',
    pick_count: 0,
    lean_count: 0,
    watch_count: 1,
    layers_total: 14,
    layers_present_home: 6,
    layers_present_away: 5,
  }];
  const text = renderWorldCupPacket({ matches, boards, meta: { date: '2026-06-14', packet_stage: 'morning_board' } });
  const r = validateCpcCustomerPacket(text);
  assert.equal(r.valid, true, `World Cup failed: ${r.errors.join('; ')}`);
});

test('World Cup title includes CPC Packet:', () => {
  const text = renderWorldCupPacket({
    matches: [],
    boards: [],
    meta: { date: '2026-06-14', packet_stage: 'morning_board' },
  });
  assert.ok(/CPC Packet:/.test(text));
});

// --- No model-written final text ---

test('mentions synthesis prompt throws (model-written layout is disabled)', async () => {
  const { buildMentionsSynthesisPrompt, synthesizeMentionsUserPacket } = await import('../scripts/packets/generate-mentions-daily.mjs');
  assert.throws(() => buildMentionsSynthesisPrompt(), /disabled/);
  await assert.rejects(synthesizeMentionsUserPacket(), /disabled/);
});

// --- Telegram caption format is consistent ---

test('cpcPacketCaption produces uniform format', () => {
  const caption = cpcPacketCaption('=== Captain Mentions — CPC Packet: Trump Rally ===\n...', '2026-06-14-test', 'mentions-daily');
  assert.ok(caption.startsWith('New CPC packet:'));
  assert.ok(caption.endsWith('-- attached .txt'));
});

test('cpcPacketCaption works for non-mentions types', () => {
  const caption = cpcPacketCaption('=== Captain NASCAR — CPC Packet: Michigan 400 ===\n...', '2026-06-14-KXNASCAR', 'nascar-sunday');
  assert.ok(caption.startsWith('New CPC packet:'));
  assert.ok(caption.endsWith('-- attached .txt'));
});

test('cpcPacketCaption prefers event titles over generic packet headers', () => {
  const caption = cpcPacketCaption(
    [
      'Captain MLB — MIL @ ATL Game Board',
      'Milwaukee Brewers at Atlanta Braves',
      'Date: 2026-06-20 | First pitch: MISSING | Venue: MISSING',
      'CPC Packet: Game Board | generated_utc: 2026-06-20T00:00:00Z',
      '',
      'TLDR',
      '  Call: NO CLEAR PICK.',
    ].join('\n'),
    '2026-06-20-KXMLBGAME-26JUN201610MILATL',
    'mlb-daily',
  );
  assert.equal(
    caption,
    'New CPC packet: MIL @ ATL Game Board -- attached .txt',
  );
});

test('cpcPacketCaption keeps Daily Slate Board as a slate caption', () => {
  const caption = cpcPacketCaption(
    [
      'Captain MLB — Daily Slate Board',
      'CPC Packet: Daily Slate Board',
      'date: 2026-06-20',
      'packet_type: mlb-daily',
      'generated_utc: 2026-06-20T00:00:00Z',
    ].join('\n'),
    '2026-06-20-mlb-daily-board',
    'mlb-daily',
  );
  assert.equal(caption, 'New CPC packet: Daily Slate Board -- attached .txt');
});

test('cpcPacketCaption falls back to stem', () => {
  const caption = cpcPacketCaption('', '2026-06-14-my-event', '');
  assert.equal(caption, 'New CPC packet: 2026-06-14-my-event -- attached .txt');
});

test('mentionsPacketNotice wraps cpcPacketCaption', () => {
  const notice = mentionsPacketNotice('', 'test-stem');
  assert.ok(notice.startsWith('New CPC packet:'));
});

// --- Market data remains NOT IN SCORE ---

test('NASCAR JOINED packet contains NOT IN SCORE', () => {
  const packet = buildRacePacket({
    date: '2026-06-14',
    event: nascarEvent(),
    sourcePath: '/tmp/test.json',
    artifacts: [],
    workspaceResult: null,
  });
  assert.ok(/NOT IN SCORE/.test(packet.text));
});

test('NASCAR MARKET_ONLY packet contains NOT IN SCORE', () => {
  const packet = buildRacePacket({
    date: '2026-06-14',
    event: nascarEvent(5),
    sourcePath: '/tmp/test.json',
    artifacts: [],
    workspaceResult: null,
  });
  assert.ok(/NOT IN SCORE/.test(packet.text));
});

// --- Contract version ---

test('CPC contract version is defined', () => {
  assert.equal(CPC_CONTRACT_VERSION, 'cpc_customer_packet_v1');
});
