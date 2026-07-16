// Fail-closed when source research is absent.
//
// Root cause this guards: the 2026-06-19 mentions packets rendered 11 WATCH
// rows from a NO_DECLARED_SOURCES research file in which only the
// event_proximity stub layer was present (no transcript / quote / velocity /
// historical / exact-source evidence). The cache-only disclosure fix unblocked
// the SEND but did NOT stop the product failure: a research-free event still
// produced a deliverable customer packet.
//
// These tests pin the fix end to end:
//   1. a market carrying a no-research source_status (NO_DECLARED_SOURCES) AND
//      only proximity evidence is BLOCKED (NO_USABLE_SOURCES), not WATCH.
//   2. an event whose entire board is blocked writes a SOURCE_RESEARCH
//      observability artifact and STILL renders a customer .txt — honestly
//      degraded (every row a disclosed research gap), not suppressed. Zero
//      evidence is not an identity/malformed/duplicate/price-leak risk, so
//      per product rule it degrades rather than fails closed.
//   3. proximity-only WITHOUT a no-research status stays a capped WATCH (the
//      existing low-source contract is preserved; we only fail closed when we
//      KNOW no research ran).
//   4. a market with genuine beyond-proximity source evidence still passes and
//      can render a real board, even under NO_DECLARED_SOURCES (research ran via
//      a path that produced evidence).
//   5. price isolation holds: source_status / fail-closed reasoning carry no
//      price-shaped field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildMentionCompositeForMarket,
  mentionCompositeToDecisionRow,
  buildKalshiEventPacket,
  writeKalshiEventPackets,
  isNoResearchSourceStatus,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { EDGE_STATUS } from '../scripts/shared/decision-packet.mjs';

// Mirrors the real 2026-06-19 KXLATENIGHT research artifact: NO_DECLARED_SOURCES,
// research_quality stub, only the event_proximity stub layer present.
function noResearchEvent() {
  return {
    event_ticker: 'KXLATENIGHTMENTION-26JUN19',
    series_ticker: 'KXLATENIGHTMENTION',
    title: 'What will James Corden say during World Cup on Fox After Hours?',
    sub_title: 'James Corden',
    event_url: 'https://kalshi.com/events/KXLATENIGHTMENTION-26JUN19',
    event_time_utc: '2026-06-19T18:00:00Z',
    settlement_source_link: 'https://www.fox.com/',
    research_timestamp: '2026-06-18T20:00:00Z',
    markets: [
      {
        ticker: 'KXLATENIGHTMENTION-26JUN19-RECO',
        title: 'What will James Corden say? -- Record',
        yes_sub_title: 'Record',
        custom_strike: { Word: 'Record' },
        mention_profile: 'political_mentions',
        research_quality: 'stub',
        source_status: 'NO_DECLARED_SOURCES',
        rules_primary: 'If James Corden says Record, resolves Yes.',
        layer_records: {
          event_proximity: { present: true, score: 98, source_basis: 'official speech schedule (confirmed)' },
        },
      },
      {
        ticker: 'KXLATENIGHTMENTION-26JUN19-GOLD',
        title: 'What will James Corden say? -- Golden Boot',
        yes_sub_title: 'Golden Boot',
        custom_strike: { Word: 'Golden Boot' },
        mention_profile: 'political_mentions',
        research_quality: 'stub',
        source_status: 'NO_DECLARED_SOURCES',
        rules_primary: 'If James Corden says Golden Boot, resolves Yes.',
        layer_records: {
          event_proximity: { present: true, score: 98, source_basis: 'official speech schedule (confirmed)' },
        },
      },
    ],
  };
}

// Same proximity-only shape but with NO source_status field (e.g. a unit
// fixture or legacy path where we cannot prove research was skipped). The
// existing low-source WATCH contract must be preserved here.
function proximityOnlyUnknownStatusEvent() {
  return {
    event_ticker: 'KXUNK-26JUN19',
    series_ticker: 'KXUNK',
    title: 'What will the speaker say during the rally?',
    sub_title: 'speaker',
    event_url: 'https://kalshi.com/events/KXUNK-26JUN19',
    event_time_utc: '2026-06-19T18:00:00Z',
    settlement_source_link: 'https://example.com/official-event',
    research_timestamp: '2026-06-18T20:00:00Z',
    markets: [
      {
        ticker: 'KXUNK-26JUN19-TAR',
        title: 'tariff',
        yes_sub_title: 'tariff',
        custom_strike: { Word: 'tariff' },
        mention_profile: 'political_mentions',
        rules_primary: 'If the speaker says tariff, resolves Yes.',
        layer_records: {
          event_proximity: { present: true, score: 80, source_basis: 'official speech schedule confirmed' },
        },
      },
    ],
  };
}

// A researched market: beyond-proximity evidence present even though source
// discovery found no DECLARED official URL (research ran via Perplexity/native).
function researchedEvent() {
  const ev = noResearchEvent();
  ev.markets[0].research_quality = 'source_backed';
  ev.markets[0].layer_records.direct_mention_pathway = {
    present: true, score: 71, source_basis: 'perplexity literal-utterance forecast (blended=71)',
  };
  return ev;
}

