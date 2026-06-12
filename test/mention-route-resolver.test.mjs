import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESEARCH_ROUTES,
  ROUTE_TO_PROFILE,
  FUTURE_SOURCE_POLICY,
  resolveResearchRoute,
} from '../scripts/mentions/mention-route-resolver.mjs';

const NOW = new Date('2026-06-12T12:00:00Z');

function isoDaysOut(days) {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function fixture(overrides = {}) {
  return {
    event_ticker: 'KXMENTION-26JUN15',
    series_ticker: 'KXMENTION',
    title: 'Mention market',
    sub_title: '',
    markets: [],
    ...overrides,
  };
}

test('detects earnings_call route', () => {
  const event = fixture({
    event_ticker: 'KXEARNINGSMENTIONADBE-26JUN12',
    series_ticker: 'KXEARNINGSMENTION',
    title: 'What will Adobe say during their earnings call?',
    markets: [{ title: 'Mentions "AI" on quarterly results call', rules_primary: 'Resolves YES if the CFO says AI on the earnings call.' }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'earnings_call');
  assert.equal(res.profile_key, 'earnings_mentions');
});

test('detects sports_announcer route', () => {
  const event = fixture({
    event_ticker: 'KXNBAMENTION-26JUN12LALBOS',
    series_ticker: 'KXNBAMENTION',
    title: 'What will the announcers say during the NBA Finals broadcast?',
    markets: [{ title: 'Mentions "dynasty"', rules_primary: 'Resolves YES if a commentator says dynasty during the game broadcast on ESPN.' }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'sports_announcer');
  assert.equal(res.profile_key, 'sports_announcer_mentions');
});

test('detects political_general route (Biden, no Trump)', () => {
  const event = fixture({
    event_ticker: 'KXHBIDENMENTION-26JUN12',
    series_ticker: 'KXHBIDENMENTION',
    title: 'What will Biden say during his campaign speech?',
    markets: [{ title: 'Mentions "economy"', rules_primary: 'Resolves YES if Biden says economy at the rally.' }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'political_general');
  assert.equal(res.profile_key, 'political_mentions');
  assert.equal(res.entity, null);
});

test('detects trump_weekly via weekly title term', () => {
  const event = fixture({
    event_ticker: 'KXTRUMPMENTION-26JUN15',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say this week?',
    markets: [{ title: 'Mentions "tariffs"', close_time: isoDaysOut(15) }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'trump_weekly');
  assert.equal(res.entity, 'trump');
  assert.equal(res.horizon, 'weekly');
  assert.equal(res.basis, 'trump_weekly_ticker_term');
});

test('detects trump_weekly via close window <= 8 days', () => {
  const event = fixture({
    event_ticker: 'KXTRUMPMENTION-26JUN17',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say?',
    markets: [{ title: 'Mentions "border"', close_time: isoDaysOut(5) }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'trump_weekly');
  assert.equal(res.basis, 'trump_weekly_close_window');
  assert.ok(res.close_window_days <= 8);
});

test('detects trump_monthly via monthly title term', () => {
  const event = fixture({
    event_ticker: 'KXTRUMPMENTIONM-26JUN',
    series_ticker: 'KXTRUMPMENTIONM',
    title: 'What will Trump say this month? (June)',
    markets: [{ title: 'Mentions "crypto"', close_time: isoDaysOut(30) }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'trump_monthly');
  assert.equal(res.horizon, 'monthly');
  assert.equal(res.basis, 'trump_monthly_ticker_term');
});

test('detects trump_monthly via close window >= 21 days', () => {
  const event = fixture({
    event_ticker: 'KXTRUMPMENTION-26JUL12',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say?',
    markets: [{ title: 'Mentions "nato"', close_time: isoDaysOut(30) }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'trump_monthly');
  assert.equal(res.basis, 'trump_monthly_close_window');
  assert.ok(res.close_window_days >= 21);
});

test('detects trump_event for single event with 10-day window', () => {
  const event = fixture({
    event_ticker: 'KXTRUMPMENTION-26JUN22',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say during the debate?',
    markets: [{ title: 'Mentions "crooked"', close_time: isoDaysOut(10) }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'trump_event');
  assert.equal(res.horizon, 'event');
  assert.ok(res.close_window_days > 8 && res.close_window_days < 21);
});

test('detects talk_show_media route', () => {
  const event = fixture({
    event_ticker: 'KXSNLMENTION-26JUN13',
    series_ticker: 'KXSNLMENTION',
    title: 'What will be said on SNL this weekend?',
    markets: [{ title: 'Mentions "aliens"', rules_primary: 'Resolves YES if said during the late night show.' }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'talk_show_media');
  assert.equal(res.profile_key, 'political_mentions');
});

test('detects entertainment_reality route', () => {
  const event = fixture({
    event_ticker: 'KXLOVEISLANDMENTION-26JUN14',
    series_ticker: 'KXLOVEISLANDMENTION',
    title: 'What will be said on Love Island?',
    markets: [{ title: 'Mentions "the ick"', rules_primary: 'Resolves YES if said on the reality show episode.' }],
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'entertainment_reality');
});

test('default fallback is political_general', () => {
  const event = fixture({
    event_ticker: 'KXMYSTERYMENTION-26JUN12',
    series_ticker: 'KXMYSTERYMENTION',
    title: 'Will the keyword be said?',
  });
  const res = resolveResearchRoute(event, { now: NOW });
  assert.equal(res.route, 'political_general');
  assert.equal(res.basis, 'default_political_general');
});

test('ROUTE_TO_PROFILE maps exactly as specced and covers all routes', () => {
  assert.deepEqual(ROUTE_TO_PROFILE, {
    sports_announcer: 'sports_announcer_mentions',
    earnings_call: 'earnings_mentions',
    political_general: 'political_mentions',
    trump_event: 'political_mentions',
    trump_weekly: 'political_mentions',
    trump_monthly: 'political_mentions',
    talk_show_media: 'political_mentions',
    entertainment_reality: 'political_mentions',
  });
  for (const route of RESEARCH_ROUTES) {
    assert.ok(Object.hasOwn(ROUTE_TO_PROFILE, route), `missing mapping for ${route}`);
  }
  assert.equal(RESEARCH_ROUTES.length, 8);
});

test('resolver is deterministic for identical input', () => {
  const event = fixture({
    event_ticker: 'KXTRUMPMENTION-26JUN17',
    title: 'What will Trump say this week?',
    markets: [{ title: 'Mentions "tariffs"', close_time: isoDaysOut(5) }],
  });
  const a = resolveResearchRoute(event, { now: NOW });
  const b = resolveResearchRoute(event, { now: NOW });
  assert.deepEqual(a, b);
});

test('resolver never reads price fields', () => {
  const base = fixture({
    event_ticker: 'KXTRUMPMENTION-26JUN17',
    title: 'What will Trump say this week?',
    markets: [{ title: 'Mentions "tariffs"', close_time: isoDaysOut(5) }],
  });
  const priced = structuredClone(base);
  priced.markets[0].yes_bid = 42;
  priced.markets[0].yes_ask = 47;
  priced.markets[0].volume = 12345;
  priced.markets[0].open_interest = 678;
  assert.deepEqual(
    resolveResearchRoute(priced, { now: NOW }),
    resolveResearchRoute(base, { now: NOW }),
  );
});

test('FUTURE_SOURCE_POLICY records @truthtrumpposts as mirror/proxy', () => {
  assert.deepEqual(FUTURE_SOURCE_POLICY.truth_social.mirror_sources, ['@truthtrumpposts']);
  assert.match(FUTURE_SOURCE_POLICY.truth_social.note, /mirror\/proxy/);
  assert.match(FUTURE_SOURCE_POLICY.truth_social.note, /NOT direct source proof/);
});

test('Trump as a strike term only (non-Trump speaker event) does NOT route to trump_*', () => {
  const ev = {
    event_ticker: 'KXMAMDANIMENTION-26JUN12',
    series_ticker: 'KXMAMDANIMENTION',
    title: 'What will Mamdani say at the rally?',
    close_time: '2026-06-12T23:00:00Z',
    markets: [{
      ticker: 'KXMAMDANIMENTION-26JUN12-TRUMP',
      title: 'Will Mamdani say "Trump"?',
      yes_sub_title: 'Trump',
      rules_primary: 'Resolves Yes if Mamdani says "Trump" during the rally.',
      close_time: '2026-06-12T23:00:00Z',
    }],
  };
  const res = resolveResearchRoute(ev, { now: new Date('2026-06-12T12:00:00Z') });
  assert.equal(res.route, 'political_general');
  assert.equal(res.entity, null);
});
