import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveResearchRoute } from '../scripts/mentions/mention-route-resolver.mjs';
import {
  fetchEarningsFamilyHistory,
  familyWordKey,
  resolveEarningsTicker,
} from '../scripts/mentions/earnings-family-history.mjs';
import { normWord } from '../scripts/mentions/mentions-research-perplexity.mjs';
import {
  buildMentionCompositeForMarket,
  buildKalshiEventPacket,
  mentionCompositeToDecisionRow,
  writeKalshiEventPackets,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';
import { validatePacketText } from '../scripts/cron/cpc-packet-janitor.mjs';
import { buildEarningsQuarterLayer } from '../scripts/mentions/earnings-quarter-history.mjs';

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

function fakeFetch({ series, events, fail = false }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      if (fail) return response({}, false, 503);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/series')) return response({ series, cursor: '' });
      if (parsed.pathname.endsWith('/events')) {
        return response({ events: events[parsed.searchParams.get('series_ticker')] ?? [], cursor: '' });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  };
}

const market = (word, result, seriesTicker) => ({
  ticker: `${seriesTicker}-${word}-${result}`,
  series_ticker: seriesTicker,
  yes_sub_title: word,
  result,
  yes_bid: 90,
  yes_ask: 95,
  volume: 999,
});

function event() {
  return {
    event_ticker: 'KXEARNINGSMENTIONJPM-26AUG26',
    series_ticker: 'KXEARNINGSMENTIONJPM',
    title: 'JPMorgan Chase & Co. earnings call',
    sub_title: 'What will JPMorgan mention on its earnings call?',
    event_url: 'https://kalshi.com/events/KXEARNINGSMENTIONJPM-26AUG26',
    event_time_utc: '2026-08-26T15:00:00Z',
    settlement_source_link: 'https://www.jpmorganchase.com/ir/quarterly-earnings',
    research_timestamp: '2026-08-01T00:00:00Z',
  };
}

function familyHistory(stats, scanOk = true, byCompanyWord = null) {
  const crossCompany = Object.fromEntries(
    Object.entries(stats).map(([word, row]) => ['GS', { [word]: { ...row, word } }]),
  );
  return {
    scan_ok: scanOk,
    error: scanOk ? null : 'HTTP 503',
    by_word: stats,
    by_company_word: byCompanyWord ?? crossCompany,
  };
}

function evidenceLine(text) {
  const marker = 'Evidence:\n';
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, 'packet should contain an Evidence line');
  return text.slice(start + marker.length).split('\n\n', 1)[0].replaceAll('\n', ' ');
}

test('JPM, JPMorgan, and JPMorgan Chase & Co. resolve to JPM', () => {
  assert.equal(resolveEarningsTicker(null, 'JPM'), 'JPM');
  assert.equal(resolveEarningsTicker('KXEARNINGSMENTIONJPM', ''), 'JPM');
  assert.equal(resolveEarningsTicker('', 'JPMorgan'), 'JPM');
  assert.equal(resolveEarningsTicker('', 'JPMorgan Chase'), 'JPM');
  assert.equal(resolveEarningsTicker('', 'JPMorgan Chase & Co.'), 'JPM');
  assert.equal(resolveResearchRoute(event()).entity, 'JPM');
  assert.equal(resolveResearchRoute(event(), { rulesSnapshot: { rule_family: 'earnings_call' } }).entity, 'JPM');
});

test('familyWordKey singularizes both scan and market lookup words locally', () => {
  assert.equal(familyWordKey('Tariffs'), 'tariff');
  assert.equal(familyWordKey('tariff'), 'tariff');
  assert.equal(familyWordKey('congress crisis business'), 'congress crisis business');
});

test('shared normWord remains origin/main behavior for non-earnings routes', () => {
  assert.equal(normWord('Congress crisis business tariffs'), 'congress crisis business tariffs');
  assert.equal(normWord('World Cups / MLB'), 'world cups mlb');
});

