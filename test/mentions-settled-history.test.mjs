import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HISTORY_FORBIDDEN_FIELDS,
  assertNoForbiddenFields,
  sanitizeSettledRecord,
  historyStorePath,
  ingestSettledMarkets,
  loadHistory,
  buildHistoryMatch,
  historyToLayerScore,
  joinMentionHistoryCoverage,
  normalizeStrikeKey,
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

test('sanitizeSettledRecord maps result -> settlement_result (yes/no/void/missing)', () => {
  assert.equal(sanitizeSettledRecord(rawMarket({ result: 'yes' })).settlement_result, 'resolved_yes');
  assert.equal(sanitizeSettledRecord(rawMarket({ result: 'no' })).settlement_result, 'resolved_no');
  assert.equal(sanitizeSettledRecord(rawMarket({ result: 'void' })).settlement_result, 'ednq');
  assert.equal(sanitizeSettledRecord(rawMarket({ result: '' })).settlement_result, 'unresolved');

  // result (yes/no/null) compatibility is preserved alongside settlement_result
  const yes = sanitizeSettledRecord(rawMarket({ result: 'yes' }));
  assert.equal(yes.result, 'yes');
  const voided = sanitizeSettledRecord(rawMarket({ result: 'void' }));
  assert.equal(voided.result, null);
});

test('sanitizeSettledRecord honors explicit settlement_result override', () => {
  const out = sanitizeSettledRecord(rawMarket({ result: 'yes' }), { settlement_result: 'ambiguous' });
  assert.equal(out.settlement_result, 'ambiguous');
  assert.equal(out.result, 'yes');
});

test('sanitizeSettledRecord persists optional price-free proof/source/speaker/window fields', () => {
  const out = sanitizeSettledRecord(rawMarket(), {
    route: 'fed_agency',
    market_url: 'https://kalshi.com/markets/KXTRUMPMENTION',
    proof_url: 'https://www.c-span.org/clip/12345',
    proof_source_named: 'C-SPAN',
    eligible_speaker_set: ['Trump', 'Vance'],
    source_scope: 'rally_broadcast',
    event_window_start: '2026-06-10T18:00:00Z',
    event_window_end: '2026-06-10T20:00:00Z',
    speaker: 'Donald Trump',
    rules_snapshot_hash: 'sha256:abc123',
  });
  assert.equal(out.market_url, 'https://kalshi.com/markets/KXTRUMPMENTION');
  assert.equal(out.proof_url, 'https://www.c-span.org/clip/12345');
  assert.equal(out.proof_source_named, 'C-SPAN');
  assert.deepEqual(out.eligible_speaker_set, ['Trump', 'Vance']);
  assert.equal(out.source_scope, 'rally_broadcast');
  assert.equal(out.event_window_start, '2026-06-10T18:00:00Z');
  assert.equal(out.event_window_end, '2026-06-10T20:00:00Z');
  assert.equal(out.speaker, 'Donald Trump');
  assert.equal(out.rules_snapshot_hash, 'sha256:abc123');
});

test('sanitizeSettledRecord strips forbidden pricing fields recursively from nested optional values', () => {
  const out = sanitizeSettledRecord(rawMarket(), {
    eligible_speaker_set: [
      { name: 'Trump', volume: 999, last_price: 50 },
      { name: 'Vance', odds: { yes_bid: 12, open_interest: 7 } },
    ],
    source_scope: { label: 'broadcast', liquidity: 1000, spread: 3 },
  });
  const json = JSON.stringify(out);
  assert.equal(FORBIDDEN_SCAN.test(json), false, `forbidden field survived: ${json}`);
  assert.doesNotMatch(json, /yes_bid|open_interest|last_price|liquidity|"volume"|"spread"/);
  // non-forbidden siblings survive recursive sanitize
  assert.equal(out.eligible_speaker_set[0].name, 'Trump');
  assert.equal(out.eligible_speaker_set[1].name, 'Vance');
  assert.equal(out.source_scope.label, 'broadcast');
  // assertNoForbiddenFields must not throw on the produced record
  assert.doesNotThrow(() => assertNoForbiddenFields(out, 'test record'));
});

