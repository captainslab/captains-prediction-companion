// Cache-only / stale-source disclosure for mentions packets.
//
// Root cause this guards: the delivery janitor fail-closes a mentions send with
// FETCH_CACHE_ONLY when source health is cache-only/stale and the packet carries
// no explicit cache/stale-source disclosure. These tests pin the fix end to end:
//   1. the janitor blocks cache-only source health WITHOUT a disclosure,
//   2. the janitor passes the same source health WITH a disclosure,
//   3. the renderer emits the disclosure when the generator flags cache-only,
//   4. the disclosure is deterministic,
//   5. the existing settled_history block still renders alongside it,
//   6. neither the disclosure nor the detector leak any price-shaped field.
// Janitor safety is preserved: the block still fires when disclosure is absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validatePacketText,
  detectSourceHealthDisclosure,
  hasCacheOnlyDisclosure,
  CACHE_ONLY_DISCLOSURE_LINE,
  DELIVERY_VERDICTS,
} from '../scripts/cron/cpc-packet-janitor.mjs';
import {
  buildMentionCompositeForMarket,
  mentionCompositeToDecisionRow,
  buildMentionsSynthesisInput,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';

// ---- fixtures ---------------------------------------------------------------

// Mirrors today's real artifact: a stub source-health record produced with no
// live fetch and no janitor-recognized freshness field (discovered_at is not in
// sourceTimestamp()'s recognized set), so it trips FETCH_CACHE_ONLY.
function writeCacheOnlySource() {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-cacheonly-'));
  const path = join(dir, 'KXLOVEISLMENTION-26JUN19.json');
  writeFileSync(path, JSON.stringify({
    event_ticker: 'KXLOVEISLMENTION-26JUN19',
    status: 'NO_DECLARED_SOURCES',
    urls: [],
    discovered_at: '2026-06-19T14:04:23.727Z',
    discovered_by: 'discover-sources.mjs',
  }, null, 2));
  return path;
}

// A live-fetched artifact carrying a janitor-recognized live-fetch key; must NOT
// require a disclosure.
function writeLiveSource() {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-live-'));
  const path = join(dir, 'KXLOVEISLMENTION-26JUN19.json');
  writeFileSync(path, JSON.stringify({
    event_ticker: 'KXLOVEISLMENTION-26JUN19',
    status: 'OK',
    live_fetched_utc: '2026-06-19T14:04:23.727Z',
    records: [{ event_ticker: 'KXLOVEISLMENTION-26JUN19', url: 'https://example/live' }],
  }, null, 2));
  return path;
}

function obamaEvent() {
  return {
    event_ticker: 'KXOBAMAMENTION-26JUN19',
    series_ticker: 'KXOBAMAMENTION',
    title: 'What will Obama say during the broadcast interview?',
    sub_title: 'Obama interview',
    settlement_sources: [{ name: 'network', url: 'https://network.example/obama' }],
    markets: [
      {
        ticker: 'KXOBAMAMENTION-26JUN19-KID',
        title: 'Will Obama say kid/kids?',
        yes_sub_title: 'kid/kids',
        custom_strike: 'kid/kids',
        rules_primary: 'Resolves YES if Obama says kid or kids during the broadcast interview.',
      },
    ],
  };
}

const obamaHistory = [
  { market_ticker: 'OB-1', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes' },
  { market_ticker: 'OB-2', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-08', result: 'no', settlement_result: 'resolved_no' },
  { market_ticker: 'OB-3', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-15', result: 'yes', settlement_result: 'resolved_yes' },
];

function renderObamaSlate({ disclosure = null } = {}) {
  const ev = obamaEvent();
  const composite = buildMentionCompositeForMarket({
    event: ev, market: ev.markets[0], candidateText: 'the kid waved', historyRecords: obamaHistory,
  });
  const row = mentionCompositeToDecisionRow(composite);
  const input = buildMentionsSynthesisInput({
    date: '2026-06-19',
    event: ev,
    rows: [row],
    sourceHealthDisclosure: disclosure,
    provenanceLines: [
      'research_route: talk_show_media (horizon=event) | settled_history: tier=exact_horizon n=2 hits=2 misses=0 hit_rate=1.00',
    ],
  });
  const text = renderMentionPacket(input, { generatedAtUtc: '2026-06-19T14:04:23.727Z' });
  assert.ok(text, 'slate packet must render text');
  return { text, composite, row };
}

// Extract section 6 SOURCE GAPS only, so price-isolation assertions never trip
// on section 5 market context.
function sourceGapsBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '6. SOURCE GAPS');
  if (start < 0) return '';
  const block = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && /^\d+\.\s/.test(lines[i])) break; // next numbered section
    block.push(lines[i]);
  }
  return block.join('\n');
}

const PRICE_TOKENS = ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'last_price', 'liquidity', 'volume', 'open_interest', ' oi ', 'bid', 'ask', 'implied', 'notional', 'cents', '¢', 'price'];

// ===========================================================================
// Detector
// ===========================================================================

test('detector flags cache-only source health and returns a recognized disclosure line', () => {
  const path = writeCacheOnlySource();
  const res = detectSourceHealthDisclosure({
    packetType: 'mentions-daily',
    sourceHealthPaths: [path],
  });
  assert.equal(res.needsDisclosure, true);
  assert.equal(res.cacheOnly, true);
  assert.ok(res.disclosureLine, 'disclosure line present');
  assert.ok(hasCacheOnlyDisclosure(res.disclosureLine), 'janitor recognizes its own disclosure phrase');
  assert.equal(res.disclosureLine, CACHE_ONLY_DISCLOSURE_LINE);
});

