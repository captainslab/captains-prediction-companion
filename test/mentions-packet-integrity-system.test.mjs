import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCanonicalMentionIdentity,
  validateCanonicalMentionIdentity,
} from '../scripts/mentions/event-integrity.mjs';
import {
  attachMarketSnapshots,
  hashModelDecisionRows,
  validateQuoteSnapshot,
} from '../scripts/mentions/market-snapshot.mjs';
import { resolveResearchRoute } from '../scripts/mentions/mention-route-resolver.mjs';
import { classifyEdnqRisk } from '../scripts/mentions/qualification-risk.mjs';
import {
  buildKalshiEventPacket,
  buildMentionsSynthesisInput,
} from '../scripts/packets/generate-mentions-daily.mjs';
import {
  renderMentionPacket,
  validateRenderedPacket,
} from '../scripts/mentions/render-mention-packet.mjs';

const NOW = '2026-07-14T18:00:00.000Z';

function eventFixture({ ticker, series, title, settlementSource, eventTime, strike }) {
  return {
    event_ticker: ticker,
    series_ticker: series,
    title,
    sub_title: title,
    event_url: `https://kalshi.com/events/${ticker}`,
    event_time: eventTime,
    settlement_sources: [{ url: settlementSource, label: 'authoritative source' }],
    markets: [{
      ticker: `${ticker}-WORD`,
      event_ticker: ticker,
      yes_sub_title: strike,
      title: `${title}: ${strike}`,
      rules_primary: `Resolves YES if the exact form ${strike} is spoken during the covered event.`,
    }],
  };
}

function canonicalFor(date, event) {
  return buildCanonicalMentionIdentity({
    date,
    event,
    generatedUtc: NOW,
    researchTimestamp: '2026-07-14T17:55:00.000Z',
  });
}

function packetInput({ date, event, canonical, route, ticker, strike }) {
  const rows = [{
    market_ticker: ticker,
    side_target: strike,
    composite_score: 61,
    cpc_yes_score: 61,
    composite_posture: 'LEAN',
    edge_status: 'LEAN',
    layers_present: ['current_context'],
    layers_total: 3,
    missing_layers: [],
    confidence: 'medium',
    reason: 'Direct event context supports the exact-string path.',
    research_route: route,
    route_event_format: route,
    research_state: 'research-backed',
    evidence_status: 'research-backed',
    evidence_availability: {
      settled_evidence: { status: 'present', n: 2, hits: 1, misses: 1 },
      transcript_evidence: { status: 'present' },
    },
    canonical_history: {
      evidence_class: 'settled_history',
      status: 'present',
      match_tier: 'exact_event',
      sample_size: 2,
      hits: 1,
      misses: 1,
    },
    research_citations: [event.settlement_sources[0].url],
    is_qualification_term: false,
  }];
  const input = buildMentionsSynthesisInput({
    date,
    event,
    rows,
    compositeSummary: { market_count: 1, source_backed_count: 1, best_score: 61 },
    provenanceLines: ['canonical_history: exact_event status=present n=2 hits=1 misses=1'],
    presentation: { blocked: false, canonical_event: canonical },
  });
  input.canonical_event = canonical;
  input.presentation = { blocked: false, canonical_event: canonical };
  input.research_provenance = { research_route: route, event_format: route };
  return input;
}

const news = eventFixture({
  ticker: 'KXABCNEWS-26JUL14',
  series: 'KXABCNEWS',
  title: 'ABC World News Tonight',
  settlementSource: 'https://abcnews.go.com/US/world-news-tonight',
  eventTime: '2026-07-14T23:30:00.000Z',
  strike: 'World Cup',
});
const hearing = eventFixture({
  ticker: 'KXHOUSESCOTUS-26JUL14',
  series: 'KXHOUSESCOTUS',
  title: 'House Supreme Court budget hearing',
  settlementSource: 'https://www.house.gov/committees/judiciary/hearings',
  eventTime: '2026-07-14T15:00:00.000Z',
  strike: 'budget',
});

