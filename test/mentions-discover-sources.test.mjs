import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extractUrlsFromText,
  isPriceLikeUrl,
  discoverSourcesForEvent,
  ensureSourcesManifest,
  loadManualOverrides,
  sourcesManifestPath,
  SOURCE_STATUS,
} from '../scripts/mentions/discover-sources.mjs';
import { buildEventResearch } from '../scripts/mentions/collect-mentions-research.mjs';

const DATE = '2026-06-13';

// Hochul-style event: official URL named inside the Kalshi resolution rules.
const HOCHUL_EVENT = {
  event_ticker: 'KXHOCHULMENTION-26JUN13',
  title: 'What will Governor Kathy Hochul say during her next announcement?',
  sub_title: 'Kathy Hochul - announcement',
  markets: [
    {
      ticker: 'KXHOCHULMENTION-26JUN13-AFFO',
      custom_strike: { Word: 'Affordability' },
      close_time: '2026-06-13T22:00:00Z',
      rules_primary: 'If a qualifying event does not occur, then the market resolves to Yes.',
      rules_secondary: 'Video of the next Governor Kathy Hochul announcement will be used; refers to the first livestream on the official state website (https://www.governor.ny.gov/) after June 12th, 2026.',
    },
  ],
};

// Vance-style event: NO official source URL anywhere in the rules.
const VANCE_EVENT = {
  event_ticker: 'KXVANCEMENTION-26JUN14',
  title: 'What will JD Vance say during CBS Sunday Morning?',
  sub_title: 'JD Vance - CBS Sunday Morning',
  markets: [
    {
      ticker: 'KXVANCEMENTION-26JUN14-BIDE',
      custom_strike: { Word: 'Biden' },
      close_time: '2026-06-14T22:00:00Z',
      rules_primary: 'If a qualifying event does not occur, then the market resolves to Yes.',
      rules_secondary: 'Video of the CBS Sunday Morning will be primarily used to resolve the market. The exact phrase/word must be used.',
    },
  ],
};

test('extractUrlsFromText pulls http(s) urls and strips trailing punctuation', () => {
  const urls = extractUrlsFromText('see https://www.governor.ny.gov/ and http://example.com/page. done');
  assert.deepEqual(urls, ['https://www.governor.ny.gov/', 'http://example.com/page']);
  assert.deepEqual(extractUrlsFromText(''), []);
  assert.deepEqual(extractUrlsFromText(null), []);
});

test('isPriceLikeUrl rejects market/price hosts and unparseable input', () => {
  assert.equal(isPriceLikeUrl('https://kalshi.com/events/KX'), true);
  assert.equal(isPriceLikeUrl('https://polymarket.com/x'), true);
  assert.equal(isPriceLikeUrl('https://draftkings.com/odds'), true);
  assert.equal(isPriceLikeUrl('not a url'), true);
  assert.equal(isPriceLikeUrl('https://www.governor.ny.gov/'), false);
});

test('discovery DECLARED: official url mined from Kalshi rules, market hosts excluded', () => {
  const m = discoverSourcesForEvent(HOCHUL_EVENT, { profile: 'political_mentions' });
  assert.equal(m.status, SOURCE_STATUS.DECLARED);
  assert.deepEqual(m.urls, ['https://www.governor.ny.gov/']);
  // never a kalshi/market URL
  for (const u of m.urls) assert.equal(isPriceLikeUrl(u), false);
});

test('discovery NO_DECLARED_SOURCES: no official url in rules -> explicit gap, empty urls', () => {
  const m = discoverSourcesForEvent(VANCE_EVENT, { profile: 'political_mentions' });
  assert.equal(m.status, SOURCE_STATUS.NO_DECLARED_SOURCES);
  assert.deepEqual(m.urls, []);
});

test('discovery is bounded: never exceeds the source cap and dedupes', () => {
  const ev = {
    event_ticker: 'KXMANY',
    markets: [{
      rules_secondary: [
        'https://a.gov/1', 'https://a.gov/1', 'https://b.gov/2',
        'https://c.gov/3', 'https://d.gov/4', 'https://e.gov/5',
      ].join(' '),
    }],
  };
  const m = discoverSourcesForEvent(ev, { profile: 'political_mentions', env: {} });
  assert.ok(m.urls.length <= 3, 'capped to default max sources');
});

test('price host inside rules is rejected, never written as a source', () => {
  const ev = {
    event_ticker: 'KXPRICE',
    markets: [{ rules_secondary: 'resolves via https://kalshi.com/events/KXPRICE and https://www.governor.ny.gov/' }],
  };
  const m = discoverSourcesForEvent(ev, { profile: 'political_mentions' });
  assert.deepEqual(m.urls, ['https://www.governor.ny.gov/']);
  assert.ok(m.provenance.some((p) => p.rejected === 'price_or_market_host'));
});

test('manual overrides take priority and are loaded from sources-manual/', () => {
  const root = mkdtempSync(join(tmpdir(), 'disc-manual-'));
  mkdirSync(join(root, 'mentions', DATE, 'sources-manual'), { recursive: true });
  writeFileSync(
    join(root, 'mentions', DATE, 'sources-manual', 'KXHOCHULMENTION-26JUN13.json'),
    JSON.stringify({ urls: ['https://www.ny.gov/transcript'] }),
  );
  const overrides = loadManualOverrides(root, DATE, 'KXHOCHULMENTION-26JUN13');
  assert.deepEqual(overrides, ['https://www.ny.gov/transcript']);
  const m = discoverSourcesForEvent(HOCHUL_EVENT, { profile: 'political_mentions', manualUrls: overrides });
  assert.equal(m.urls[0], 'https://www.ny.gov/transcript', 'manual override ranked first');
  assert.ok(m.urls.includes('https://www.governor.ny.gov/'));
});