test('API scan pools settled family words, preserves misses, and writes a price-free cache', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'earnings-family-'));
  const series = [
    { ticker: 'KXEARNINGSMENTIONJPM' },
    { ticker: 'KXEARNINGSMENTIONGS' },
    { ticker: 'KXTRUMPMENTION' },
  ];
  const gsMarkets = [
    ...Array.from({ length: 7 }, () => market('tariffs', 'yes', 'KXEARNINGSMENTIONGS')),
    ...Array.from({ length: 7 }, () => market('tariff', 'no', 'KXEARNINGSMENTIONGS')),
  ];
  const jpmMarkets = [market('tariff', 'yes', 'KXEARNINGSMENTIONJPM'), market('tariff', 'no', 'KXEARNINGSMENTIONJPM')];
  const fake = fakeFetch({ series, events: {
    KXEARNINGSMENTIONJPM: [{ markets: [] }],
    KXEARNINGSMENTIONGS: [{ markets: gsMarkets }],
  }});
  const result = await fetchEarningsFamilyHistory({ fetchImpl: fake.fetchImpl, stateRoot, now: '2026-08-01T00:00:00Z' });
  assert.equal(result.scan_ok, true);
  assert.equal(result.series_scanned, 2);
  assert.equal(result.by_word.tariff.n, 14);
  assert.equal(result.by_word.tariff.hits, 7);
  assert.equal(result.by_word.tariff.misses, 7);
  assert.equal(result.by_company_word.GS.tariff.n, 14);
  const saved = JSON.parse(await readFile(join(stateRoot, 'mentions', 'earnings-family-history.json'), 'utf8'));
  assert.equal(saved.by_word.tariff.word, 'tariff');
  assert.doesNotMatch(JSON.stringify(saved), /price|bid|ask|volume|open_interest|liquidity/i);

  const cached = await fetchEarningsFamilyHistory({
    fetchImpl: async () => { throw new Error('network must not run'); },
    stateRoot,
    now: '2026-08-01T01:00:00Z',
  });
  assert.equal(cached.by_word.tariff.n, 14);
  assert.equal(fake.calls.filter((url) => url.includes('/events')).length, 2);
});

test('failed scan is explicit failure, never a verified zero', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'earnings-family-fail-'));
  const fake = fakeFetch({ series: [], events: {}, fail: true });
  const result = await fetchEarningsFamilyHistory({ fetchImpl: fake.fetchImpl, stateRoot, now: '2026-08-01T00:00:00Z' });
  assert.equal(result.scan_ok, false);
  assert.match(result.error, /HTTP 503/);
  assert.equal(result.settled_markets, 0);
  await assert.rejects(
    () => readFile(join(stateRoot, 'mentions', 'earnings-family-history.json'), 'utf8'),
    { code: 'ENOENT' },
  );
});

test('repeating cursors fail closed at both page and request bounds', async () => {
  const pageRoot = await mkdtemp(join(tmpdir(), 'earnings-family-page-bound-'));
  const pageResult = await fetchEarningsFamilyHistory({
    stateRoot: pageRoot,
    maxPages: 2,
    fetchImpl: async () => response({ series: [], cursor: 'repeat' }),
    now: '2026-08-01T00:00:00Z',
  });
  assert.equal(pageResult.scan_ok, false);
  assert.match(pageResult.error, /max pages/);

  const requestRoot = await mkdtemp(join(tmpdir(), 'earnings-family-request-bound-'));
  const requestResult = await fetchEarningsFamilyHistory({
    stateRoot: requestRoot,
    maxPages: 50,
    maxRequests: 2,
    fetchImpl: async () => response({ series: [], cursor: 'repeat' }),
    now: '2026-08-01T00:00:00Z',
  });
  assert.equal(requestResult.scan_ok, false);
  assert.match(requestResult.error, /max requests/);
});

