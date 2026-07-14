import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mentionCompositeToDecisionRow,
  buildMentionSlatePacket,
  buildMentionCompositeForMarket,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { looksLikeRawInventoryDump } from '../scripts/shared/decision-packet.mjs';

// A Kalshi mention event with per-candidate contracts and live pricing but NO
// source-layer evidence (layer_records absent) -> composite has 0 source layers.
function mentionEvent(overrides = {}) {
  return {
    event_ticker: 'KXLAMAYORADVANCE-TEST',
    title: 'Who will advance in the LA mayoral election?',
    series_ticker: 'KXLAMAYORADVANCE',
    markets: [
      {
        ticker: 'KXLAMAYORADVANCE-TEST-KBAS',
        yes_sub_title: 'Karen Bass',
        title: 'Will Karen Bass qualify for the runoff?',
        yes_bid_dollars: 0.91, yes_ask_dollars: 0.92, last_price_dollars: 0.91,
        volume_fp: 8000, open_interest_fp: 20000,
        rules_primary: 'Resolves YES if Karen Bass advances to the runoff.',
      },
      {
        ticker: 'KXLAMAYORADVANCE-TEST-NRAM',
        yes_sub_title: 'Nithya Raman',
        title: 'Will Nithya Raman qualify for the runoff?',
        yes_bid_dollars: 0.27, yes_ask_dollars: 0.32, last_price_dollars: 0.33,
        volume_fp: 3000, open_interest_fp: 9000,
        rules_primary: 'Resolves YES if Nithya Raman advances to the runoff.',
      },
    ],
    ...overrides,
  };
}

// A composite WITH source-backed layer records (political profile) -> scored,
// not blocked. The layer values feed composite scoring; market price does not.
function scoredComposite() {
  return buildMentionCompositeForMarket({
    legacy: {
      ticker: 'KXTEST-SCORED',
      target_phrase: 'recession',
      mention_profile: 'political_mentions',
      event_context: 'White House press briefing',
      layer_records: {
        baseline_relevance: { present: true, score: 80, source_basis: 'editorial baseline' },
        event_proximity: { present: true, score: 90, source_basis: 'briefing scheduled today' },
        direct_mention_pathway: { present: true, score: 70, source_basis: 'topic on agenda' },
        news_cycle_pressure: { present: true, score: 60, source_basis: 'trending econ headlines' },
        evidence_quality: { present: true, score: 75, source_basis: 'multiple transcripts' },
      },
      market_context: { yes_bid_cents: 40, yes_ask_cents: 44, last_trade_price_cents: 42, volume: 1000, open_interest: 5000 },
    },
  });
}

test('mention composite with zero source layers -> BLOCKED_SOURCE_LAYER_MISSING, market retained', () => {
  const composites = mentionEvent().markets.map((m) =>
    buildMentionCompositeForMarket({ event: mentionEvent(), market: m }));
  for (const c of composites) {
    const row = mentionCompositeToDecisionRow(c);
    assert.equal(row.edge_status, 'BLOCKED');
    assert.match(row.blocker_if_any, /BLOCKED_SOURCE_LAYER_MISSING/);
    // market price retained for edge detection
    assert.ok(row.implied_probability !== null, 'implied prob retained');
    assert.ok(row.market_yes_ask !== null, 'market ask retained');
    // explicit missing source layers + research trigger (not "source_ladder: MISSING")
    assert.ok(row.missing_layers.length > 0, 'missing source layers enumerated');
    assert.match(row.trigger_event, /mentions research/i);
    // composite score is NOT a probability; no fake fair/edge fabricated
    assert.equal(row.composite_score, null);
    assert.equal(row.edge_cents_or_pp, null);
  }
});

test('mention composite WITH source layers -> scored row, not blocked, market separate', () => {
  const row = mentionCompositeToDecisionRow(scoredComposite());
  assert.notEqual(row.edge_status, 'BLOCKED');
  assert.ok(row.composite_score !== null, 'composite score present when layers exist');
  // market price is in its own half and did NOT become the composite score
  assert.notEqual(row.composite_score, row.implied_probability * 100);
  assert.ok(Number(row.layers_present.split('/')[0]) > 0, 'source layers counted');
});

