import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSourceLadder,
  applyQualificationCap,
  renderSourceLadder,
  SOURCE_RANK,
  PROFILE_EXPECTED_CATEGORIES,
} from '../scripts/mentions/source-ladder.mjs';
import { buildMentionCompositeForMarket } from '../scripts/packets/generate-mentions-daily.mjs';

// ─── Rank ordering ────────────────────────────────────────────────────────────

test('source rank order: transcripts outrank quotes outrank context outrank prompt outrank filings outrank qual_risk', () => {
  assert(SOURCE_RANK.prior_transcript_word_match < SOURCE_RANK.recent_direct_quote_match);
  assert(SOURCE_RANK.recent_direct_quote_match  < SOURCE_RANK.current_event_context);
  assert(SOURCE_RANK.current_event_context      < SOURCE_RANK.prompt_likelihood);
  assert(SOURCE_RANK.prompt_likelihood          < SOURCE_RANK.formal_document_proxy);
  assert(SOURCE_RANK.formal_document_proxy      < SOURCE_RANK.qualification_risk);
});

test('political profile expects qualification_risk but NOT formal_document_proxy', () => {
  const cats = PROFILE_EXPECTED_CATEGORIES.political_mentions;
  assert(cats.includes('qualification_risk'));
  assert(!cats.includes('formal_document_proxy'));
});

test('earnings profile expects formal_document_proxy (filings/PR allowed as proxy)', () => {
  assert(PROFILE_EXPECTED_CATEGORIES.earnings_mentions.includes('formal_document_proxy'));
});

// ─── Transcripts outrank filings ─────────────────────────────────────────────

test('transcript match outranks filing-only proxy in ranked_evidence', () => {
  const ladder = evaluateSourceLadder({
    profile: 'earnings_mentions',
    inputs: {
      prior_transcript_word_match: { status: 'used', hits: 3, note: 'Q3 call: 3 hits' },
      formal_document_proxy:       { status: 'used', note: '10-K mentions Tailwind' },
    },
  });
  assert.equal(ladder.ranked_evidence[0].category, 'prior_transcript_word_match');
  assert.equal(ladder.ranked_evidence[1].category, 'formal_document_proxy');
});

// ─── Direct quotes can carry signal when transcripts missing ─────────────────

test('recent_direct_quote_match alone can create used evidence when transcripts missing', () => {
  const ladder = evaluateSourceLadder({
    profile: 'political_mentions',
    inputs: {
      recent_direct_quote_match: { status: 'used', note: 'ABC7 5/22 direct quote: "fentanyl"' },
    },
  });
  assert(ladder.used.includes('recent_direct_quote_match'));
  assert(ladder.missing.includes('prior_transcript_word_match'));
  assert.equal(ladder.ranked_evidence.length, 1);
  assert.equal(ladder.ranked_evidence[0].category, 'recent_direct_quote_match');
});

// ─── Current event context populates a layer for new products/events ─────────

test('current_event_context can be the sole used layer (new product release scenario)', () => {
  const ladder = evaluateSourceLadder({
    profile: 'earnings_mentions',
    inputs: {
      current_event_context: { status: 'used', note: 'PowerEdge XE9685L launched 14 days before call' },
    },
  });
  assert(ladder.used.includes('current_event_context'));
  assert.equal(ladder.ranked_evidence[0].category, 'current_event_context');
});

// ─── Qualification risk caps posture ──────────────────────────────────────────

test('high qualification risk caps PICK posture down to WATCH', () => {
  const ladder = evaluateSourceLadder({
    profile: 'political_mentions',
    inputs: {
      prior_transcript_word_match: { status: 'used', hits: 8 },
      qualification_risk:          { status: 'used', note: 'guest not on booked panel', detail: { level: 'high' } },
    },
  });
  assert.equal(ladder.posture_cap, 'WATCH');
  const capped = applyQualificationCap('PICK', ladder);
  assert.equal(capped.posture, 'WATCH');
  assert.equal(capped.capped, true);
  assert.match(capped.cap_reason, /qualification_risk=high/);
});

test('low qualification risk does not cap', () => {
  const ladder = evaluateSourceLadder({
    profile: 'political_mentions',
    inputs: {
      qualification_risk: { status: 'used', note: 'confirmed booked', detail: { level: 'low' } },
    },
  });
  assert.equal(ladder.posture_cap, null);
  const out = applyQualificationCap('EVIDENCE_LEAN', ladder);
  assert.equal(out.posture, 'EVIDENCE_LEAN');
  assert.equal(out.capped, false);
});

test('unknown qualification (no entry) caps to LEAN', () => {
  const ladder = evaluateSourceLadder({
    profile: 'political_mentions',
    inputs: {
      prior_transcript_word_match: { status: 'used', hits: 5 },
    },
  });
  assert.equal(ladder.posture_cap, 'LEAN');
  const out = applyQualificationCap('PICK', ladder);
  assert.equal(out.posture, 'LEAN');
});

// ─── Pricing never enters the ladder ─────────────────────────────────────────

test('throws if ladder input carries yes_bid', () => {
  assert.throws(
    () => evaluateSourceLadder({
      profile: 'earnings_mentions',
      inputs: { prior_transcript_word_match: { status: 'used', yes_bid: 55 } },
    }),
    /forbidden pricing field "yes_bid"/i,
  );
});

test('throws if ladder input carries volume', () => {
  assert.throws(
    () => evaluateSourceLadder({
      profile: 'political_mentions',
      inputs: { current_event_context: { status: 'used', volume: 1000 } },
    }),
    /forbidden pricing field "volume"/i,
  );
});