test('exact series wins without penalty; family n=14 uses 0.30 and keeps 7 misses', () => {
  const composite = buildMentionCompositeForMarket({
    event: event(),
    market: {
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF', yes_sub_title: 'tariff',
      rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
      kalshi_native_n: 2, kalshi_scan_ok: true, blended_pct: 85, research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    },
    earningsFamilyHistory: familyHistory({ tariff: { n: 14, hits: 7, misses: 7 } }),
  });
  assert.equal(composite.earnings_family_history.tier, 'exact_series');
  assert.equal(composite.earnings_family_history.penalty, 0);
  const exact = mentionCompositeToDecisionRow(composite);
  assert.equal(exact.composite_score, composite.result.composite_score);
  // Canonical Pd x Ph x Pe model (term_pd_ph_pe_v1): direct_mention_pathway
  // carries no source_basis/source_path in this fixture, so it is uncited and
  // contributes zero Ph evidence (only cited evidence moves Pd/Ph). The
  // exact-series match itself has no reconstructable hit count (no
  // kalshi_native_pct to back one out of), so the historical prior is
  // honestly "lookup_failed" rather than a fabricated observation. With no
  // usable Ph and no usable history, the composite is null, not a steamrolled
  // opinion score — this is the model refusing to invent a number from an
  // uncited layer plus an unreconstructable match.
  assert.equal(exact.composite_score, null);
  const exactHistoryLayer = composite.result.evidence_ledger.find((row) => row.category === 'historical_tendency');
  assert.equal(exactHistoryLayer.present, false, 'exact-series null hits must not become score 0');
  assert.equal(composite.result.canonical_term_record.historical_status, 'lookup_failed');
  assert.equal(composite.result.canonical_term_record.pd.value, 0.85, 'cited research override still feeds Pd');
  assert.equal(exact.confidence_cap_reason, null);

  const familyComposite = buildMentionCompositeForMarket({
    event: event(),
    market: {
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF', yes_sub_title: 'tariff',
      rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
      kalshi_native_n: 0, kalshi_scan_ok: true, blended_pct: 85, research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    },
    earningsFamilyHistory: familyHistory({ tariff: { n: 14, hits: 7, misses: 7 } }),
  });
  const row = mentionCompositeToDecisionRow(familyComposite);
  assert.equal(familyComposite.earnings_family_history.penalty, 0.30);
  assert.equal(familyComposite.earnings_family_history.hits, 7);
  assert.equal(familyComposite.earnings_family_history.misses, 7);
  assert.equal(familyComposite.earnings_family_history.hit_rate, 0.5);
  // A 50% hit-rate cross-company family sample is the Bayesian historical
  // prior here (7 hits / 14 samples, smoothed toward neutral -> 0.50), and
  // the thin-cap penalty (0.30) leaves a raw score already at the midpoint
  // unchanged: 50 + (50-50)*(1-0.30) = 50. WATCH-tier here is the honest
  // outcome — a mediocre 50% hit-rate sample must never read as STRONG YES.
  assert.equal(familyComposite.result.composite_score, 50);
  assert.equal(row.composite_score, 50);
  assert.ok(row.composite_score < 65, 'mediocre penalized family sample must not reach STRONG YES from the override alone');
  const rendered = buildKalshiEventPacket({
    date: '2026-08-01',
    event: { ...event(), markets: [
      {
        ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF',
        yes_sub_title: 'Tariffs',
        rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
        kalshi_native_n: 0,
        blended_pct: 85,
        research_quality: 'source_backed',
        layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
      },
    ] },
    sourceUrl: '/tmp/earnings.json',
    earningsFamilyHistory: familyHistory({ tariff: { n: 14, hits: 7, misses: 7 } }),
  });
  assert.match(rendered.text, /misses=7/);
  assert.match(rendered.text, /cross-company earnings base rate/);
  assert.match(rendered.text, /same-company settled history absent/);
});

test('family history reaches customer Evidence and SOURCE GAPS with rate and penalty', () => {
  const built = buildKalshiEventPacket({
    date: '2026-08-01',
    event: { ...event(), markets: [{
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF',
      yes_sub_title: 'tariff',
      rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
      kalshi_native_n: 0,
      blended_pct: 85,
      research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    }] },
    sourceUrl: '/tmp/earnings.json',
    earningsFamilyHistory: familyHistory({ tariff: { n: 6, hits: 4, misses: 2 } }),
  });
  const evidence = evidenceLine(built.text);
  assert.equal(evidence, 'current-event context + cross-company earnings family history (no same-company history).');
  assert.notEqual(evidence, 'current-event context.');
  assert.match(built.text, /same-company settled history absent \(n<2\); using cross-company earnings family fallback n=6 hits=4 misses=2 hit_rate=0\.67 penalty=0\.30/);
});

