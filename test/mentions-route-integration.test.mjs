// Integration tests: shared research-route resolver + settled-history alpha
// wiring across generator (generate-mentions-daily) and collector
// (mentions-watch). Route resolution must happen before any source/model
// work, history must feed historical_tendency without prices, and the
// deterministic 8-section renderer must be unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveResearchRoute, ROUTE_TO_PROFILE } from '../scripts/mentions/mention-route-resolver.mjs';
import { ingestSettledMarkets, loadHistory } from '../scripts/mentions/settled-history.mjs';
import {
  buildMentionCompositeForMarket,
  buildKalshiEventPacket,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { annotateResearchRoutes, watch } from '../scripts/mentions/mentions-watch.mjs';
import { renderMentionPacket, validateRenderedPacket, SECTION_ORDER } from '../scripts/mentions/render-mention-packet.mjs';

const NOW = new Date('2026-06-12T12:00:00Z');

function trumpWeeklyEvent() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUN13',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say this week?',
    sub_title: 'Trump weekly mention market',
    close_time: '2026-06-14T03:00:00Z',
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26JUN13-TARIFF',
        title: 'Will President Trump say "Tariff" this week?',
        yes_sub_title: 'Tariff',
        rules_primary: 'Resolves Yes if Trump says "Tariff" during the weekly window.',
        close_time: '2026-06-14T03:00:00Z',
        yes_bid: 41,
        yes_ask: 44,
        volume: 1200,
        open_interest: 900,
      },
    ],
  };
}

function bidenEvent() {
  return {
    event_ticker: 'KXHBIDENMENTION-26JUN12',
    series_ticker: 'KXHBIDENMENTION',
    title: 'Will Biden mention these words in his speech?',
    close_time: '2026-06-12T23:00:00Z',
    markets: [
      {
        ticker: 'KXHBIDENMENTION-26JUN12-ECON',
        title: 'Will Biden say "Economy"?',
        yes_sub_title: 'Economy',
        rules_primary: 'Resolves Yes if Biden says "Economy" during the speech.',
        close_time: '2026-06-12T23:00:00Z',
      },
    ],
  };
}

test('shared resolver gives the same route in generator and collector', () => {
  const ev = trumpWeeklyEvent();
  const collectorRoute = annotateResearchRoutes([structuredClone(ev)])[0].research_route;
  const generatorComposite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0] });
  assert.equal(collectorRoute.route, 'trump_weekly');
  assert.equal(generatorComposite.research_route, collectorRoute.route);
  assert.equal(generatorComposite.route_horizon, collectorRoute.horizon);
  // direct resolver agrees with both
  assert.equal(resolveResearchRoute(ev, { now: NOW }).route, 'trump_weekly');
});

test('route resolution happens before source/model extraction', async () => {
  // Generator: buildKalshiEventPacket is pure code (no model, no network) and
  // already carries research provenance — the model extraction stage receives
  // synthesisInput AFTER the route is resolved.
  const built = buildKalshiEventPacket({
    date: '2026-06-12',
    event: trumpWeeklyEvent(),
    sourceUrl: 'state/mentions/2026-06-12/kalshi-events/KXTRUMPMENTION-26JUN13.json',
  });
  assert.equal(built.researchProvenance.research_route, 'trump_weekly');
  assert.equal(built.synthesisInput.research_provenance.research_route, 'trump_weekly');

  // Collector: a dry-run watch (which never invokes generator/sender steps)
  // already has routes annotated on the attempted events.
  const tmp = mkdtempSync(join(tmpdir(), 'mentions-route-'));
  const eventsFile = join(tmp, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([{ ...bidenEvent() }]));
  const res = await watch({
    date: '2026-06-12',
    stateRoot: join(tmp, 'state'),
    dryRun: true,
    eventsFile,
    runStepImpl: () => { throw new Error('no step may run before routes resolve'); },
  });
  assert.equal(res.attempted.length, 1);
  assert.equal(res.attempted[0].research_route.route, 'speech_event');
});

test('non-Trump speech event routes to speech_event -> political_mentions', () => {
  const ev = bidenEvent();
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0] });
  assert.equal(composite.research_route, 'speech_event');
  assert.equal(composite.result.profile, ROUTE_TO_PROFILE.speech_event);
});