test('ensureSourcesManifest writes once and never clobbers a human-authored manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'disc-ensure-'));
  const first = ensureSourcesManifest(HOCHUL_EVENT, { profile: 'political_mentions', stateRoot: root, date: DATE });
  assert.equal(first.wrote, true);
  assert.ok(existsSync(first.path));
  assert.equal(first.manifest.status, SOURCE_STATUS.DECLARED);
  // second call is a no-op read
  const second = ensureSourcesManifest(HOCHUL_EVENT, { profile: 'political_mentions', stateRoot: root, date: DATE });
  assert.equal(second.wrote, false);
  // hand-author override on disk -> must be preserved
  writeFileSync(sourcesManifestPath(root, DATE, 'KXHOCHULMENTION-26JUN13.json'.replace('.json', '')), JSON.stringify({ urls: ['https://hand.gov/x'] }));
  const third = ensureSourcesManifest(HOCHUL_EVENT, { profile: 'political_mentions', stateRoot: root, date: DATE });
  assert.equal(third.wrote, false);
  assert.deepEqual(third.manifest.urls, ['https://hand.gov/x']);
});

test('collector end-to-end DECLARED: discovery creates manifest, research no longer null, cache populated, layers updated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'disc-e2e-decl-'));
  // no pre-existing sources/ manifest: discovery must create it from the rules
  let modelCalls = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'transcript: the Governor stressed affordability for New York families' });
  const chatRunner = async () => {
    modelCalls += 1;
    return {
      ok: true,
      status: 0,
      parsed: {
        terms: [{ term: 'Affordability', layers: { direct_mention_pathway: { present: true, score: 77, basis: '"stressed affordability" verbatim' } } }],
      },
    };
  };
  const research = await buildEventResearch(HOCHUL_EVENT, 'political_mentions', {
    stateRoot: root, date: DATE, env: {}, deps: { fetchImpl, chatRunner },
  });

  // manifest created by discovery
  const manifestPath = sourcesManifestPath(root, DATE, 'KXHOCHULMENTION-26JUN13');
  assert.ok(existsSync(manifestPath), 'sources manifest auto-created');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.status, SOURCE_STATUS.DECLARED);
  assert.deepEqual(manifest.urls, ['https://www.governor.ny.gov/']);

  // research stats no longer null
  assert.notEqual(research.source_research_stats, null, 'source_research_stats populated');
  assert.equal(research.source_status, SOURCE_STATUS.DECLARED);
  assert.equal(modelCalls, 1, 'one bounded batch call');

  // research-cache populated
  const cacheFiles = readdirSync(join(root, 'mentions', DATE, 'research-cache'));
  assert.ok(cacheFiles.length >= 1, 'fetched page cached');

  // layer_records updated from extracted source evidence
  const mkt = research.markets.find((m) => m.keyword === 'Affordability');
  assert.equal(mkt.research_quality, 'source_backed');
  assert.equal(mkt.layer_records.direct_mention_pathway.present, true);
  assert.equal(mkt.layer_records.direct_mention_pathway.score, 77);
});

test('collector end-to-end NO_DECLARED_SOURCES: explicit gap, null stats, no fetch, no model call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'disc-e2e-nosrc-'));
  let fetches = 0;
  let modelCalls = 0;
  const research = await buildEventResearch(VANCE_EVENT, 'political_mentions', {
    stateRoot: root, date: DATE, env: {},
    deps: {
      fetchImpl: async () => { fetches += 1; return { ok: true, status: 200, text: async () => 'x' }; },
      chatRunner: async () => { modelCalls += 1; return { ok: true, parsed: { terms: [] }, status: 0 }; },
    },
  });
  assert.equal(fetches, 0, 'no source url -> no network fetch');
  assert.equal(modelCalls, 0, 'no source url -> no model call');
  assert.equal(research.source_status, SOURCE_STATUS.NO_DECLARED_SOURCES);
  assert.equal(research.source_research_stats, null);
  const mkt = research.markets.find((m) => m.keyword === 'Biden');
  assert.equal(mkt.source_status, SOURCE_STATUS.NO_DECLARED_SOURCES);
  assert.ok(mkt.research_gap_notes.some((n) => n.includes('NO_DECLARED_SOURCES')));
  // manifest written with explicit gap
  const manifest = JSON.parse(readFileSync(sourcesManifestPath(root, DATE, 'KXVANCEMENTION-26JUN14'), 'utf8'));
  assert.equal(manifest.status, SOURCE_STATUS.NO_DECLARED_SOURCES);
  assert.deepEqual(manifest.urls, []);
});

test('market data never enters layer_records via discovery path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'disc-firewall-'));
  // extraction tries to smuggle a pricing field; validator must drop the record
  const research = await buildEventResearch(HOCHUL_EVENT, 'political_mentions', {
    stateRoot: root, date: DATE, env: {},
    deps: {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'affordability discussed' }),
      chatRunner: async () => ({
        ok: true, status: 0,
        parsed: { terms: [{ term: 'Affordability', layers: { direct_mention_pathway: { present: true, score: 60, basis: 'quote', yes_ask: 42 } } }] },
      }),
    },
  });
  const mkt = research.markets.find((m) => m.keyword === 'Affordability');
  for (const rec of Object.values(mkt.layer_records)) {
    for (const k of ['price', 'yes_bid', 'yes_ask', 'volume', 'open_interest']) {
      assert.equal(k in rec, false, `no ${k} in any layer_record`);
    }
  }
});