test('exact_series remains comparable same-company history and unpenalized in Evidence', () => {
  const text = renderMentionPacket({
    date: '2026-08-01',
    event: { title: 'JPMorgan earnings call', markets: [] },
    summary: {},
    terms: [{
      full_strike_text: 'tariff',
      short_term: 'tariff',
      cpc_score: 85,
      research_state: 'research-backed',
      evidence_status: 'research-backed',
      bucket: 'research-backed',
      research_reason: 'Current event context supports this term.',
      earnings_family_history: { tier: 'exact_series', n: 2, hits: null, misses: null, hit_rate: null, penalty: 0 },
    }],
  }, { generatedAtUtc: '2026-08-01T00:00:00Z' });
  assert.equal(evidenceLine(text), 'current-event context + comparable history.');
  assert.doesNotMatch(text, /cross-company earnings family history/);
});

test('usable same-company quarter history outranks cross-company family fallback', () => {
  const currentEvent = event();
  const currentMarket = {
    ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF',
    yes_sub_title: 'tariff',
    rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
    kalshi_native_n: 0,
    blended_pct: 85,
    research_quality: 'source_backed',
    layer_records: {
      event_proximity: { present: true, score: 80 },
      direct_mention_pathway: { present: true, score: 80 },
    },
  };
  const sameCompany = buildEarningsQuarterLayer({
    ticker: 'JPM',
    terms: ['tariff'],
    quarters: [
      { quarter: 'Q2', event_date: '2026-06-01', completed: true, outcomes: { tariff: 'no' } },
      { quarter: 'Q1', event_date: '2026-03-01', completed: true, outcomes: { tariff: 'no' } },
    ],
  });
  const composite = buildMentionCompositeForMarket({
    event: currentEvent,
    market: currentMarket,
    earningsQuarterLayer: sameCompany,
    earningsFamilyHistory: familyHistory({ tariff: { n: 6, hits: 6, misses: 0 } }),
  });
  const historyLayer = composite.result.evidence_ledger.find((row) => row.category === 'historical_tendency');
  assert.equal(composite.earnings_family_history.tier, 'exact_series');
  assert.equal(composite.earnings_family_history.n, 2);
  assert.equal(composite.earnings_family_history.penalty, 0);
  assert.equal(historyLayer.value, 0);
  assert.match(historyLayer.source_basis, /earnings history 0\/2/);
});

test('exact same-company settled history outranks family fallback before family layer insertion', () => {
  const currentEvent = event();
  const currentMarket = {
    ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF',
    yes_sub_title: 'tariff',
    rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
    kalshi_native_n: 0,
    blended_pct: 85,
    research_quality: 'source_backed',
    layer_records: {
      event_proximity: { present: true, score: 80 },
      direct_mention_pathway: { present: true, score: 80 },
    },
  };
  const sameCompanyHistory = [
    {
      market_ticker: 'KXEARNINGSMENTIONJPM-26JUN01-TARIFF',
      event_date: '2026-06-01',
      series_ticker: 'KXEARNINGSMENTIONJPM',
      route: 'earnings_call', entity: 'JPM', horizon: 'event',
      strike_term: 'tariff', result: 'no', settlement_result: 'resolved_no',
    },
    {
      market_ticker: 'KXEARNINGSMENTIONJPM-26MAR01-TARIFF',
      event_date: '2026-03-01',
      series_ticker: 'KXEARNINGSMENTIONJPM',
      route: 'earnings_call', entity: 'JPM', horizon: 'event',
      strike_term: 'tariff', result: 'no', settlement_result: 'resolved_no',
    },
  ];
  const composite = buildMentionCompositeForMarket({
    event: currentEvent,
    market: currentMarket,
    historyRecords: sameCompanyHistory,
    earningsFamilyHistory: familyHistory({ tariff: { n: 6, hits: 6, misses: 0 } }),
  });
  const historyLayer = composite.result.evidence_ledger.find((row) => row.category === 'historical_tendency');
  assert.equal(composite.earnings_family_history.tier, 'exact_series');
  assert.equal(composite.earnings_family_history.hits, 0);
  assert.equal(composite.earnings_family_history.misses, 2);
  assert.equal(composite.earnings_family_history.penalty, 0);
  assert.equal(historyLayer.value, 0);
  assert.match(historyLayer.source_basis, /settled history 0\/2/);
});

