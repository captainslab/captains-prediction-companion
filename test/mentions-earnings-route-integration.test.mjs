import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildKalshiEventPacket, buildMentionCompositeForMarket } from '../scripts/packets/generate-mentions-daily.mjs';

const NVDA_FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'earnings-history-nvda.json'), 'utf8'));

function nvdaMarket(term, extraLayers = {}) {
  return {
    ticker: `KXNVDAMENTION-26AUG26-${term.toUpperCase()}`,
    title: `Will Nvidia mention ${term}?`,
    yes_sub_title: term,
    no_sub_title: 'No',
    close_time: '2026-08-26T22:00:00Z',
    yes_bid_dollars: '0.50',
    yes_ask_dollars: '0.55',
    last_price_dollars: '0.52',
    volume_fp: '1000',
    rules_primary: `If Nvidia says ${term} during the earnings call, this market resolves Yes.`,
    mention_profile: 'earnings_mentions',
    layer_records: {
      event_proximity: {
        present: true,
        score: 95,
        source_basis: 'official IR calendar confirms Nvidia earnings call',
      },
      ...extraLayers,
    },
  };
}

function nvdaEvent(terms = ['Blackwell', 'China', 'Buyback']) {
  return {
    event_ticker: 'KXNVDAMENTION-26AUG26',
    title: 'What will Nvidia mention on its earnings call?',
    sub_title: 'Nvidia earnings call',
    series_ticker: 'KXNVDAMENTION',
    markets: terms.map((t) => nvdaMarket(t)),
  };
}

const CONTEXT_SOURCES = {
  prior_call_themes: ['Blackwell ramp', 'China export controls'],
  prepared_remarks_summary: 'Blackwell data center growth led the quarter.',
  analyst_qa_topics: ['Blackwell supply', 'China licensing'],
  current_press_release: 'Record data center revenue driven by Blackwell.',
  current_guidance: 'Guidance raised on Blackwell demand.',
  current_preview: 'Focus on Blackwell ramp.',
  known_issues: [],
  current_catalysts: ['Blackwell ramp acceleration', 'new Buyback authorization announced'],
};

function buildNvda({ quarters = NVDA_FIXTURE.quarters, contextSources = null, terms } = {}) {
  return buildKalshiEventPacket({
    date: '2026-08-26',
    event: nvdaEvent(terms),
    sourceUrl: '/tmp/nvda-mentions.json',
    earningsQuarters: quarters,
    earningsContextSources: contextSources,
  });
}

test('earnings_call uses last-four-quarter lookup before source/model extraction', () => {
  const built = buildNvda();
  assert.equal(built.researchProvenance.research_route, 'earnings_call');
  // quarter history fed provenance with no research-supplied historical_tendency
  // and no model extraction involved (pure code path).
  const lfq = built.researchProvenance.last_four_quarter_hit_rate;
  assert.ok(lfq && typeof lfq === 'object');
  assert.ok(lfq.blackwell || lfq.Blackwell);
});

test('exactly 4 completed quarters are used when 5 are available', () => {
  const built = buildNvda();
  // 5 completed quarters in the fixture; exactly the 4 most recent are used
  assert.deepEqual(built.researchProvenance.earnings_quarters_considered, ['FY2027Q1', 'FY2026Q4', 'FY2026Q3', 'FY2026Q2']);
  const lfq = built.researchProvenance.last_four_quarter_hit_rate;
  const blackwell = lfq.blackwell ?? lfq.Blackwell;
  assert.equal(blackwell.sample_size, 4);
});

test('fewer than 4 quarters uses all available and records sample_size', () => {
  const built = buildNvda({ quarters: NVDA_FIXTURE.quarters.slice(0, 2) });
  const lfq = built.researchProvenance.last_four_quarter_hit_rate;
  const blackwell = lfq.blackwell ?? lfq.Blackwell;
  assert.equal(blackwell.sample_size, 2);
});

test('misses are recorded, not ignored', () => {
  const built = buildNvda();
  // china in newest-4: yes, yes, no, yes -> miss kept, hit_rate 0.75
  const lfq = built.researchProvenance.last_four_quarter_hit_rate;
  const china = lfq.china ?? lfq.China;
  assert.equal(china.sample_size, 4);
  assert.ok(Math.abs(china.hit_rate - 0.75) < 1e-9);
  // and the miss is visible in the rendered table
  assert.match(built.text, /MISS/);
});

