// Phase 4 — route-aware, price-free settled-history lookup behind the lexical gate.
//
// Proves ORDER: Rules Analyst -> lexical gate -> settled history. History lookup
// runs ONLY after the gate clears a market to evidence (MATCH / PENDING /
// ROLLING_SUPPORTED). It NEVER runs for a hard block (BLOCKED_RULES_UNCLEAR /
// OUT_OF_SCOPE Truth Social) or for an evaluated NO_MATCH. Hits AND misses are
// recorded; EDNQ/ambiguous/unresolved never become confident; empty/no-match
// history fails safe; price-like fields never enter lookup or artifacts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSettledHistoryArtifact } from '../scripts/mentions/settled-history.mjs';
import { buildMentionCompositeForMarket } from '../scripts/packets/generate-mentions-daily.mjs';

// ---- fixtures ---------------------------------------------------------------

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
        custom_strike: 'Tariff',
        rules_primary: 'Resolves Yes if Trump says "Tariff" during the weekly window.',
        close_time: '2026-06-14T03:00:00Z',
        // price-like fields — must be stripped from any lookup/artifact
        yes_bid: 41, yes_ask: 44, volume: 1200, open_interest: 900,
      },
    ],
  };
}

function emptyRulesEvent() {
  return {
    event_ticker: 'KXGARBAGE-26JUN18',
    series_ticker: 'KXGARBAGE',
    title: '',
    sub_title: '',
    settlement_sources: [],
    markets: [{ ticker: 'KXGARBAGE-26JUN18-A' }],
  };
}

function truthSocialEvent() {
  return {
    event_ticker: 'KXTRUMPTRUTHSOCIAL-26JUN18',
    series_ticker: 'KXTRUMPTRUTHSOCIAL',
    title: 'What will Trump post on Truth Social?',
    markets: [
      {
        ticker: 'KXTRUMPTRUTHSOCIAL-26JUN18-TARIFF',
        title: 'Will Trump say tariff?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump posts tariff on Truth Social.',
      },
    ],
  };
}