test('thin family n=3 is penalized and capped; n=1 is no evidence and uses the PR#53 cap', () => {
  const base = (stats) => buildMentionCompositeForMarket({
    event: event(),
    market: {
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-WORD', yes_sub_title: 'word',
      rules_primary: 'Resolves YES if JPMorgan mentions word.',
      kalshi_native_n: 0, kalshi_scan_ok: true, blended_pct: 85, research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    },
    earningsFamilyHistory: familyHistory(stats),
  });
  const thin = mentionCompositeToDecisionRow(base({ word: { n: 3, hits: 3, misses: 0 } }));
  assert.equal(thin.earnings_family_history.penalty, 0.50);
  assert.ok(thin.composite_score <= 64);
  const none = mentionCompositeToDecisionRow(base({ word: { n: 1, hits: 1, misses: 0 } }));
  assert.equal(none.earnings_family_history.tier, 'none');
  assert.ok(none.composite_score <= 64);
});

test('thin family cap recomputes posture, status, confidence, and analysis from capped score', () => {
  const composite = buildMentionCompositeForMarket({
    event: event(),
    market: {
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-WORD', yes_sub_title: 'word',
      rules_primary: 'Resolves YES if JPMorgan mentions word.',
      kalshi_native_n: 0, kalshi_scan_ok: true, blended_pct: 85, research_quality: 'source_backed',
      layer_records: {
        event_proximity: { present: true, score: 80 },
        baseline_relevance: { present: true, score: 80 },
        source_velocity: { present: true, score: 80 },
        direct_mention_pathway: { present: true, score: 80 },
      },
    },
    earningsFamilyHistory: familyHistory({ word: { n: 3, hits: 3, misses: 0 } }),
  });
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.composite_score, 61);
  assert.equal(row.composite_posture, 'LEAN');
  assert.equal(row.edge_status, 'LEAN');
  assert.equal(row.confidence, 'medium');
  assert.match(row.analysis, /CPC YES SCORE: 61\/100.*thin cross-company earnings family sample/i);
  const packet = buildKalshiEventPacket({
    date: '2026-08-01',
    event: { ...event(), markets: [composite.market ?? {
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-WORD',
      yes_sub_title: 'word',
      rules_primary: 'Resolves YES if JPMorgan mentions word.',
      kalshi_native_n: 0,
      blended_pct: 85,
      research_quality: 'source_backed',
      layer_records: {
        event_proximity: { present: true, score: 80 },
        baseline_relevance: { present: true, score: 80 },
        source_velocity: { present: true, score: 80 },
        direct_mention_pathway: { present: true, score: 80 },
      },
    }] },
    sourceUrl: '/tmp/earnings.json',
    earningsFamilyHistory: familyHistory({ word: { n: 3, hits: 3, misses: 0 } }),
  });
  assert.match(packet.text, /#1 word — CPC YES SCORE: 61\/100 — WEAK YES/);
  assert.doesNotMatch(packet.text, /#1 word — CPC YES SCORE: 61\/100 — STRONG YES/);
  assert.equal(packet.compositeSummary.best_score, 61);
  assert.equal(packet.compositeSummary.best_posture, 'LEAN');
});

test('family fallback excludes current company outcomes from the cross-company pool', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'earnings-family-exclusion-'));
  const fake = fakeFetch({
    series: [
      { ticker: 'KXEARNINGSMENTIONJPM' },
      { ticker: 'KXEARNINGSMENTIONGS' },
    ],
    events: {
      KXEARNINGSMENTIONJPM: [{ markets: [market('tariff', 'yes', 'KXEARNINGSMENTIONJPM'), market('tariff', 'no', 'KXEARNINGSMENTIONJPM')] }],
      KXEARNINGSMENTIONGS: [{ markets: [market('tariff', 'yes', 'KXEARNINGSMENTIONGS'), market('tariff', 'yes', 'KXEARNINGSMENTIONGS')] }],
    },
  });
  const history = await fetchEarningsFamilyHistory({ fetchImpl: fake.fetchImpl, stateRoot, now: '2026-08-01T00:00:00Z' });
  const composite = buildMentionCompositeForMarket({
    event: event(),
    market: {
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF',
      yes_sub_title: 'tariff',
      rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
      kalshi_native_n: 0,
      blended_pct: 85,
      research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    },
    earningsFamilyHistory: history,
  });
  assert.equal(fake.calls.filter((url) => url.includes('/series')).length, 1);
  assert.equal(history.by_word.tariff.n, 4);
  assert.equal(history.by_company_word.JPM.tariff.n, 2);
  assert.equal(composite.earnings_family_history.tier, 'earnings_family');
  assert.equal(composite.earnings_family_history.n, 2);
  assert.equal(composite.earnings_family_history.hits, 2);
  assert.equal(composite.earnings_family_history.misses, 0);
});