test('ingestSettledMarkets output is deterministic except updated_utc timestamp', async () => {
  const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'settled-det-a-'));
  const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'settled-det-b-'));
  const markets = [rawMarket(), rawMarket({ ticker: 'KX-2', result: 'no', yes_sub_title: 'border', title: 'border?' })];
  const meta = { route: 'fed_agency', entity: 'trump', speaker: 'Donald Trump', proof_source_named: 'C-SPAN' };

  const a = await ingestSettledMarkets({ rawMarkets: markets, eventMeta: meta, stateRoot: tmpA });
  const b = await ingestSettledMarkets({ rawMarkets: markets, eventMeta: meta, stateRoot: tmpB });
  assert.deepEqual(a.records, b.records);

  const ca = JSON.parse(await fs.readFile(a.path, 'utf8'));
  const cb = JSON.parse(await fs.readFile(b.path, 'utf8'));
  assert.deepEqual(ca.records, cb.records);
  assert.equal('updated_utc' in ca, true);
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

// --- joinMentionHistoryCoverage (route-neutral history coverage join) -------

// Fixture history records for an earnings-mention series with a prior board.
// event_date is recent relative to the fixed NOW below.
const NOW = '2026-06-15T00:00:00Z';
function hrec(overrides = {}) {
  return {
    market_ticker: 'MK',
    event_ticker: 'KXEARNINGSMENTIONACME-26MAR10',
    series_ticker: 'KXEARNINGSMENTIONACME',
    strike_term: 'tariff',
    settlement_result: 'resolved_yes',
    result: 'yes',
    event_date: '2026-06-10T23:00:00Z',
    route: 'earnings_mentions',
    entity: 'acme',
    horizon: 'event',
    ...overrides,
  };
}

test('normalizeStrikeKey collapses case, slashes, hyphens deterministically', () => {
  assert.equal(normalizeStrikeKey('GLP-1'), 'glp 1');
  assert.equal(normalizeStrikeKey('Tariff'), 'tariff');
  assert.equal(normalizeStrikeKey('  SNAP  '), 'snap');
});

test('joinMentionHistoryCoverage joins resolved_yes/resolved_no history into strike rows', () => {
  const strikes = [
    { ticker: 'T-TARI', strike: 'Tariff' },
    { ticker: 'T-AI', strike: 'AI / Artificial Intelligence' },
  ];
  const history = [
    hrec({ market_ticker: 'A', strike_term: 'tariff', settlement_result: 'resolved_yes', result: 'yes' }),
    hrec({ market_ticker: 'B', strike_term: 'tariff', settlement_result: 'resolved_no', result: 'no' }),
    hrec({ market_ticker: 'C', strike_term: 'Artificial Intelligence', settlement_result: 'resolved_yes', result: 'yes' }),
  ];
  const { rows, summary } = joinMentionHistoryCoverage({ strikes, history, now: NOW });

  const tari = rows.find((r) => r.strike === 'Tariff');
  assert.equal(tari.prior_board_seen, true);
  assert.equal(tari.resolved_yes, 1);
  assert.equal(tari.resolved_no, 1);
  assert.equal(tari.matching_history_count, 2);

  // slash-alternative joins on either side of the "/"
  const ai = rows.find((r) => r.strike === 'AI / Artificial Intelligence');
  assert.equal(ai.prior_board_seen, true);
  assert.equal(ai.resolved_yes, 1);

  assert.equal(summary.history_covered_strikes, 2);
});

test('joinMentionHistoryCoverage: ednq/ambiguous/unresolved do not become confident history', () => {
  const strikes = [{ ticker: 'T-X', strike: 'Buyback' }];
  const history = [
    hrec({ market_ticker: 'A', strike_term: 'buyback', settlement_result: 'ednq', result: null }),
    hrec({ market_ticker: 'B', strike_term: 'buyback', settlement_result: 'ambiguous', result: null }),
    hrec({ market_ticker: 'C', strike_term: 'buyback', settlement_result: 'unresolved', result: null }),
  ];
  const { rows } = joinMentionHistoryCoverage({ strikes, history, now: NOW });
  const x = rows[0];
  assert.equal(x.prior_board_seen, true);
  assert.equal(x.resolved_yes, 0);
  assert.equal(x.resolved_no, 0);
  assert.equal(x.ednq, 1);
  assert.equal(x.ambiguous, 1);
  assert.equal(x.unresolved, 1);
  assert.equal(x.history_status, 'unresolved_only');
  assert.notEqual(x.history_confidence, 'high');
  assert.equal(x.needs_fresh_source_fetch, true); // soft outcomes never confident
});

