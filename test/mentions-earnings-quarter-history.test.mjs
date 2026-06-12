import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_QUARTERS,
  resolveEarningsFamily,
  sanitizeQuarterRecord,
  earningsHistoryStorePath,
  ingestEarningsQuarters,
  loadEarningsHistory,
  buildEarningsQuarterLayer,
  earningsLayerToHistoricalTendency,
} from '../scripts/mentions/earnings-quarter-history.mjs';
import { composeMentionLedger } from '../scripts/mentions/mention-composite-core.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/earnings-history-nvda.json', import.meta.url));
const FORBIDDEN_SCAN = /"[^"]*(price|bid|ask|volume|liquidity|open_interest)[^"]*"\s*:/i;

async function nvdaFixture() {
  return JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));
}

function rawQuarter(overrides = {}) {
  return {
    quarter: 'FY2027Q1',
    event_ticker: 'KXNVDAMENTION-26MAY28',
    event_date: '2026-05-28T21:00:00Z',
    completed: true,
    outcomes: { blackwell: 'yes', agi: 'no' },
    // pricing junk that must be stripped at ingest
    yes_bid: 62,
    yes_ask: 65,
    last_price: 63,
    volume: 18234,
    open_interest: 9912,
    liquidity: 120000,
    ...overrides,
  };
}

test('resolveEarningsFamily identifies ticker/family from Kalshi-style event titles', () => {
  const byTitle = resolveEarningsFamily({
    event_ticker: 'KXNVDAMENTION-26AUG26',
    series_ticker: 'KXNVDAMENTION',
    title: "What will be said during NVIDIA's Q2 earnings call?",
  });
  assert.deepEqual(byTitle, { company: 'nvidia', ticker: 'NVDA', family: 'nvda_earnings_call' });

  // ticker-only resolution (no company name in the title)
  const byTicker = resolveEarningsFamily({
    event_ticker: 'KXEARNINGSTSLA-26JUL22',
    series_ticker: 'KXEARNINGSTSLA',
    title: 'What will be said on the Q2 earnings call?',
  });
  assert.equal(byTicker.ticker, 'TSLA');
  assert.equal(byTicker.family, 'tsla_earnings_call');

  // GOOGL must not be shadowed by shorter substrings
  const googl = resolveEarningsFamily({
    series_ticker: 'KXGOOGLMENTION',
    title: "Will Alphabet's CEO say it during the earnings call?",
  });
  assert.equal(googl.ticker, 'GOOGL');

  // unknown company → null, no fake family
  assert.equal(resolveEarningsFamily({ title: 'Will the CEO of Acme Corp say synergy?' }), null);
  assert.equal(resolveEarningsFamily(null), null);
});

test('sanitizeQuarterRecord strips pricing fields, keeps outcomes including misses', () => {
  const out = sanitizeQuarterRecord(rawQuarter());
  for (const f of ['yes_bid', 'yes_ask', 'last_price', 'volume', 'open_interest', 'liquidity']) {
    assert.equal(f in out, false, `forbidden field "${f}" leaked`);
  }
  assert.equal(out.quarter, 'FY2027Q1');
  assert.equal(out.completed, true);
  assert.equal(out.outcomes.blackwell, 'yes');
  assert.equal(out.outcomes.agi, 'no'); // miss recorded, not skipped
});

test('ingestEarningsQuarters writes price-free JSON under <tmp>/mentions/earnings-history/', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'earnings-history-'));
  const { stored, path: filePath, quarters } = await ingestEarningsQuarters({
    ticker: 'NVDA',
    rawQuarters: [
      rawQuarter(),
      rawQuarter({ quarter: 'FY2026Q4', event_ticker: 'KXNVDAMENTION-26FEB25', event_date: '2026-02-25T22:00:00Z', outcomes: { blackwell: 'yes', agi: 'no' } }),
    ],
    stateRoot: tmp,
  });

  assert.equal(stored, 2);
  assert.equal(quarters.length, 2);
  assert.equal(path.dirname(filePath), earningsHistoryStorePath(tmp));

  const content = await fs.readFile(filePath, 'utf8');
  assert.equal(FORBIDDEN_SCAN.test(content), false, `forbidden field found in store file: ${content}`);
  assert.doesNotMatch(content, /"(yes_bid|yes_ask|no_bid|no_ask|last_price|volume|volume_24h|open_interest|liquidity)"/);

  // dedupe by quarter id on re-ingest
  const again = await ingestEarningsQuarters({ ticker: 'NVDA', rawQuarters: [rawQuarter()], stateRoot: tmp });
  assert.equal(again.quarters.length, 2);

  const loaded = await loadEarningsHistory({ ticker: 'NVDA', stateRoot: tmp });
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].quarter, 'FY2027Q1'); // newest first
});

test('loadEarningsHistory tolerates missing store and filters incomplete quarters', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'earnings-history-'));
  assert.deepEqual(await loadEarningsHistory({ ticker: 'NVDA', stateRoot: tmp }), []);

  await ingestEarningsQuarters({
    ticker: 'NVDA',
    rawQuarters: [rawQuarter(), rawQuarter({ quarter: 'FY2027Q2', event_date: '2026-08-26T21:00:00Z', completed: false })],
    stateRoot: tmp,
  });
  const loaded = await loadEarningsHistory({ ticker: 'NVDA', stateRoot: tmp });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].quarter, 'FY2027Q1');
});