test('family n<2 remains a source gap and keeps the PR#53 cap in the rendered packet', () => {
  const built = buildKalshiEventPacket({
    date: '2026-08-01',
    event: { ...event(), markets: [{
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-WORD',
      yes_sub_title: 'word',
      rules_primary: 'Resolves YES if JPMorgan mentions word.',
      kalshi_native_n: 0,
      blended_pct: 85,
      research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    }] },
    sourceUrl: '/tmp/earnings.json',
    earningsFamilyHistory: familyHistory({ word: { n: 1, hits: 1, misses: 0 } }),
  });
  assert.match(built.text, /SOURCE GAPS/);
  assert.match(built.text, /no earnings family history with n>=2/);
  assert.match(built.text, /same-company settled history absent/);
  // n<2 family history is treated as no usable comparable (PR#53 cap), so the
  // canonical historical prior sees a verified_zero over a 1-sample window:
  // (0 + 4*0.5) / (1+4) = 0.40 -> score 40. Honest WEAK NO, not a fabricated
  // WEAK YES from the uncited layer/override alone.
  assert.match(built.text, /#1 word — CPC YES SCORE: 40\/100 — WEAK NO/);
});

test('failed family scan renders lookup failure as unavailable, never no history', () => {
  const built = buildKalshiEventPacket({
    date: '2026-08-01',
    event: { ...event(), markets: [{
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFF',
      yes_sub_title: 'tariff',
      rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
      kalshi_native_n: 0,
      blended_pct: 85,
      research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    }] },
    sourceUrl: '/tmp/earnings.json',
    earningsFamilyHistory: familyHistory({}, false),
  });
  // A failed family scan gives a canonical historical_status of 'lookup_failed'
  // (unavailable), not 'verified_zero' or an actual observation. Combined with
  // an uncited direct_mention_pathway layer (no Ph evidence) and no usable
  // history, the canonical model has nothing to score from and this term
  // correctly renders as a research gap rather than a fabricated card — the
  // core honesty fix this rebuild exists for (never invent a score from an
  // override alone when the real evidence channels are absent/failed).
  assert.doesNotMatch(built.text, /comparable history|cross-company earnings family history/i);
  assert.match(built.text, /unavailable/i);
  assert.match(built.text, /lookup failed/i);
  assert.doesNotMatch(built.text, /no history/i);
  assert.match(built.text, /RESEARCH GAP/);
});

test('non-earnings route stays unchanged and does not fetch family history', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'earnings-family-non-earnings-'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    throw new Error('family history must not be fetched');
  };
  const sportsEvent = {
    event_ticker: 'KXWCMENTION-26AUG01',
    series_ticker: 'KXWCMENTION',
    title: 'World Cup broadcast announcers',
    sub_title: 'What will the announcers say?',
    markets: [{
      ticker: 'KXWCMENTION-26AUG01-GOAL',
      yes_sub_title: 'Golazo',
      rules_primary: 'Resolves YES if the announcers say Golazo.',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
      blended_pct: 85,
      research_quality: 'source_backed',
    }],
  };
  const composite = buildMentionCompositeForMarket({
    event: sportsEvent,
    market: sportsEvent.markets[0],
    earningsFamilyHistory: familyHistory({ golazo: { n: 5, hits: 5, misses: 0 } }),
  });
  assert.equal(composite.earnings_family_history, null);
  const baselinePacket = buildKalshiEventPacket({
    date: '2026-08-01',
    event: sportsEvent,
    sourceUrl: '/tmp/sports.json',
  });
  const familyIgnoredPacket = buildKalshiEventPacket({
    date: '2026-08-01',
    event: sportsEvent,
    sourceUrl: '/tmp/sports.json',
    earningsFamilyHistory: familyHistory({ golazo: { n: 6, hits: 4, misses: 2 } }),
  });
  const generatedAtUtc = '2026-08-01T00:00:00Z';
  assert.equal(
    renderMentionPacket(baselinePacket.synthesisInput, { generatedAtUtc }),
    renderMentionPacket(familyIgnoredPacket.synthesisInput, { generatedAtUtc }),
  );
  await writeKalshiEventPackets({
    events: [sportsEvent],
    date: '2026-08-01',
    stateRoot,
    dir: join(stateRoot, 'packets'),
    audit: () => ({ txtPath: null, metaPath: null, chunkCount: 1 }),
    dryRun: true,
    fetchImpl,
  });
  assert.equal(calls.length, 0);
});

