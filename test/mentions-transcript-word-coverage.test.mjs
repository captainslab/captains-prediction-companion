import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  termPatterns,
  matchStrikeInText,
  buildStrikeCoverage,
  assertNoPriceFields,
} from '../scripts/mentions/transcript-word-coverage.mjs';

// Small fixture transcript modeled on Kroger earnings-call prose. Deterministic;
// no network. Contains some strike terms and deliberately omits others.
const FIXTURE_Q4 = `
Operator: Good morning. Welcome to The Kroger Co. fourth quarter earnings call.
We continued to invest in fresh produce and our private brands. Our Boost
membership and the Ocado partnership remain priorities. Together with Instacart
we expanded delivery. Pharmacy benefited from continued growth in GLP-1s, and we
are scaling artificial intelligence across the enterprise. We saw egg deflation
during the quarter. We also announced the sale of Vitacost. The board approved a
dividend increase.
`;

const FIXTURE_Q3 = `
We grew produce and deli. The Ocado sheds are ramping. Instacart drove digital
sales. AI personalization improved. We returned cash through our dividend.
`;

const STRIKES = [
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-TARI', strike: 'Tariff' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-SNAP', strike: 'SNAP / Food Stamp' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-DIVI', strike: 'Dividend' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-ALBE', strike: 'Albertsons' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-PROD', strike: 'Produce' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-OCAD', strike: 'Ocado' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-INST', strike: 'Instacart' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-GLP', strike: 'GLP-1' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-AI', strike: 'AI / Artificial Intelligence' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-DEFL', strike: 'Deflation' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-VITA', strike: 'Vitacost' },
  { ticker: 'KXEARNINGSMENTIONKR-26JUN18-250', strike: '250' },
];

test('termPatterns splits slash alternatives and handles numbers/hyphens', () => {
  assert.deepEqual(termPatterns('SNAP / Food Stamp').map((p) => p.alternative), ['SNAP', 'Food Stamp']);
  assert.deepEqual(termPatterns('AI / Artificial Intelligence').map((p) => p.alternative), ['AI', 'Artificial Intelligence']);
  assert.equal(termPatterns('250').length, 1);
  // single alpha token allows optional trailing s
  assert.ok(termPatterns('Tariff')[0].regex.test('tariffs everywhere'));
});

test('matchStrikeInText is case-insensitive, word-boundary, and quotes the hit', () => {
  const hit = matchStrikeInText('Ocado', FIXTURE_Q4);
  assert.equal(hit.hit, true);
  assert.match(hit.quote, /Ocado/);
  const slashHit = matchStrikeInText('AI / Artificial Intelligence', FIXTURE_Q4);
  assert.equal(slashHit.hit, true);
  assert.equal(slashHit.matched_alternative, 'Artificial Intelligence');
  // miss is recorded, not a crash
  assert.equal(matchStrikeInText('Tariff', FIXTURE_Q4).hit, false);
});

test('number strike 250 does not match inside larger numbers', () => {
  assert.equal(matchStrikeInText('250', 'we opened 250 stores').hit, true);
  assert.equal(matchStrikeInText('250', 'revenue of 2509 million').hit, false);
  assert.equal(matchStrikeInText('250', 'guidance of 1,250.5 basis').hit, false);
});

test('buildStrikeCoverage records misses, hit rates, and source-backed flags', () => {
  const sources = [
    { label: 'KR-Q4', quarter: 'Q4', source_type: 'transcript', source_url: 'https://x/q4', text: FIXTURE_Q4 },
    { label: 'KR-Q3', quarter: 'Q3', source_type: 'transcript', source_url: 'https://x/q3', text: FIXTURE_Q3 },
  ];
  const { rows, summary } = buildStrikeCoverage({ strikes: STRIKES, sources });

  const ocado = rows.find((r) => r.strike === 'Ocado');
  assert.equal(ocado.last_4q_transcript_hits, 2);
  assert.equal(ocado.last_4q_transcript_quarters, 2);
  assert.equal(ocado.last_4q_transcript_hit_rate, 1);
  assert.equal(ocado.source_backed, true);

  const tariff = rows.find((r) => r.strike === 'Tariff');
  assert.equal(tariff.last_4q_transcript_hits, 0);
  assert.equal(tariff.source_backed, false); // miss recorded, not dropped

  const dividend = rows.find((r) => r.strike === 'Dividend');
  assert.equal(dividend.last_4q_transcript_hits, 2);

  // every strike flagged needs_fresh_source_fetch (no prior Kalshi board)
  assert.ok(rows.every((r) => r.needs_fresh_source_fetch === true && r.prior_board_seen === false));

  assert.equal(summary.strike_count, STRIKES.length);
  assert.equal(summary.source_backed_strikes + summary.low_source_strikes, STRIKES.length);
});

// Generalization proof: a NON-Kroger earnings-mention event runs through the
// exact same pure buildStrikeCoverage path with no code change. Different
// company (Nike), different strikes, different transcript prose.
const NKE_Q = `
Operator: Welcome to the NIKE, Inc. earnings call. We drove strong demand for
Jordan Brand and reignited momentum in running. Direct and digital grew while we
cleared excess inventory. Tariffs pressured gross margin. We expanded our women's
business and saw China stabilize.
`;

test('buildStrikeCoverage generalizes to a non-Kroger earnings event', () => {
  const strikes = [
    { ticker: 'KXEARNINGSMENTIONNKE-26JUN26-JORD', strike: 'Jordan' },
    { ticker: 'KXEARNINGSMENTIONNKE-26JUN26-TARI', strike: 'Tariff' },
    { ticker: 'KXEARNINGSMENTIONNKE-26JUN26-CHIN', strike: 'China' },
    { ticker: 'KXEARNINGSMENTIONNKE-26JUN26-METAV', strike: 'Metaverse' },
    { ticker: 'KXEARNINGSMENTIONNKE-26JUN26-AI', strike: 'AI / Artificial Intelligence' },
  ];
  const sources = [
    { label: 'NKE-Qx', quarter: 'Qx', source_type: 'transcript', source_url: 'https://x/nke', text: NKE_Q },
  ];
  const { rows, summary } = buildStrikeCoverage({ strikes, sources });

  // Hits and misses both recorded for a company never hardcoded anywhere.
  assert.equal(rows.find((r) => r.strike === 'Jordan').source_backed, true);
  assert.equal(rows.find((r) => r.strike === 'Tariff').source_backed, true);
  assert.equal(rows.find((r) => r.strike === 'China').source_backed, true);
  assert.equal(rows.find((r) => r.strike === 'Metaverse').source_backed, false);
  assert.equal(rows.find((r) => r.strike === 'AI / Artificial Intelligence').last_4q_transcript_hits, 0);

  assert.equal(summary.strike_count, strikes.length);
  assert.equal(summary.source_backed_strikes, 3);
  assert.equal(summary.low_source_strikes, 2);
  assert.ok(rows.every((r) => r.needs_fresh_source_fetch === true && r.prior_board_seen === false));
  assert.equal(assertNoPriceFields({ rows, summary }), true);
});

test('assertNoPriceFields throws on price-shaped keys', () => {
  assert.throws(() => assertNoPriceFields({ yes_bid: 5 }), /forbidden price-shaped key/);
  assert.equal(assertNoPriceFields({ strike: 'Ocado', hit: true }), true);
});