test('settled history feeds historical_tendency without prices and shows provenance', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mentions-hist-'));
  const stateRoot = join(tmp, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const rawSettled = [1, 2, 3, 4, 5].map((i) => ({
    ticker: `KXTRUMPMENTION-26MAY${String(i).padStart(2, '0')}-T`,
    event_ticker: `KXTRUMPMENTION-26MAY${String(i).padStart(2, '0')}`,
    series_ticker: 'KXTRUMPMENTION',
    title: 'Will Trump say "Tariff" this week?',
    yes_sub_title: 'Tariff',
    close_time: `2026-05-${String(i).padStart(2, '0')}T03:00:00Z`,
    result: i <= 4 ? 'yes' : 'no',
    yes_bid: 50, yes_ask: 55, volume: 100, open_interest: 80, // must be stripped
  }));
  await ingestSettledMarkets({ rawMarkets: rawSettled, route: 'trump_weekly', entity: 'trump', horizon: 'weekly', stateRoot });
  const historyRecords = await loadHistory({ stateRoot });
  assert.equal(historyRecords.length, 5);
  for (const r of historyRecords) {
    assert.ok(!('yes_bid' in r) && !('volume' in r) && !('open_interest' in r));
  }

  const ev = trumpWeeklyEvent();
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], historyRecords });
  assert.equal(composite.history_match_tier, 'exact_horizon');
  assert.equal(composite.history_sample_size, 5);
  assert.equal(composite.history_hits, 4);
  assert.equal(composite.history_misses, 1);
  assert.equal(composite.history_hit_rate, 0.8);
  const histRow = composite.result.evidence_ledger.find((l) => l.category === 'historical_tendency');
  assert.equal(histRow.present, true);
  assert.equal(histRow.value, 80);

  // Provenance appears in the deterministic slate text of the packet.
  const built = buildKalshiEventPacket({ date: '2026-06-12', event: ev, sourceUrl: 'x.json', historyRecords });
  assert.match(built.text, /research_route: trump_weekly/);
  assert.match(built.text, /Tariff: tier=exact_horizon n=5 hits=4 misses=1 hit_rate=0\.80/);
});

test('prices never enter scoring: composite identical with and without market prices, history on', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mentions-price-'));
  const stateRoot = join(tmp, 'state');
  await ingestSettledMarkets({
    rawMarkets: [{ ticker: 'KXTRUMPMENTION-26MAY01-T', series_ticker: 'KXTRUMPMENTION', event_ticker: 'KXTRUMPMENTION-26MAY01', title: 'Trump weekly', close_time: '2026-05-01T00:00:00Z', result: 'yes' }],
    route: 'trump_weekly', entity: 'trump', horizon: 'weekly', stateRoot,
  });
  const historyRecords = await loadHistory({ stateRoot });
  const withPrices = trumpWeeklyEvent();
  const noPrices = trumpWeeklyEvent();
  for (const k of ['yes_bid', 'yes_ask', 'volume', 'open_interest']) delete noPrices.markets[0][k];
  const a = buildMentionCompositeForMarket({ event: withPrices, market: withPrices.markets[0], historyRecords });
  const b = buildMentionCompositeForMarket({ event: noPrices, market: noPrices.markets[0], historyRecords });
  assert.equal(a.result.composite_score, b.result.composite_score);
  assert.equal(a.result.posture, b.result.posture);
  assert.equal(a.research_route, b.research_route);
});

test('empty history falls back safely without fake conviction', () => {
  const ev = trumpWeeklyEvent();
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], historyRecords: [] });
  assert.equal(composite.history_match_tier, null);
  const histRow = composite.result.evidence_ledger.find((l) => l.category === 'historical_tendency');
  assert.equal(histRow.present, false);
});

test('renderer stays deterministic with 9-section order, provenance fields tolerated', () => {
  const built = buildKalshiEventPacket({ date: '2026-06-12', event: trumpWeeklyEvent(), sourceUrl: 'x.json' });
  const text1 = renderMentionPacket(built.synthesisInput, { generatedAtUtc: '2026-06-12T12:00:00Z' });
  const text2 = renderMentionPacket(built.synthesisInput, { generatedAtUtc: '2026-06-12T12:00:00Z' });
  assert.equal(text1, text2);
  assert.equal(validateRenderedPacket(text1, built.synthesisInput), true);
  assert.equal(SECTION_ORDER.length, 9);
  let lastIdx = -1;
  for (const section of SECTION_ORDER) {
    const idx = text1.indexOf(section);
    assert.ok(idx > lastIdx, `section "${section}" out of order or missing`);
    lastIdx = idx;
  }
});