test('route identity is isolated for sequential news and hearing events', () => {
  const newsRoute = resolveResearchRoute(news, { now: NOW });
  const hearingRoute = resolveResearchRoute(hearing, { now: NOW });
  assert.equal(newsRoute.route, 'news_broadcast');
  assert.equal(newsRoute.event_format, 'news_broadcast');
  assert.equal(hearingRoute.route, 'debate_hearing');
  assert.equal(hearingRoute.event_format, 'debate_hearing');

  const newsIdentity = canonicalFor('2026-07-14', news);
  const hearingIdentity = canonicalFor('2026-07-14', hearing);
  assert.equal(newsIdentity.kalshi_event_ticker, news.event_ticker);
  assert.equal(hearingIdentity.kalshi_event_ticker, hearing.event_ticker);
  assert.notEqual(newsIdentity.kalshi_event_url, hearingIdentity.kalshi_event_url);
  assert.notEqual(newsIdentity.settlement_source, hearingIdentity.settlement_source);
  assert.equal(newsIdentity.event_time_central.status, 'CONFIRMED');
  assert.equal(hearingIdentity.event_time_central.status, 'CONFIRMED');
  assert.equal(validateCanonicalMentionIdentity(newsIdentity).ok, true);
  assert.equal(validateCanonicalMentionIdentity(hearingIdentity).ok, true);
});

test('settlement source is independent and EDNQ wording is route-specific', () => {
  const newsIdentity = canonicalFor('2026-07-14', news);
  assert.notEqual(newsIdentity.settlement_source, newsIdentity.kalshi_event_url);
  const newsRisk = classifyEdnqRisk({ event: news, researchRoute: 'news_broadcast' });
  const hearingRisk = classifyEdnqRisk({ event: hearing, researchRoute: 'debate_hearing' });
  assert.match(newsRisk.historical_note, /news-broadcast/i);
  assert.doesNotMatch(newsRisk.historical_note, /sports-broadcast|earnings-call/i);
  assert.match(hearingRisk.historical_note, /prior verified EDNQ outcomes|political event/i);
  assert.doesNotMatch(hearingRisk.historical_note, /abcnews\.go\.com/i);
});

test('rendered before/after dry packets preserve identity, score labels, and isolation', () => {
  for (const [event, route, strike, tickerPattern, sportsPattern] of [
    [news, 'news_broadcast', 'World Cup', /KXABCNEWS-26JUL14/, /sports broadcast|announcer|play-by-play/i],
    [hearing, 'debate_hearing', 'budget', /KXHOUSESCOTUS-26JUL14/, /sports broadcast|announcer|play-by-play/i],
  ]) {
    const identity = canonicalFor('2026-07-14', event);
    const input = packetInput({
      date: '2026-07-14', event, canonical: identity, route,
      ticker: event.markets[0].ticker, strike,
    });
    const before = renderMentionPacket(input, { generatedAtUtc: NOW, marketSnapshotUtc: NOW });
    const after = renderMentionPacket(input, {
      generatedAtUtc: NOW,
      marketSnapshotUtc: NOW,
      marketQuotes: [{ ticker: event.markets[0].ticker, yes_bid_cents: 41, yes_ask_cents: 47, captured_at_utc: NOW }],
    });
    validateRenderedPacket(before, input);
    validateRenderedPacket(after, input);
    for (const rendered of [before, after]) {
      assert.match(rendered, new RegExp(`kalshi_event_ticker: ${tickerPattern.source}`));
      assert.ok(rendered.includes(`kalshi_event_url: https://kalshi.com/events/${tickerPattern.source}`));
      assert.ok(rendered.includes(`settlement_source: ${event.settlement_sources[0].url}`));
      assert.match(rendered, /CPC YES SCORE: 61\/100/);
      assert.doesNotMatch(rendered, sportsPattern);
    }
    assert.match(after, /yes_midpoint_cents=44/);
    assert.match(after, /MODEL-MARKET GAP=17/);
    assert.match(before, /quote_status=MIDPOINT_UNAVAILABLE/);
    assert.match(before, /model_hash_unchanged_after_quote_attachment: true/);
    assert.match(after, /model_hash_unchanged_after_quote_attachment: true/);
  }
});