test('mentions slate packet: v2 CPC board, compact customer text, raw inventory audit-only', () => {
  const ev = mentionEvent();
  const composites = ev.markets.map((m) => buildMentionCompositeForMarket({ event: ev, market: m }));
  const packet = buildMentionSlatePacket({
    date: '2026-05-31',
    event: ev,
    composites,
    sourcePath: '/tmp/event.json',
    inventoryPath: 'inv.txt',
  });
  assert.ok(packet, 'packet built');

  // v2 customer sections present; old shared board headings absent.
  assert.match(packet.text, /1\. FAST READ/);
  assert.match(packet.text, /2\. TOP YES CASE/);
  assert.match(packet.text, /Market Context - NOT IN SCORE: display-only context; never a score input\./);
  assert.match(packet.text, /renderer_contract: mentions_customer_packet_v2/);
  assert.doesNotMatch(packet.text, /TLDR BOARD|TOP EDGE CANDIDATES/);

  // Composite score is shown as stacked cards; the board stays numeric and readable.
  assert.match(packet.text, /RESEARCH GAP/);
  assert.match(packet.text, /5\. SOURCE GAPS[\s\S]*2 research gaps remain: Karen Bass, Nithya Raman\./);
  assert.match(packet.text, /8\. FULL STRIKE INVENTORY[\s\S]*Will Karen Bass qualify for the runoff\?/);

  // raw contract inventory is audit-only
  assert.equal(looksLikeRawInventoryDump(packet.text), false);
  assert.ok(looksLikeRawInventoryDump(packet.inventoryText), 'inventory artifact is the raw dump');

  // neutrality statement present
  assert.match(packet.text, /Market Context - NOT IN SCORE: display-only context; never a score input\./);
  assert.equal(packet.counts.total, 2);
  assert.equal(packet.counts.blocked, 2);
});

test('market price never folds into mention composite score', () => {
  const ev1 = mentionEvent();
  const ev2 = mentionEvent({
    markets: mentionEvent().markets.map((m) => ({ ...m, yes_bid_dollars: 0.01, yes_ask_dollars: 0.02, last_price_dollars: 0.01 })),
  });
  const r1 = mentionCompositeToDecisionRow(buildMentionCompositeForMarket({ event: ev1, market: ev1.markets[0] }));
  const r2 = mentionCompositeToDecisionRow(buildMentionCompositeForMarket({ event: ev2, market: ev2.markets[0] }));
  // composite_score identical (both null here — no layers) regardless of price
  assert.equal(r1.composite_score, r2.composite_score);
  // but the market half DID change
  assert.notEqual(r1.market_yes_ask, r2.market_yes_ask);
});

test('stub research quality caps LEAN posture to WATCH', () => {
  const composite = {
    result: {
      _meta: { layers_present: 2, layers_total: 10 },
      posture: 'LEAN',
      composite_score: 70,
      target_mention: 'test-stub',
      top_supporting_layers: [{ category: 'event_proximity' }],
      missing_layers: [],
      market_context: {},
      reasoning_summary: 'test stub cap',
    },
    posture_final: 'LEAN',
    research_quality: 'stub',
  };
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.edge_status, 'WATCH', 'stub research must cap to WATCH');
  assert.equal(row.composite_posture, 'WATCH', 'stub research must cap composite_posture to WATCH');
});

test('stub research quality caps EVIDENCE_LEAN posture to WATCH', () => {
  const composite = {
    result: {
      _meta: { layers_present: 5, layers_total: 10 },
      posture: 'EVIDENCE_LEAN',
      composite_score: 75,
      target_mention: 'test-stub-el',
      top_supporting_layers: [{ category: 'baseline_relevance' }],
      missing_layers: [],
      market_context: {},
      reasoning_summary: 'test stub cap on EVIDENCE_LEAN',
    },
    posture_final: 'EVIDENCE_LEAN',
    research_quality: 'stub',
  };
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.edge_status, 'WATCH', 'stub research must cap EVIDENCE_LEAN to WATCH');
  assert.equal(row.composite_posture, 'WATCH', 'stub research must cap composite_posture from EVIDENCE_LEAN to WATCH');
});

test('source-backed research with real settled comparables preserves EVIDENCE_LEAN posture', () => {
  const composite = {
    result: {
      _meta: { layers_present: 7, layers_total: 10 },
      posture: 'EVIDENCE_LEAN',
      composite_score: 75,
      target_mention: 'test-real',
      top_supporting_layers: [{ category: 'baseline_relevance' }],
      missing_layers: [],
      market_context: {},
      reasoning_summary: 'test source backed preserves EVIDENCE_LEAN',
    },
    posture_final: 'EVIDENCE_LEAN',
    research_quality: 'source_backed',
    kalshi_native_n: 14,
    kalshi_scan_ok: true,
    kalshi_events_scanned: 4,
  };
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.composite_posture, 'EVIDENCE_LEAN', 'source-backed research must preserve EVIDENCE_LEAN composite_posture');
});