test('research-supplied historical_tendency wins over settled history', () => {
  const ev = trumpWeeklyEvent();
  ev.markets[0].layer_records = {
    historical_tendency: { present: true, score: 33, source_basis: 'research transcript hit-rate' },
  };
  const historyRecords = [
    { market_ticker: 'A', series_ticker: 'KXTRUMPMENTION', event_date: '2026-05-01', result: 'yes', route: 'trump_weekly', entity: 'trump', horizon: 'weekly' },
    { market_ticker: 'B', series_ticker: 'KXTRUMPMENTION', event_date: '2026-05-08', result: 'yes', route: 'trump_weekly', entity: 'trump', horizon: 'weekly' },
  ];
  const composite = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], historyRecords });
  const histRow = composite.result.evidence_ledger.find((l) => l.category === 'historical_tendency');
  assert.equal(histRow.value, 33, 'research-supplied layer must not be clobbered by settled history');
  // provenance still reports the match facts
  assert.equal(composite.history_match_tier, 'exact_horizon');
});

test('trump close-window boundaries: 8d weekly, 21d monthly, between=event, null=event, negative never weekly', () => {
  const base = (closeDays) => ({
    event_ticker: 'KXTRUMPMENTION-26X',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say at the summit?',
    close_time: closeDays === null ? null : new Date(NOW.getTime() + closeDays * 86400000).toISOString(),
    markets: [{ ticker: 'T1', title: 'Will Trump say "Deal"?', rules_primary: 'Resolves Yes if said.' }],
  });
  assert.equal(resolveResearchRoute(base(8), { now: NOW }).route, 'trump_weekly');
  assert.equal(resolveResearchRoute(base(21), { now: NOW }).route, 'trump_monthly');
  assert.equal(resolveResearchRoute(base(12), { now: NOW }).route, 'trump_event');
  assert.equal(resolveResearchRoute(base(null), { now: NOW }).route, 'trump_event');
  const past = resolveResearchRoute(base(-30), { now: NOW });
  assert.notEqual(past.route, 'trump_weekly', 'already-closed events must not imply weekly horizon');
});

test('null-result history records do not displace settled samples', async () => {
  const { buildHistoryMatch } = await import('../scripts/mentions/settled-history.mjs');
  const records = [
    // 5 most recent are unsettled (null result)...
    ...[10, 9, 8, 7, 6].map((d) => ({ market_ticker: `N${d}`, series_ticker: 'S', event_date: `2026-06-${d}`, result: null, route: 'trump_weekly', entity: 'trump', horizon: 'weekly' })),
    // ...older settled records carry the real signal
    ...[5, 4, 3].map((d) => ({ market_ticker: `Y${d}`, series_ticker: 'S', event_date: `2026-06-0${d}`, result: d === 3 ? 'no' : 'yes', route: 'trump_weekly', entity: 'trump', horizon: 'weekly' })),
  ];
  const match = buildHistoryMatch({ records, route: 'trump_weekly', entity: 'trump', horizon: 'weekly', seriesTicker: 'S' });
  assert.equal(match.sample_size, 3);
  assert.equal(match.hits, 2);
  assert.equal(match.misses, 1);
});

test('non-dry-run watch: route in ledger before generation; sender runs after generator', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mentions-watch-route-'));
  const stateRoot = join(tmp, 'state');
  const eventsFile = join(tmp, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([bidenEvent()]));
  const steps = [];
  const res = await watch({
    date: '2026-06-12',
    stateRoot,
    eventsFile,
    env: {},
    runStepImpl: (label) => {
      steps.push(label);
      if (label.startsWith('generator:')) {
        mkdirSync(join(stateRoot, 'packets', '2026-06-12', 'mentions-daily'), { recursive: true });
        writeFileSync(join(stateRoot, 'packets', '2026-06-12', 'mentions-daily', '2026-06-12-KXHBIDENMENTION-26JUN12.txt'), 'packet');
      }
    },
  });
  assert.deepEqual(res.succeeded, ['KXHBIDENMENTION-26JUN12']);
  assert.deepEqual(steps, ['generator:KXHBIDENMENTION-26JUN12', 'sender:KXHBIDENMENTION-26JUN12']);
  // Route was annotated at discovery — before any generate/send step ran.
  assert.equal(res.attempted[0].research_route.route, 'speech_event');
  const finalLedger = JSON.parse(
    readFileSync(join(stateRoot, 'mentions', '2026-06-12', 'seen-events.json'), 'utf8'));
  assert.equal(finalLedger.events['KXHBIDENMENTION-26JUN12'].research_route, 'speech_event');
  assert.equal(finalLedger.events['KXHBIDENMENTION-26JUN12'].status, 'delivered');
});