test('joinMentionHistoryCoverage: fresh resolved history marks needs_fresh_source_fetch=false', () => {
  const strikes = [{ ticker: 'T-TARI', strike: 'Tariff' }];
  const history = [
    hrec({ market_ticker: 'A', strike_term: 'tariff', settlement_result: 'resolved_yes', result: 'yes', event_date: '2026-06-10T00:00:00Z' }),
    hrec({ market_ticker: 'B', strike_term: 'tariff', settlement_result: 'resolved_no', result: 'no', event_date: '2026-06-01T00:00:00Z' }),
  ];
  const { rows } = joinMentionHistoryCoverage({ strikes, history, now: NOW, staleAfterDays: 400 });
  assert.equal(rows[0].history_status, 'resolved_fresh');
  assert.equal(rows[0].history_confidence, 'high');
  assert.equal(rows[0].needs_fresh_source_fetch, false);

  // same records but stale relative to a far-future NOW → fresh fetch required
  const stale = joinMentionHistoryCoverage({ strikes, history, now: '2030-01-01T00:00:00Z', staleAfterDays: 400 });
  assert.equal(stale.rows[0].history_status, 'stale');
  assert.equal(stale.rows[0].needs_fresh_source_fetch, true);
});

test('joinMentionHistoryCoverage: new/no-history strikes still require fresh source fetch', () => {
  const strikes = [
    { ticker: 'T-TARI', strike: 'Tariff' },
    { ticker: 'T-NEW', strike: 'Brand New Topic' },
  ];
  const history = [hrec({ market_ticker: 'A', strike_term: 'tariff', settlement_result: 'resolved_yes', result: 'yes' })];
  const { rows } = joinMentionHistoryCoverage({ strikes, history, now: NOW });
  const fresh = rows.find((r) => r.strike === 'Brand New Topic');
  assert.equal(fresh.prior_board_seen, false);
  assert.equal(fresh.matching_history_count, 0);
  assert.equal(fresh.history_status, 'no_history');
  assert.equal(fresh.needs_fresh_source_fetch, true);
});

test('joinMentionHistoryCoverage: price-like fields in history are never read into coverage rows', () => {
  const strikes = [{ ticker: 'T-TARI', strike: 'Tariff' }];
  // Deliberately dirty fixtures carrying price-shaped keys. The join must never
  // surface them; assertNoForbiddenFields on the output must not throw.
  const history = [
    { ...hrec({ market_ticker: 'A', strike_term: 'tariff', settlement_result: 'resolved_yes', result: 'yes' }), yes_bid: 62, volume: 9000, open_interest: 12, last_price: 63 },
    { ...hrec({ market_ticker: 'B', strike_term: 'tariff', settlement_result: 'resolved_no', result: 'no' }), liquidity: 5000, spread_cents: 2 },
  ];
  const out = joinMentionHistoryCoverage({ strikes, history, now: NOW });
  const json = JSON.stringify(out);
  assert.equal(FORBIDDEN_SCAN.test(json), false, `forbidden field surfaced: ${json}`);
  assert.doesNotMatch(json, /yes_bid|open_interest|last_price|liquidity|"volume"|spread/);
  assert.doesNotThrow(() => assertNoForbiddenFields(out, 'join output'));
  // counts still correct despite dirty input
  assert.equal(out.rows[0].resolved_yes, 1);
  assert.equal(out.rows[0].resolved_no, 1);
});

test('joinMentionHistoryCoverage: non-earnings route metadata passes through without hardwire', () => {
  const strikes = [{ ticker: 'KXTRUMPMENTION-X', strike: 'tariff' }];
  const history = [
    rec({ market_ticker: 'A', strike_term: 'tariff', result: 'yes', settlement_result: 'resolved_yes', route: 'political_mentions', entity: 'trump', horizon: 'weekly', event_date: '2026-06-10' }),
    rec({ market_ticker: 'B', strike_term: 'tariff', result: 'no', settlement_result: 'resolved_no', route: 'political_mentions', entity: 'trump', horizon: 'weekly', event_date: '2026-06-08' }),
  ];
  const { rows } = joinMentionHistoryCoverage({
    strikes, history, route: 'political_mentions', entity: 'trump', horizon: 'weekly', now: NOW,
  });
  assert.equal(rows[0].prior_board_seen, true);
  assert.equal(rows[0].resolved_yes, 1);
  assert.equal(rows[0].resolved_no, 1);
  assert.equal(rows[0].history_status, 'resolved_fresh');
  assert.equal(rows[0].needs_fresh_source_fetch, false);

  // metadata filter excludes records from a different route
  const otherRoute = joinMentionHistoryCoverage({
    strikes, history, route: 'sports_mentions', now: NOW,
  });
  assert.equal(otherRoute.rows[0].prior_board_seen, false);
  assert.equal(otherRoute.rows[0].history_status, 'no_history');
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