test('throws if ladder input carries odds', () => {
  assert.throws(
    () => evaluateSourceLadder({
      profile: 'sports_announcer_mentions',
      inputs: { prompt_likelihood: { status: 'used', odds: 0.6 } },
    }),
    /forbidden pricing field "odds"/i,
  );
});

// ─── Missing sources stay explicit ───────────────────────────────────────────

test('all-missing inputs produce one missing entry per expected category', () => {
  const ladder = evaluateSourceLadder({ profile: 'political_mentions', inputs: {} });
  const expected = PROFILE_EXPECTED_CATEGORIES.political_mentions;
  assert.equal(ladder.missing.length, expected.length);
  for (const c of ladder.categories) {
    assert.equal(c.status, 'missing');
    assert(c.note, `category ${c.category} must have explicit missing note (not fabricated)`);
  }
});

// ─── Earnings undercount rule ─────────────────────────────────────────────────

test('earnings: transcript blocked + filing proxy used → filing flips to proxy, transcript surfaces as undercounted', () => {
  const ladder = evaluateSourceLadder({
    profile: 'earnings_mentions',
    inputs: {
      prior_transcript_word_match: { status: 'blocked', note: 'transcript provider returned 403' },
      formal_document_proxy:       { status: 'used', note: '10-K + press release contain Tailwind' },
    },
  });
  const proxyRow = ladder.categories.find(c => c.category === 'formal_document_proxy');
  assert.equal(proxyRow.status, 'proxy');
  assert.match(proxyRow.note, /undercounted/i);
  assert(ladder.proxy.includes('formal_document_proxy'));
  assert(ladder.blocked.includes('prior_transcript_word_match'));
  assert(ladder.undercounted.includes('prior_transcript_word_match'));
});

// ─── Render ───────────────────────────────────────────────────────────────────

test('renderSourceLadder emits SOURCE LADDER section + pricing exclusion line', () => {
  const ladder = evaluateSourceLadder({
    profile: 'political_mentions',
    inputs: {
      prior_transcript_word_match: { status: 'used', hits: 4, note: '4 prior hits' },
      qualification_risk:          { status: 'used', detail: { level: 'low' } },
    },
  });
  const lines = renderSourceLadder(ladder);
  const txt = lines.join('\n');
  assert.match(txt, /SOURCE LADDER/);
  assert.match(txt, /pricing_excluded: true/);
  assert.match(txt, /prior_transcript_word_match/);
  assert.match(txt, /qualification_status/);
});

// ─── Packet integration: market_context carries pricing, ladder excludes it ──

test('buildMentionCompositeForMarket: ladder runs when source_ladder provided on market; pricing stays in market_context only', () => {
  const market = {
    ticker: 'KXTEST-1',
    custom_strike: { Word: 'Tailwind' },
    yes_sub_title: 'Tailwind',
    yes_bid_dollars: '0.55',
    yes_ask_dollars: '0.61',
    volume_fp: '1200',
    open_interest_fp: '500',
    layer_records: {
      historical_tendency: { present: true, score: 75, source_basis: 'closed events 4/6 YES' },
      event_proximity:     { present: true, score: 90, source_basis: 'call today' },
    },
    source_ladder: {
      prior_transcript_word_match: { status: 'used', hits: 4, note: '4 hits in last 4 calls' },
      qualification_risk:          { status: 'used', detail: { level: 'low' } },
    },
  };
  const event = { event_ticker: 'KXTEST', title: 'Dell Earnings Call', sub_title: 'Q4', markets: [market] };
  const out = buildMentionCompositeForMarket({ event, market });
  assert(out.source_ladder, 'source_ladder must be present on output');
  assert(out.source_ladder.used.includes('prior_transcript_word_match'));
  assert.equal(out.source_ladder.pricing_excluded, true);
  // Pricing must live in market_context only
  assert.equal(out.result.market_context.yes_bid_cents, 55);
  for (const cat of out.source_ladder.categories) {
    for (const f of ['yes_bid', 'yes_ask', 'volume', 'open_interest', 'yes_bid_cents', 'yes_ask_cents']) {
      assert(!(f in cat), `ladder category "${cat.category}" must not contain pricing field "${f}"`);
    }
  }
});

test('buildMentionCompositeForMarket: high qualification_risk caps PICK→WATCH posture_final', () => {
  const market = {
    ticker: 'KXTEST-2',
    custom_strike: { Word: 'Fraud' },
    yes_sub_title: 'Fraud',
    yes_bid_dollars: '0.35',
    yes_ask_dollars: '0.59',
    layer_records: {
      historical_tendency:         { present: true, score: 92, source_basis: '5/6 closed YES' },
      event_proximity:             { present: true, score: 97, source_basis: 'tonight 9pm CDT' },
      direct_mention_pathway:      { present: true, score: 88, source_basis: 'signature talking point' },
      news_cycle_pressure:         { present: true, score: 85, source_basis: 'top story this week' },
    },
    source_ladder: {
      prior_transcript_word_match: { status: 'used', hits: 6 },
      recent_direct_quote_match:   { status: 'used', note: 'direct quote 5/22' },
      qualification_risk:          { status: 'used', note: 'guest not on booked panel', detail: { level: 'high' } },
    },
  };
  const event = { event_ticker: 'KXGUTFELDMENTION-26MAY28', title: 'Gutfeld!', sub_title: 'mention', markets: [market] };
  const out = buildMentionCompositeForMarket({ event, market });
  // composite alone should reach EVIDENCE_LEAN or PICK
  assert(['EVIDENCE_LEAN', 'PICK', 'LEAN'].includes(out.result.posture));
  // After ladder cap, must be WATCH
  assert.equal(out.posture_final, 'WATCH');
  assert.match(out.posture_cap_reason, /qualification_risk=high/);
});