const obamaHistory = [
  { market_ticker: 'OB-1', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes' },
  { market_ticker: 'OB-2', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-08', result: 'no', settlement_result: 'resolved_no' },
  { market_ticker: 'OB-3', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-15', result: 'yes', settlement_result: 'resolved_yes' },
];

const trumpWeeklyHistory = [
  { market_ticker: 'TW-1', series_ticker: 'KXTRUMPMENTION', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes', route: 'trump_weekly', entity: 'trump', horizon: 'weekly' },
  { market_ticker: 'TW-2', series_ticker: 'KXTRUMPMENTION', event_date: '2026-05-08', result: 'no', settlement_result: 'resolved_no', route: 'trump_weekly', entity: 'trump', horizon: 'weekly' },
];

// ===========================================================================
// Pipeline ordering — history runs only AFTER the lexical gate clears
// ===========================================================================

test('MATCH attaches settled_history after the lexical gate clears', () => {
  const ev = obamaEvent();
  const out = buildMentionCompositeForMarket({
    event: ev, market: ev.markets[0], candidateText: 'the kid waved', historyRecords: obamaHistory,
  });
  assert.equal(out.lexical_gate.decision, 'MATCH');
  assert.ok(out.settled_history, 'settled_history artifact must attach on MATCH');
  assert.equal(out.settled_history.match_tier, 'exact_horizon');
  assert.equal(out.settled_history.usable, true);
  assert.equal(out.settled_history.fail_safe, false);
  // legacy scalar provenance fields still populate from the same match
  assert.equal(out.history_match_tier, 'exact_horizon');
  assert.equal(out.history_sample_size, 3);
});

test('evaluated NO_MATCH blocks history even when matching records exist', () => {
  const ev = obamaEvent();
  const out = buildMentionCompositeForMarket({
    event: ev, market: ev.markets[0], candidateText: 'the adult spoke', historyRecords: obamaHistory,
  });
  assert.equal(out.lexical_gate.decision, 'NO_MATCH');
  assert.equal(out.research_route, 'talk_show_media', 'route is resolvable; only suppression skips history');
  assert.equal(out.settled_history, null, 'NO_MATCH must not run settled-history lookup');
  assert.equal(out.history_match_tier, null);
  assert.equal(out.history_hits, null);
  assert.equal(out.history_misses, null);
});

test('BLOCKED_RULES_UNCLEAR blocks history before any lookup', () => {
  const ev = emptyRulesEvent();
  const out = buildMentionCompositeForMarket({
    event: ev, market: ev.markets[0], candidateText: 'kid', historyRecords: obamaHistory,
  });
  assert.equal(out.lexical_gate.decision, 'BLOCK');
  assert.equal(out.settled_history, null, 'hard block must never reach settled-history lookup');
  assert.equal(out.history_match_tier, null);
});

test('Truth Social OUT_OF_SCOPE blocks history', () => {
  const ev = truthSocialEvent();
  const out = buildMentionCompositeForMarket({
    event: ev, market: ev.markets[0], candidateText: 'tariff',
    historyRecords: [
      { market_ticker: 'TS-1', series_ticker: 'KXTRUMPTRUTHSOCIAL', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes' },
      { market_ticker: 'TS-2', series_ticker: 'KXTRUMPTRUTHSOCIAL', event_date: '2026-05-08', result: 'yes', settlement_result: 'resolved_yes' },
    ],
  });
  assert.equal(out.lexical_gate.decision, 'OUT_OF_SCOPE');
  assert.equal(out.settled_history, null, 'Truth Social stays out-of-scope; no history lookup');
  assert.equal(out.history_match_tier, null);
});

test('weekly Trump stays legacy-supported and can attach history', () => {
  const ev = trumpWeeklyEvent();
  const out = buildMentionCompositeForMarket({
    event: ev, market: ev.markets[0], candidateText: 'tariff', historyRecords: trumpWeeklyHistory,
  });
  assert.equal(out.lexical_gate.hard_blocked, false, 'weekly rolling framing must not hard-block');
  assert.notEqual(out.lexical_gate.decision, 'OUT_OF_SCOPE');
  assert.notEqual(out.lexical_gate.decision, 'BLOCK');
  assert.ok(out.settled_history, 'weekly Trump can attach settled history');
  assert.equal(out.settled_history.match_tier, 'exact_horizon');
  assert.equal(out.settled_history.hits, 1);
  assert.equal(out.settled_history.misses, 1);
});

// ===========================================================================
// buildSettledHistoryArtifact — pure unit behavior
// ===========================================================================

test('exact series beats same route beats broader fallback', () => {
  const records = [
    { market_ticker: 'X', series_ticker: 'SER-A', result: 'yes', settlement_result: 'resolved_yes', route: 'r', entity: 'e', horizon: 'weekly' },
    { market_ticker: 'Y', series_ticker: 'SER-A', result: 'no', settlement_result: 'resolved_no', route: 'r', entity: 'e', horizon: 'weekly' },
  ];
  const exact = buildSettledHistoryArtifact({ records, route: 'r', entity: 'e', horizon: 'weekly', seriesTicker: 'SER-A' });
  assert.equal(exact.match_tier, 'exact_horizon');
  assert.equal(exact.match_quality_penalty, 0);

  const family = buildSettledHistoryArtifact({
    records: [
      { market_ticker: 'X', series_ticker: 'SER-A', result: 'yes', settlement_result: 'resolved_yes', route: 'r', entity: 'e', horizon: 'monthly' },
      { market_ticker: 'Y', series_ticker: 'SER-A', result: 'no', settlement_result: 'resolved_no', route: 'r', entity: 'e', horizon: 'monthly' },
    ],
    route: 'r', entity: 'e', horizon: 'weekly', seriesTicker: 'SER-Z',
  });
  assert.equal(family.match_tier, 'same_family');
  assert.equal(family.match_quality_penalty, 0.15);

  const broader = buildSettledHistoryArtifact({
    records: [
      { market_ticker: 'X', series_ticker: 'SER-B', result: 'yes', settlement_result: 'resolved_yes', route: 'r', entity: 'other', horizon: 'weekly' },
      { market_ticker: 'Y', series_ticker: 'SER-B', result: 'no', settlement_result: 'resolved_no', route: 'r', entity: 'other', horizon: 'weekly' },
    ],
    route: 'r', entity: 'e', horizon: 'weekly', seriesTicker: 'SER-Z',
  });
  assert.equal(broader.match_tier, 'broader_fallback');
  assert.equal(broader.match_quality_penalty, 0.30);
});

test('records hits AND misses: 2 yes + 3 no -> hit_rate 0.4', () => {
  const records = [
    { market_ticker: 'A', series_ticker: 'S', result: 'yes', settlement_result: 'resolved_yes', entity: 'e', horizon: 'h' },
    { market_ticker: 'B', series_ticker: 'S', result: 'yes', settlement_result: 'resolved_yes', entity: 'e', horizon: 'h' },
    { market_ticker: 'C', series_ticker: 'S', result: 'no', settlement_result: 'resolved_no', entity: 'e', horizon: 'h' },
    { market_ticker: 'D', series_ticker: 'S', result: 'no', settlement_result: 'resolved_no', entity: 'e', horizon: 'h' },
    { market_ticker: 'E', series_ticker: 'S', result: 'no', settlement_result: 'resolved_no', entity: 'e', horizon: 'h' },
  ];
  const a = buildSettledHistoryArtifact({ records, entity: 'e', horizon: 'h' });
  assert.equal(a.hits, 2);
  assert.equal(a.misses, 3);
  assert.equal(a.hit_rate, 0.4);
  assert.equal(a.settlement_breakdown.resolved_yes, 2);
  assert.equal(a.settlement_breakdown.resolved_no, 3);
  assert.equal(a.usable, true);
});

test('EDNQ/ambiguous/unresolved are recorded but never become confident hits/misses', () => {
  const records = [
    { market_ticker: 'A', series_ticker: 'S', result: null, settlement_result: 'ednq', entity: 'e', horizon: 'h' },
    { market_ticker: 'B', series_ticker: 'S', result: null, settlement_result: 'ambiguous', entity: 'e', horizon: 'h' },
    { market_ticker: 'C', series_ticker: 'S', result: null, settlement_result: 'unresolved', entity: 'e', horizon: 'h' },
  ];
  const a = buildSettledHistoryArtifact({ records, entity: 'e', horizon: 'h' });
  assert.equal(a.settlement_breakdown.ednq, 1);
  assert.equal(a.settlement_breakdown.ambiguous, 1);
  assert.equal(a.settlement_breakdown.unresolved, 1);
  assert.equal(a.hits, 0);
  assert.equal(a.misses, 0);
  assert.equal(a.hit_rate, null);
  assert.equal(a.usable, false, 'soft-only history is never confident');
  assert.equal(a.fail_safe, true);
});

test('empty / no-match history fails safe with no fake conviction', () => {
  const empty = buildSettledHistoryArtifact({ records: [], route: 'r', entity: 'e', horizon: 'h' });
  assert.equal(empty.match_tier, 'none');
  assert.equal(empty.hit_rate, null);
  assert.equal(empty.sample_size, 0);
  assert.equal(empty.usable, false);
  assert.equal(empty.fail_safe, true);

  // records exist but match nothing for this route/entity/series
  const noMatch = buildSettledHistoryArtifact({
    records: [{ market_ticker: 'Z', series_ticker: 'OTHER', result: 'yes', settlement_result: 'resolved_yes', route: 'rx', entity: 'ex', horizon: 'hx' }],
    route: 'r', entity: 'e', horizon: 'h', seriesTicker: 'S',
  });
  assert.equal(noMatch.match_tier, 'none');
  assert.equal(noMatch.usable, false);
  assert.equal(noMatch.fail_safe, true);
});

test('single settled outcome (n<2) is insufficient — not confident', () => {
  const a = buildSettledHistoryArtifact({
    records: [{ market_ticker: 'A', series_ticker: 'S', result: 'yes', settlement_result: 'resolved_yes', entity: 'e', horizon: 'h' }],
    entity: 'e', horizon: 'h',
  });
  assert.equal(a.sample_size, 1);
  assert.equal(a.usable, false);
  assert.equal(a.fail_safe, true);
  assert.match(a.note, /n<2/);
});

test('price-like fields in history fixtures are ignored and never appear in the artifact', () => {
  const records = [
    { market_ticker: 'A', series_ticker: 'S', result: 'yes', settlement_result: 'resolved_yes', entity: 'e', horizon: 'h', yes_bid: 50, yes_ask: 55, volume: 100, open_interest: 80, spread: 5, last_price: 52 },
    { market_ticker: 'B', series_ticker: 'S', result: 'no', settlement_result: 'resolved_no', entity: 'e', horizon: 'h', yes_bid: 10, volume: 999, open_interest: 7 },
  ];
  const a = buildSettledHistoryArtifact({ records, entity: 'e', horizon: 'h' });
  // outcomes still computed from result, untouched by price
  assert.equal(a.hits, 1);
  assert.equal(a.misses, 1);
  const json = JSON.stringify(a);
  assert.doesNotMatch(json, /bid|ask|volume|open_interest|spread|last_price|odds|liquidity|notional/i);
});