test('historical/current prices are stripped and cannot score', () => {
  const dirtyQuarters = NVDA_FIXTURE.quarters.map((q) => ({
    ...q,
    last_price_dollars: '0.99',
    yes_bid: 55,
    volume: 12345,
  }));
  const built = buildNvda({ quarters: dirtyQuarters, contextSources: { ...CONTEXT_SOURCES, yes_ask: 61 } });
  const provJson = JSON.stringify(built.researchProvenance);
  assert.doesNotMatch(provJson, /price|yes_bid|yes_ask|volume|liquidity|open_interest/i);
  // earnings provenance block in slate text declares prices excluded
  assert.match(built.text, /earnings_alpha \(route=earnings_call, outcomes only, prices excluded\)/);
});

test('context delta changes posture/layer evidence deterministically', () => {
  const base = buildNvda();
  const withDelta = buildNvda({ contextSources: CONTEXT_SOURCES });
  const again = buildNvda({ contextSources: CONTEXT_SOURCES });
  // deterministic: identical inputs produce identical provenance and identical
  // earnings_alpha block (header carries a generation timestamp, so compare
  // the deterministic parts).
  assert.deepEqual(withDelta.researchProvenance, again.researchProvenance);
  const alphaBlock = (text) => text.split('\n').filter((l) => /earnings_alpha|last_four_quarter|context_delta|posture_adjustment|\| (HIT|MISS|--) /.test(l)).join('\n');
  assert.equal(alphaBlock(withDelta.text), alphaBlock(again.text));
  assert.ok(alphaBlock(withDelta.text).length > 0);

  const adjustments = withDelta.researchProvenance.earnings_posture_adjustments;
  assert.ok(Array.isArray(adjustments) && adjustments.length >= 2);
  const byTicker = Object.fromEntries(adjustments.map((a) => [a.market_ticker, a]));

  // high hit rate (1.00) + strengthening context -> upgrade
  const blackwell = byTicker['KXNVDAMENTION-26AUG26-BLACKWELL'];
  assert.equal(blackwell.direction, 'upgrade');
  assert.ok(blackwell.applied);

  // high hit rate (0.75) + fading context (prior themes only) -> downgrade
  const china = byTicker['KXNVDAMENTION-26AUG26-CHINA'];
  assert.equal(china.direction, 'downgrade');
  assert.ok(china.applied);

  // low hit rate + new catalyst -> upgrade capped at WATCH+/LEAN
  const buyback = byTicker['KXNVDAMENTION-26AUG26-BUYBACK'];
  if (buyback) {
    assert.equal(buyback.direction, 'upgrade_capped');
    assert.ok(['NO_CLEAR_PICK', 'WATCH', 'LEAN'].includes(buyback.to));
  }

  // no context sources -> no adjustments at all
  assert.equal((base.researchProvenance.earnings_posture_adjustments ?? []).length, 0);
});

test('empty quarter history falls back safely without fake conviction', () => {
  const built = buildNvda({ quarters: [] });
  assert.equal(built.researchProvenance.research_route, 'earnings_call');
  assert.equal(built.researchProvenance.last_four_quarter_hit_rate, null);
  assert.equal(built.researchProvenance.earnings_quarters_considered, null);
  assert.doesNotMatch(built.text, /last_four_quarter_history/);
});

test('non-earnings routes never receive earnings layers even when inputs are passed', () => {
  const built = buildKalshiEventPacket({
    date: '2026-06-12',
    event: {
      event_ticker: 'KXTRUMPMENTION-26JUN12',
      title: 'What will Trump say during his rally?',
      sub_title: 'Donald Trump - rally',
      series_ticker: 'KXTRUMPMENTION',
      markets: [{
        ticker: 'KXTRUMPMENTION-26JUN12-BIDE',
        title: 'What will Donald Trump say during the rally?',
        yes_sub_title: 'Biden',
        custom_strike: { Word: 'Biden' },
        rules_primary: 'If Donald Trump says Biden, the market resolves Yes.',
        mention_profile: 'political_mentions',
        layer_records: { event_proximity: { present: true, score: 10, source_basis: 'schedule' } },
      }],
    },
    sourceUrl: '/tmp/trump.json',
    earningsQuarters: NVDA_FIXTURE.quarters,
    earningsContextSources: CONTEXT_SOURCES,
  });
  assert.notEqual(built.researchProvenance.research_route, 'earnings_call');
  assert.equal(built.researchProvenance.last_four_quarter_hit_rate, null);
});

test('quarter layer feeds historical_tendency only when research has not supplied it', () => {
  const event = nvdaEvent(['Blackwell']);
  // research-supplied layer wins
  event.markets[0].layer_records.historical_tendency = {
    present: true,
    score: 42,
    source_basis: 'research-supplied record',
  };
  const composite = buildMentionCompositeForMarket({
    event,
    market: event.markets[0],
    earningsQuarterLayer: null,
    earningsContextDelta: null,
  });
  const ht = composite.result.evidence_ledger.find((row) => row.category === 'historical_tendency');
  assert.equal(ht.value, 42);
});
