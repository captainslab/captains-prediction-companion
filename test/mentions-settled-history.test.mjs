import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HISTORY_FORBIDDEN_FIELDS,
  sanitizeSettledRecord,
  historyStorePath,
  ingestSettledMarkets,
  loadHistory,
  buildHistoryMatch,
  historyToLayerScore,
} from '../scripts/mentions/settled-history.mjs';
import { composeMentionLedger } from '../scripts/mentions/mention-composite-core.mjs';

const FORBIDDEN_SCAN = /"[^"]*(price|bid|ask|volume|liquidity|open_interest)[^"]*"\s*:/i;

function rawMarket(overrides = {}) {
  return {
    ticker: 'KXTRUMPMENTION-26JUN10-TARIFF',
    event_ticker: 'KXTRUMPMENTION-26JUN10',
    series_ticker: 'KXTRUMPMENTION',
    category: 'Politics',
    title: 'Will Trump say tariff during the rally?',
    yes_sub_title: 'tariff',
    close_time: '2026-06-10T23:00:00Z',
    result: 'yes',
    yes_bid: 62,
    yes_ask: 65,
    no_bid: 35,
    no_ask: 38,
    last_price: 63,
    volume: 18234,
    volume_24h: 4021,
    open_interest: 9912,
    liquidity: 120000,
    ...overrides,
  };
}

function rec(overrides = {}) {
  return {
    event_ticker: 'EV-1',
    market_ticker: 'MK-1',
    event_date: '2026-06-01',
    series_ticker: 'SER-A',
    category: 'Politics',
    strike_term: 'tariff',
    result: 'yes',
    route: 'political_mentions',
    entity: 'trump',
    horizon: 'weekly',
    context: 'rally speech',
    ...overrides,
  };
}

test('sanitizeSettledRecord strips pricing fields, keeps result/strike/date', () => {
  const out = sanitizeSettledRecord(rawMarket(), { route: 'political_mentions', entity: 'trump' });

  for (const f of ['yes_bid', 'yes_ask', 'volume', 'open_interest', 'last_price', 'liquidity']) {
    assert.equal(f in out, false, `forbidden field "${f}" leaked`);
  }
  for (const f of HISTORY_FORBIDDEN_FIELDS) {
    assert.equal(f in out, false, `forbidden field "${f}" leaked`);
  }
  assert.equal(out.result, 'yes');
  assert.equal(out.strike_term, 'tariff');
  assert.equal(out.event_date, '2026-06-10T23:00:00Z');
  assert.equal(out.market_ticker, 'KXTRUMPMENTION-26JUN10-TARIFF');
  assert.equal(out.series_ticker, 'KXTRUMPMENTION');
  assert.equal(out.route, 'political_mentions');
  assert.equal(out.entity, 'trump');
});

test('sanitizeSettledRecord throws when a forbidden field is requested explicitly', () => {
  assert.throws(
    () => sanitizeSettledRecord(rawMarket(), { volume: 18234 }),
    /forbidden field "volume"/,
  );
});

test('ingestSettledMarkets writes price-free JSON under <tmp>/mentions/history/', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'settled-history-'));
  const markets = [
    rawMarket(),
    rawMarket({ ticker: 'KXTRUMPMENTION-26JUN03-BORDER', yes_sub_title: 'border', result: 'no', close_time: '2026-06-03T23:00:00Z', title: 'Will Trump say border during the rally?' }),
  ];

  const { stored, path: filePath, records } = await ingestSettledMarkets({
    rawMarkets: markets,
    eventMeta: { route: 'political_mentions', entity: 'trump' },
    stateRoot: tmp,
  });

  assert.equal(stored, 2);
  assert.equal(records.length, 2);
  assert.equal(path.dirname(filePath), historyStorePath(tmp));
  assert.ok(filePath.startsWith(path.join(tmp, 'mentions', 'history')));

  const content = await fs.readFile(filePath, 'utf8');
  assert.equal(FORBIDDEN_SCAN.test(content), false, `forbidden field found in store file: ${content}`);
  assert.doesNotMatch(content, /"(yes_bid|yes_ask|no_bid|no_ask|last_price|volume|volume_24h|open_interest|liquidity)"/);

  // dedupe by market_ticker on re-ingest
  const again = await ingestSettledMarkets({
    rawMarkets: [rawMarket()],
    eventMeta: { route: 'political_mentions', entity: 'trump' },
    stateRoot: tmp,
  });
  assert.equal(again.records.length, 2);

  const loaded = await loadHistory({ stateRoot: tmp });
  assert.equal(loaded.length, 2);
});

test('loadHistory tolerates missing dir', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'settled-history-'));
  assert.deepEqual(await loadHistory({ stateRoot: path.join(tmp, 'nope') }), []);
});