test('exactly 4 most recent quarters used when 5 are available', async () => {
  const fx = await nvdaFixture();
  const layer = buildEarningsQuarterLayer({
    family: 'nvda_earnings_call',
    ticker: 'NVDA',
    terms: ['blackwell', 'agi', 'china'],
    quarters: fx.quarters,
  });

  assert.equal(layer.quarters_considered.length, MAX_QUARTERS);
  assert.deepEqual(layer.quarters_considered, ['FY2027Q1', 'FY2026Q4', 'FY2026Q3', 'FY2026Q2']);
  // FY2026Q1 (5th) must not influence: china there was 'no', but the
  // four-quarter window is yes,yes,no,yes.
  const china = layer.terms.china;
  assert.equal(china.sample_size, 4);
  assert.equal(china.q_minus_1, true);
  assert.equal(china.q_minus_2, true);
  assert.equal(china.q_minus_3, false); // miss recorded
  assert.equal(china.q_minus_4, true);
  assert.equal(china.four_quarter_hit_rate, 0.75);
  // linear newest-heavy weights 4,3,2,1 → (4+3+0+1)/10
  assert.equal(china.recency_weighted_hit_rate, 0.8);

  assert.equal(layer.terms.blackwell.four_quarter_hit_rate, 1);
  assert.equal(layer.terms.agi.four_quarter_hit_rate, 0.25);
  assert.equal(layer.terms.agi.recency_weighted_hit_rate, 0.2); // yes only at q-3 → 2/10
  assert.equal(layer.terms.agi.misses, 3);
});

test('fewer than 4 quarters uses all available with sample_size recorded', async () => {
  const fx = await nvdaFixture();
  // buyback has no market in FY2026Q2 → only 3 settled quarters in the window
  const layer = buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['buyback'], quarters: fx.quarters });
  const b = layer.terms.buyback;
  assert.equal(b.sample_size, 3);
  assert.equal(b.q_minus_1, false);
  assert.equal(b.q_minus_2, true);
  assert.equal(b.q_minus_3, false);
  assert.equal(b.q_minus_4, null); // no market that quarter
  assert.equal(b.four_quarter_hit_rate, 1 / 3);
  // weights 3,2,1 over [no,yes,no] → 2/6
  assert.equal(b.recency_weighted_hit_rate, 1 / 3);
  assert.deepEqual(b.quarters_used, ['FY2027Q1', 'FY2026Q4', 'FY2026Q3']);

  // two-quarter history works the same way
  const two = buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['agi'], quarters: fx.quarters.slice(0, 2) });
  assert.equal(two.terms.agi.sample_size, 2);
  assert.equal(two.terms.agi.four_quarter_hit_rate, 0);
});

test('empty history → absent layer (null), no fake conviction', () => {
  assert.equal(buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['blackwell'], quarters: [] }), null);
  assert.equal(buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['blackwell'] }), null);
  // quarters exist but term never traded → still null
  assert.equal(buildEarningsQuarterLayer({
    ticker: 'NVDA',
    terms: ['quantum'],
    quarters: [{ quarter: 'FY2027Q1', event_date: '2026-05-28', completed: true, outcomes: { blackwell: 'yes' } }],
  }), null);
});

test('recency_weighted_hit_rate is deterministic across calls', async () => {
  const fx = await nvdaFixture();
  const a = buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['china', 'agi'], quarters: fx.quarters });
  const b = buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['china', 'agi'], quarters: [...fx.quarters].reverse() });
  assert.deepEqual(a.terms, b.terms);
  assert.deepEqual(a.last_four_quarter_hit_rate, b.last_four_quarter_hit_rate);
});

test('provenance last_four_quarter_hit_rate carries per-term hit_rate/sample_size/quarters', async () => {
  const fx = await nvdaFixture();
  const layer = buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['china', 'buyback'], quarters: fx.quarters });
  assert.deepEqual(layer.last_four_quarter_hit_rate.china, {
    hit_rate: 0.75,
    sample_size: 4,
    quarters: ['FY2027Q1', 'FY2026Q4', 'FY2026Q3', 'FY2026Q2'],
  });
  assert.equal(layer.last_four_quarter_hit_rate.buyback.sample_size, 3);
});

test('layer output contains no pricing fields and feeds composeMentionLedger', async () => {
  const fx = await nvdaFixture();
  const layer = buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['china'], quarters: fx.quarters });
  assert.equal(FORBIDDEN_SCAN.test(JSON.stringify(layer)), false);

  const record = earningsLayerToHistoricalTendency(layer, 'china');
  assert.equal(record.present, true);
  assert.equal(record.score, 80); // round(100 * 0.8)

  const result = composeMentionLedger({
    event: "NVIDIA Q2 earnings call",
    targetMention: 'china',
    profile: 'earnings_mentions',
    layerDefs: [{ key: 'historical_tendency', weight: 1, label: 'Historical tendency' }],
    layerRecords: { historical_tendency: record },
  });
  assert.equal(result.evidence_ledger[0].present, true);
  assert.equal(result.evidence_ledger[0].value, 80);
});

test('earningsLayerToHistoricalTendency gates n<2 and absent layers', async () => {
  const fx = await nvdaFixture();
  // n=1 → not evidence
  const one = buildEarningsQuarterLayer({ ticker: 'NVDA', terms: ['china'], quarters: fx.quarters.slice(0, 1) });
  const gated = earningsLayerToHistoricalTendency(one, 'china');
  assert.equal(gated.present, false);
  assert.equal(gated.missing_note, 'insufficient settled history (n<2 settled quarters)');

  const absent = earningsLayerToHistoricalTendency(null, 'china');
  assert.equal(absent.present, false);
  assert.equal(absent.missing_note, 'no completed earnings quarters available');
});
