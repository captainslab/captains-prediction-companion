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
//   2. an event whose entire board is blocked writes a SOURCE_RESEARCH blocker
//      and produces NO customer .txt (fail closed), but still an audit artifact.
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

test('writeKalshiEventPackets fails closed: blocker artifact written, NO customer .txt', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-failclosed-'));
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

  assert.ok(result.failedTickers.includes('KXLATENIGHTMENTION-26JUN19'), 'event lands in failedTickers');
  // Blocker artifact exists.
  const blockerPath = join(stateRoot, 'mentions', date, 'blockers', `${date}-KXLATENIGHTMENTION-26JUN19.json`);
  assert.ok(existsSync(blockerPath), 'source-research blocker artifact written');
  // No customer packet .txt (only inventory audit allowed).
  const customerTxts = written.filter((n) => !n.includes('.inventory'));
  assert.equal(customerTxts.length, 0, 'no customer packet .txt for a research-free event');
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