test('unconfirmed event start fails closed even when close/expiration metadata exists', () => {
  const incomplete = {
    ...news,
    event_time: undefined,
    close_time: '2026-07-15T00:00:00.000Z',
    expected_expiration_time: '2026-07-15T01:00:00.000Z',
  };
  const identity = canonicalFor('2026-07-14', incomplete);
  assert.equal(identity.event_time_central.status, 'UNCONFIRMED');
  assert.equal(validateCanonicalMentionIdentity(identity).ok, false);
  const built = buildKalshiEventPacket({ date: '2026-07-14', event: incomplete, sourceUrl: '/tmp/source.json' });
  assert.equal(built.publication_blocked, true);
  assert.match(built.publication_blocker.source_gaps.join('; '), /event start time unconfirmed/i);
});

test('price sweep changes only display snapshots and never model rows or hashes', () => {
  const input = packetInput({
    date: '2026-07-14',
    event: hearing,
    canonical: canonicalFor('2026-07-14', hearing),
    route: 'debate_hearing',
    ticker: hearing.markets[0].ticker,
    strike: 'budget',
  });
  const modelRows = input.terms.map((term) => ({ ...term, market_ticker: term.market_ticker }));
  const baseHash = hashModelDecisionRows(modelRows);
  const modelHashes = new Set();
  for (let cents = 1; cents <= 99; cents += 1) {
    const attached = attachMarketSnapshots({
      modelRows,
      quotes: [{ ticker: hearing.markets[0].ticker, yes_bid_cents: cents, yes_ask_cents: cents, captured_at_utc: NOW }],
      nowUtc: NOW,
    });
    assert.equal(attached.model_hash_before, baseHash);
    assert.equal(attached.model_hash_after, baseHash);
    assert.equal(attached.hash_unchanged, true);
    modelHashes.add(attached.model_hash_after);
  }
  assert.deepEqual([...modelHashes], [baseHash]);
});

test('quote adapter rejects invalid, crossed, stale, and mismatched snapshots', () => {
  const opts = { ticker: 'KXHOUSESCOTUS-26JUL14-WORD', nowUtc: NOW };
  assert.equal(validateQuoteSnapshot({ ticker: opts.ticker, yes_bid_cents: -1, yes_ask_cents: 20, captured_at_utc: NOW }, opts).reason, 'INVALID_QUOTE');
  assert.equal(validateQuoteSnapshot({ ticker: opts.ticker, yes_bid_cents: 30, yes_ask_cents: 20, captured_at_utc: NOW }, opts).reason, 'CROSSED_QUOTE');
  assert.equal(validateQuoteSnapshot({ ticker: opts.ticker, yes_bid_cents: 30, yes_ask_cents: 40, captured_at_utc: '2026-07-01T00:00:00Z' }, opts).reason, 'STALE_QUOTE');
  assert.equal(validateQuoteSnapshot({ ticker: 'OTHER', yes_bid_cents: 30, yes_ask_cents: 40, captured_at_utc: NOW }, opts).reason, 'TICKER_MISMATCH');
  assert.equal(validateQuoteSnapshot({ ticker: opts.ticker, yes_bid_cents: 30, captured_at_utc: NOW }, opts).reason, 'MIDPOINT_UNAVAILABLE');
});

test('scorer and research surfaces have no quote-adapter import path', () => {
  const files = [
    'scripts/mentions/mention-composite-core.mjs',
    'scripts/mentions/mention-route-resolver.mjs',
    'scripts/mentions/settled-history.mjs',
    'scripts/mentions/mentions-research-perplexity.mjs',
    'scripts/mentions/source-research.mjs',
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?:from|import\s*\()[^\n]*market-snapshot/i, file);
  }
});