test('janitor score-tier consistency holds across the PR#53 boundary sweep', () => {
  const scores = [95, 85, 75, 65, 64, 50, 35, 34, 2];
  for (const score of scores) {
    const text = renderMentionPacket({
      date: '2026-08-01',
      event: { title: 'JPMorgan earnings call', markets: [] },
      summary: {},
      terms: [{
        full_strike_text: `word-${score}`,
        short_term: `word-${score}`,
        cpc_score: score,
        research_state: 'research-backed',
        evidence_status: 'research-backed',
        bucket: 'research-backed',
      }],
    }, { generatedAtUtc: '2026-08-01T00:00:00Z' });
    const check = validatePacketText(text, { packetType: 'mentions-daily' });
    assert.equal(check.errors.some((error) => error.code === 'CONTRADICTORY_SCORE_POSTURE'), false, `score ${score}`);
  }
});

test('earnings pipeline lazily fetches family history once and renders the composite evidence', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'earnings-family-wiring-'));
  const historyMarkets = [market('tariffs', 'yes', 'KXEARNINGSMENTIONGS'), market('tariff', 'no', 'KXEARNINGSMENTIONGS')];
  const fake = fakeFetch({
    series: [{ ticker: 'KXEARNINGSMENTIONGS' }],
    events: { KXEARNINGSMENTIONGS: [{ markets: historyMarkets }] },
  });
  const earningsEvent = {
    ...event(),
    markets: [{
      ticker: 'KXEARNINGSMENTIONJPM-26AUG26-TARIFFS',
      yes_sub_title: 'Tariffs',
      rules_primary: 'Resolves YES if JPMorgan mentions tariff.',
      kalshi_native_n: 0,
      blended_pct: 85,
      research_quality: 'source_backed',
      layer_records: { event_proximity: { present: true, score: 80 }, direct_mention_pathway: { present: true, score: 80 } },
    }],
  };
  const renderedPackets = [];
  const result = await writeKalshiEventPackets({
    events: [
      earningsEvent,
      {
        ...earningsEvent,
        event_ticker: 'KXEARNINGSMENTIONJPM-26AUG27',
        event_time_utc: '2026-08-27T15:00:00Z',
        event_url: 'https://kalshi.com/events/KXEARNINGSMENTIONJPM-26AUG27',
        markets: [{ ...earningsEvent.markets[0], ticker: 'KXEARNINGSMENTIONJPM-26AUG27-TARIFFS' }],
      },
    ],
    date: '2026-08-01',
    stateRoot,
    dir: join(stateRoot, 'packets'),
    audit: (_dir, name, text) => {
      if (name.endsWith('.inventory')) return { txtPath: null, metaPath: null, chunkCount: 1 };
      renderedPackets.push(text);
      return { txtPath: null, metaPath: null, chunkCount: 1 };
    },
    dryRun: true,
    fetchImpl: fake.fetchImpl,
  });
  assert.deepEqual(result.failedTickers, []);
  assert.equal(renderedPackets.length, 2);
  assert.equal(fake.calls.filter((url) => url.includes('/series')).length, 1);
  assert.equal(fake.calls.filter((url) => url.includes('/events')).length, 1);
  assert.match(renderedPackets[0], /earnings_family_history/);
  assert.match(renderedPackets[0], /cross-company earnings base rate/);
  assert.match(renderedPackets[0], /misses=1/);
});