test('no-research source statuses are recognized', () => {
  assert.equal(isNoResearchSourceStatus('NO_DECLARED_SOURCES'), true);
  assert.equal(isNoResearchSourceStatus('SOURCE_FETCH_BLOCKED_BY_SITE'), true);
  assert.equal(isNoResearchSourceStatus('SOURCE_FETCH_TIMEOUT'), true);
  assert.equal(isNoResearchSourceStatus('SOURCE_FETCHED'), false);
  assert.equal(isNoResearchSourceStatus('DECLARED'), false);
  assert.equal(isNoResearchSourceStatus(null), false);
});

test('NO_DECLARED_SOURCES + proximity-only market is BLOCKED NO_USABLE_SOURCES, not WATCH', () => {
  const ev = noResearchEvent();
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0] });
  assert.equal(composite.source_status, 'NO_DECLARED_SOURCES');
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.edge_status, EDGE_STATUS.BLOCKED, 'no-research proximity-only row must be BLOCKED, never WATCH');
  assert.match(row.blocker_if_any ?? '', /NO_USABLE_SOURCES/);
  assert.notEqual(row.composite_posture, 'WATCH');
});

test('proximity-only WITHOUT a no-research status keeps the existing low-source WATCH contract', () => {
  const ev = proximityOnlyUnknownStatusEvent();
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0] });
  assert.equal(composite.source_status, null);
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.edge_status, EDGE_STATUS.WATCH, 'unknown-status proximity-only stays capped WATCH');
  assert.match(row.analysis ?? '', /LOW-SOURCE WATCH only/);
});

test('a market with beyond-proximity source evidence still passes (NO_DECLARED_SOURCES but research produced evidence)', () => {
  const ev = researchedEvent();
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0] });
  const row = mentionCompositeToDecisionRow(composite);
  assert.notEqual(row.edge_status, EDGE_STATUS.BLOCKED, 'real evidence must not be failed closed');
  assert.equal(row.blocker ?? null, null);
});

test('all-blocked event packet reports counts.blocked === counts.total (event-level fail-closed trigger)', () => {
  const built = buildKalshiEventPacket({
    date: '2026-06-19',
    event: noResearchEvent(),
    sourceUrl: '/tmp/latenight.json',
  });
  assert.ok(built.counts, 'slate packet exposes counts');
  assert.equal(built.counts.total, built.counts.blocked, 'every row blocked when no research ran');
});

test('writeKalshiEventPackets degrades (does not suppress): observability artifact written, customer .txt still rendered', async () => {
  // A zero-evidence board is not an identity risk, malformed output, a
  // duplicate, or a price leak — per product rule it must render an honest,
  // fully-degraded customer packet rather than being suppressed. It still
  // records a `.degraded.json` artifact for operational observability, and
  // must NOT land in failedTickers (it was delivered, just degraded).
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-degraded-'));
  const date = '2026-06-19';
  const dir = join(stateRoot, 'packets', date, 'mentions-daily');
  mkdirSync(dir, { recursive: true });
  const written = [];
  const audit = (d, name, text) => {
    const p = join(d, `${name}.txt`);
    writeFileSync(p, text);
    written.push(`${name}.txt`);
    return { path: p };
  };

  const result = await writeKalshiEventPackets({
    events: [noResearchEvent()],
    date,
    stateRoot,
    dir,
    audit,
    dryRun: true, // no model synthesis, no send
  });

  assert.equal(result.failedTickers.includes('KXLATENIGHTMENTION-26JUN19'), false, 'a degraded-but-delivered event must not land in failedTickers');
  // Observability artifact exists (distinct filename from a genuine blocker).
  const degradedPath = join(stateRoot, 'mentions', date, 'blockers', `${date}-KXLATENIGHTMENTION-26JUN19.degraded.json`);
  assert.ok(existsSync(degradedPath), 'source-research degraded-observability artifact written');
  // The customer packet .txt IS rendered — honestly degraded, not suppressed.
  const customerTxts = written.filter((n) => !n.includes('.inventory'));
  assert.equal(customerTxts.length, 1, 'a customer packet .txt is still rendered for a research-free event');
});