test('detector does NOT require a disclosure when source health has a live fetch timestamp', () => {
  const path = writeLiveSource();
  const res = detectSourceHealthDisclosure({
    packetType: 'mentions-daily',
    sourceHealthPaths: [path],
  });
  assert.equal(res.needsDisclosure, false);
  assert.equal(res.disclosureLine, null);
});

test('detector output is deterministic', () => {
  const path = writeCacheOnlySource();
  const a = detectSourceHealthDisclosure({ packetType: 'mentions-daily', sourceHealthPaths: [path] });
  const b = detectSourceHealthDisclosure({ packetType: 'mentions-daily', sourceHealthPaths: [path] });
  assert.deepEqual(a, b);
});

// ===========================================================================
// Janitor — block without disclosure, pass with disclosure (safety preserved)
// ===========================================================================

const CONTRACT_LACKING_PACKET = [
  '=== Captain Mentions — CPC Packet: Test Packet ===',
  'generated_utc: 2099-01-01T00:00:00Z',
  'Market Context - NOT IN SCORE.',
  'Research only. No trades.',
].join('\n');

test('janitor BLOCKS cache-only source health when the packet lacks a disclosure', () => {
  const path = writeCacheOnlySource();
  const result = validatePacketText(CONTRACT_LACKING_PACKET, {
    packetType: 'mentions-daily',
    requireSourceHealth: true,
    sourceHealthPaths: [path],
  });
  assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
  assert.ok(
    result.errors.some((e) => e.code === 'FETCH_CACHE_ONLY'),
    'FETCH_CACHE_ONLY must be a hard error without disclosure',
  );
});

test('janitor does NOT raise FETCH_CACHE_ONLY when the packet carries the disclosure', () => {
  const path = writeCacheOnlySource();
  const packetWithDisclosure = `${CONTRACT_LACKING_PACKET}6. SOURCE GAPS\n- ${CACHE_ONLY_DISCLOSURE_LINE}\n`;
  const result = validatePacketText(packetWithDisclosure, {
    packetType: 'mentions-daily',
    requireSourceHealth: true,
    sourceHealthPaths: [path],
  });
  assert.ok(
    !result.errors.some((e) => e.code === 'FETCH_CACHE_ONLY'),
    'cache-only must downgrade to a warning once disclosed',
  );
  assert.ok(
    result.warnings.some((w) => w.code === 'FETCH_CACHE_ONLY'),
    'the cache-only finding is retained as a warning, not silently dropped',
  );
});

// ===========================================================================
// Renderer — emits disclosure only when flagged; settled_history intact
// ===========================================================================

test('rendered packet includes the disclosure in SOURCE GAPS when the generator flags cache-only', () => {
  const { text } = renderObamaSlate({ disclosure: CACHE_ONLY_DISCLOSURE_LINE });
  const gaps = sourceGapsBlock(text);
  assert.ok(gaps.includes(CACHE_ONLY_DISCLOSURE_LINE), 'disclosure renders inside SOURCE GAPS');
  assert.ok(hasCacheOnlyDisclosure(text), 'rendered packet would clear the janitor cache-only gate');
});

test('rendered packet omits the disclosure when source health is not cache-only', () => {
  const { text } = renderObamaSlate({ disclosure: null });
  assert.ok(!hasCacheOnlyDisclosure(text), 'no disclosure phrase when none was flagged');
});

test('disclosure renders alongside an intact settled_history block', () => {
  const { text, composite } = renderObamaSlate({ disclosure: CACHE_ONLY_DISCLOSURE_LINE });
  assert.ok(composite.settled_history, 'guard: settled_history attached');
  assert.match(text, /provenance \(outcomes only; market prices excluded\):/);
  assert.match(text, /settled_history: tier=exact_horizon n=2 hits=2 misses=0 hit_rate=1\.00/);
  assert.ok(hasCacheOnlyDisclosure(text), 'disclosure coexists with settled_history');
});

test('rendered disclosure is deterministic across repeated renders', () => {
  const a = renderObamaSlate({ disclosure: CACHE_ONLY_DISCLOSURE_LINE });
  const b = renderObamaSlate({ disclosure: CACHE_ONLY_DISCLOSURE_LINE });
  assert.equal(sourceGapsBlock(a.text), sourceGapsBlock(b.text));
});

// ===========================================================================
// Price isolation
// ===========================================================================

test('disclosure line and detector output contain no price-shaped field', () => {
  const path = writeCacheOnlySource();
  const res = detectSourceHealthDisclosure({ packetType: 'mentions-daily', sourceHealthPaths: [path] });
  const haystacks = [CACHE_ONLY_DISCLOSURE_LINE.toLowerCase(), JSON.stringify(res).toLowerCase()];
  for (const hay of haystacks) {
    for (const token of PRICE_TOKENS) {
      assert.ok(!hay.includes(token), `must not contain price token "${token.trim()}"`);
    }
  }
});

test('SOURCE GAPS disclosure block carries no price-shaped field or value', () => {
  const { text } = renderObamaSlate({ disclosure: CACHE_ONLY_DISCLOSURE_LINE });
  const gaps = sourceGapsBlock(text);
  // Price fields and price-value shapes (cents/¢/%, yes/no bid|ask|price=NN).
  const priceFieldShapes = [
    /\b(?:yes|no)_(?:bid|ask|price)\b/i,
    /\b(?:last_price|open_interest|volume|notional|liquidity)\b/i,
    /\b(?:bid|ask|price)\s*[:=]\s*\d/i,
    /\b\d{1,3}\s*(?:¢|cents)\b/i,
    /\b\d{1,3}\s*%/,
  ];
  for (const re of priceFieldShapes) {
    assert.ok(!re.test(gaps), `SOURCE GAPS must not contain price shape ${re}`);
  }
});