test('buildHistoryMatch prefers exact_horizon over same_family over broader_fallback', () => {
  const records = [
    rec({ market_ticker: 'EXACT-1', entity: 'trump', horizon: 'weekly' }),
    rec({ market_ticker: 'FAM-1', entity: 'trump', horizon: 'daily', series_ticker: 'SER-B' }),
    rec({ market_ticker: 'BROAD-1', entity: 'biden', route: 'political_mentions', horizon: 'daily', series_ticker: 'SER-C' }),
  ];

  const exact = buildHistoryMatch({ records, route: 'political_mentions', entity: 'trump', horizon: 'weekly', seriesTicker: 'SER-A' });
  assert.equal(exact.match_tier, 'exact_horizon');
  assert.equal(exact.match_quality_penalty, 0);

  const family = buildHistoryMatch({
    records: records.slice(1),
    route: 'other_route', entity: 'trump', horizon: 'weekly', seriesTicker: 'SER-X',
  });
  assert.equal(family.match_tier, 'same_family');
  assert.equal(family.match_quality_penalty, 0.15);
  assert.deepEqual(family.source_tickers, ['FAM-1']);

  const broader = buildHistoryMatch({
    records: [rec({ market_ticker: 'BROAD-1', entity: 'biden', horizon: 'weekly', series_ticker: 'SER-C' })],
    route: 'political_mentions', entity: 'trump', horizon: 'weekly', seriesTicker: 'SER-X',
  });
  assert.equal(broader.match_tier, 'broader_fallback');
  assert.equal(broader.match_quality_penalty, 0.30);
});

test('buildHistoryMatch uses most recent 5 of 7, or all 3 of 3', () => {
  const seven = Array.from({ length: 7 }, (_, i) =>
    rec({ market_ticker: `MK-${i}`, event_date: `2026-06-0${i + 1}`, result: 'yes' }));
  const m5 = buildHistoryMatch({ records: seven, route: 'political_mentions', entity: 'trump', horizon: 'weekly' });
  assert.equal(m5.sample_size, 5);
  assert.deepEqual(m5.source_tickers, ['MK-6', 'MK-5', 'MK-4', 'MK-3', 'MK-2']);

  const three = seven.slice(0, 3);
  const m3 = buildHistoryMatch({ records: three, route: 'political_mentions', entity: 'trump', horizon: 'weekly' });
  assert.equal(m3.sample_size, 3);
});

test('buildHistoryMatch records misses: 2 yes + 3 no → hit_rate 0.4', () => {
  const records = [
    rec({ market_ticker: 'A', result: 'yes', event_date: '2026-06-05' }),
    rec({ market_ticker: 'B', result: 'yes', event_date: '2026-06-04' }),
    rec({ market_ticker: 'C', result: 'no', event_date: '2026-06-03' }),
    rec({ market_ticker: 'D', result: 'no', event_date: '2026-06-02' }),
    rec({ market_ticker: 'E', result: 'no', event_date: '2026-06-01' }),
  ];
  const m = buildHistoryMatch({ records, route: 'political_mentions', entity: 'trump', horizon: 'weekly' });
  assert.equal(m.hits, 2);
  assert.equal(m.misses, 3);
  assert.equal(m.hit_rate, 0.4);
});

test('empty history → tier none, hit_rate null; layer score present:false', () => {
  const m = buildHistoryMatch({ records: [], route: 'r', entity: 'e', horizon: 'h' });
  assert.deepEqual(m, {
    match_tier: 'none',
    match_quality_penalty: null,
    sample_size: 0,
    hits: 0,
    misses: 0,
    hit_rate: null,
    source_tickers: [],
  });

  const layer = historyToLayerScore(m);
  assert.equal(layer.present, false);
  assert.equal(layer.missing_note, 'no settled history available');
});

test('historyToLayerScore output passes mention-composite-core pricing guard', () => {
  const m = buildHistoryMatch({
    records: [
      rec({ market_ticker: 'A', result: 'yes' }),
      rec({ market_ticker: 'B', result: 'yes', event_date: '2026-06-02' }),
      rec({ market_ticker: 'C', result: 'no', event_date: '2026-06-03' }),
    ],
    route: 'political_mentions', entity: 'trump', horizon: 'weekly',
  });
  const layer = historyToLayerScore(m);
  assert.equal(layer.present, true);

  // composeMentionLedger runs assertNoPricingInLayer on each layer record;
  // it must not throw for a settled-history layer record.
  const result = composeMentionLedger({
    event: 'Test rally',
    targetMention: 'tariff',
    profile: 'political_mentions',
    layerDefs: [{ key: 'historical_tendency', weight: 1, label: 'Historical tendency' }],
    layerRecords: { historical_tendency: layer },
  });
  assert.equal(result.evidence_ledger[0].present, true);
  assert.equal(result.evidence_ledger[0].value, layer.score);
});

test('penalty math: same_family 1.0 → 85, broader 1.0 → 70', () => {
  assert.equal(historyToLayerScore({
    match_tier: 'same_family', match_quality_penalty: 0.15,
    sample_size: 5, hits: 5, misses: 0, hit_rate: 1.0, source_tickers: [],
  }).score, 85);

  assert.equal(historyToLayerScore({
    match_tier: 'broader_fallback', match_quality_penalty: 0.30,
    sample_size: 5, hits: 5, misses: 0, hit_rate: 1.0, source_tickers: [],
  }).score, 70);

  const exact = historyToLayerScore({
    match_tier: 'exact_horizon', match_quality_penalty: 0,
    sample_size: 5, hits: 4, misses: 1, hit_rate: 0.8, source_tickers: [],
  });
  assert.equal(exact.score, 80);
  assert.match(exact.source_basis, /settled history 4\/5 hits, tier=exact_horizon/);
});