test('stale research is treated as absent and fails closed instead of rendering', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-stale-'));
  const date = '2026-06-19';
  const event = {
    event_ticker: 'KXSTALEMENTION-26JUN19',
    series_ticker: 'KXSTALEMENTION',
    title: 'What will the speaker say during the rally?',
    sub_title: 'speaker',
    markets: [
      {
        ticker: 'KXSTALEMENTION-26JUN19-AFFORD',
        title: 'What will the speaker say? -- Affordability',
        yes_sub_title: 'Affordability',
        custom_strike: { Word: 'Affordability' },
        mention_profile: 'political_mentions',
        layer_records: {
          event_proximity: { present: true, score: 92, source_basis: 'confirmed rally schedule' },
        },
      },
    ],
  };
  const researchDir = join(stateRoot, 'mentions', date, 'research');
  mkdirSync(researchDir, { recursive: true });
  writeFileSync(join(researchDir, `${event.event_ticker}.json`), JSON.stringify({
    event_ticker: event.event_ticker,
    // Prior-cycle (a day old): well beyond the freshness window -> treated as stale.
    produced_at: '2026-06-18T12:00:00.000Z',
    source_status: 'SOURCE_FETCHED',
    markets: [{
      market_ticker: event.markets[0].ticker,
      blended_pct: 78,
      proof_pct: 10,
      handicap_pct: 82,
      kalshi_native_pct: 60,
      kalshi_native_n: 5,
      confidence: 'high',
      reason: 'habit/news-cycle pressure',
      proof_reason: 'no evidence in provided results',
      handicap_reason: 'habit/news-cycle pressure',
    }],
  }, null, 2));

  const dir = join(stateRoot, 'packets', date, 'mentions-daily');
  mkdirSync(dir, { recursive: true });
  const written = [];
  const audit = (d, name, text) => {
    const p = join(d, `${name}.txt`);
    writeFileSync(p, text);
    written.push(`${name}.txt`);
    return { path: p };
  };

  const result = await writeKalshiEventPackets({
    events: [event],
    date,
    stateRoot,
    dir,
    audit,
    dryRun: true,
    runStartedAtUtc: '2026-06-19T12:00:00.000Z',
  });

  assert.ok(result.failedTickers.includes(event.event_ticker), 'stale research fails closed');
  assert.ok(existsSync(join(stateRoot, 'mentions', date, 'blockers', `${date}-${event.event_ticker}.json`)), 'blocker artifact written');
  assert.equal(written.filter((n) => !n.includes('.inventory')).length, 0, 'no stale customer packet rendered');
});

test('current-cycle research (produced shortly BEFORE the run start) renders, not fails closed', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-fresh-'));
  const date = '2026-06-19';
  const event = {
    event_ticker: 'KXFRESHMENTION-26JUN19',
    series_ticker: 'KXFRESHMENTION',
    title: 'What will the speaker say during the rally?',
    sub_title: 'speaker',
    event_url: 'https://kalshi.com/events/KXFRESHMENTION-26JUN19',
    event_time_utc: '2026-06-19T18:00:00Z',
    settlement_source_link: 'https://example.com/fresh-official-event',
    research_timestamp: '2026-06-19T11:55:00Z',
    markets: [{
      ticker: 'KXFRESHMENTION-26JUN19-AFFORD',
      title: 'What will the speaker say? -- Affordability',
      yes_sub_title: 'Affordability',
      custom_strike: { Word: 'Affordability' },
      mention_profile: 'political_mentions',
      layer_records: { event_proximity: { present: true, score: 92, source_basis: 'confirmed rally schedule' } },
    }],
  };
  const researchDir = join(stateRoot, 'mentions', date, 'research');
  mkdirSync(researchDir, { recursive: true });
  writeFileSync(join(researchDir, `${event.event_ticker}.json`), JSON.stringify({
    event_ticker: event.event_ticker,
    // Same cycle: produced 5 minutes before the generation run start (the normal
    // collect -> generate ordering). Must be treated as FRESH, not stale.
    produced_at: '2026-06-19T11:55:00.000Z',
    source_status: 'SOURCE_FETCHED',
    markets: [{
      market_ticker: event.markets[0].ticker,
      blended_pct: 78, proof_pct: 10, handicap_pct: 82,
      kalshi_native_pct: 60, kalshi_native_n: 5, confidence: 'high',
      reason: 'habit/news-cycle pressure',
      proof_reason: 'no evidence in provided results',
      handicap_reason: 'habit/news-cycle pressure',
    }],
  }, null, 2));

  const dir = join(stateRoot, 'packets', date, 'mentions-daily');
  mkdirSync(dir, { recursive: true });
  const written = [];
  const audit = (d, name, text) => { writeFileSync(join(d, `${name}.txt`), text); written.push(`${name}.txt`); return { path: join(d, `${name}.txt`) }; };

  const result = await writeKalshiEventPackets({
    events: [event], date, stateRoot, dir, audit, dryRun: true,
    runStartedAtUtc: '2026-06-19T12:00:00.000Z',
  });

  assert.ok(!result.failedTickers.includes(event.event_ticker), 'same-cycle research must NOT fail closed');
  assert.equal(written.filter((n) => !n.includes('.inventory')).length, 1, 'a customer packet .txt is rendered from fresh research');
});

test('price isolation: source_status gate and blocker reasoning carry no price-shaped field', () => {
  const ev = noResearchEvent();
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0] });
  const row = mentionCompositeToDecisionRow(composite);
  const haystack = `${composite.source_status} ${row.blocker_if_any} ${row.analysis} ${row.trigger_event}`.toLowerCase();
  for (const token of ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'last_price', 'open_interest', 'volume', 'liquidity', 'cents', '¢']) {
    assert.ok(!haystack.includes(token), `gate text must not contain price token ${token}`);
  }
});
