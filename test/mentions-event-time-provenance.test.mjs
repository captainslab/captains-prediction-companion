import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanonicalMentionIdentity,
  canonicalEventTime,
  formatCanonicalEventTime,
  validateCanonicalMentionIdentity,
} from '../scripts/mentions/event-integrity.mjs';
import { buildEventResearch } from '../scripts/mentions/collect-mentions-research.mjs';
import { resolveResearchRoute } from '../scripts/mentions/mention-route-resolver.mjs';
import {
  buildKalshiEventPacket,
  mergeResearchIntoEvent,
} from '../scripts/packets/generate-mentions-daily.mjs';
import {
  renderMentionPacket,
  validateRenderedPacket,
} from '../scripts/mentions/render-mention-packet.mjs';

const GENERATED = '2026-08-20T12:00:00.000Z';
const RESEARCHED = '2026-08-20T11:00:00.000Z';

function eventFixture({ ticker, series, title, schedule = undefined }) {
  return {
    event_ticker: ticker,
    series_ticker: series,
    title,
    sub_title: title,
    event_url: `https://kalshi.com/events/${ticker}`,
    settlement_sources: [{ url: 'https://example.com/official-schedule' }],
    research_timestamp: RESEARCHED,
    ...(schedule ? { schedule } : {}),
    markets: [{
      ticker: `${ticker}-WORD`,
      event_ticker: ticker,
      title: `${title}: budget`,
      yes_sub_title: 'budget',
      rules_primary: 'Resolves YES if the exact term is used during the covered event.',
    }],
  };
}

function identityFor(route, event) {
  return buildCanonicalMentionIdentity({
    date: '2026-08-26',
    event,
    route,
    generatedUtc: GENERATED,
    researchTimestamp: RESEARCHED,
  });
}

async function discoveredResearch(event, profile) {
  return buildEventResearch(event, profile, { date: null, env: {} });
}

test('canonicalEventTime has exactly three provenance statuses and preserves source fields', () => {
  const exact = canonicalEventTime({ event_time_utc: '2026-08-26T15:00:00Z' });
  assert.deepEqual(exact, {
    status: 'EXACT',
    iso: '2026-08-26T15:00:00.000Z',
    source: 'event_time_utc',
    conflicts: [],
  });

  const dateWindow = canonicalEventTime({ event_time: '2026-08-26' });
  assert.deepEqual(dateWindow, {
    status: 'DATE_WINDOW',
    iso: '2026-08-26T00:00:00.000Z',
    calendar_date: '2026-08-26',
    source: 'event_time',
    conflicts: [],
  });

  const unconfirmed = canonicalEventTime({});
  assert.deepEqual(unconfirmed, { status: 'UNCONFIRMED', iso: null, source: null, conflicts: [] });
  assert.equal(formatCanonicalEventTime({ event_time_central: dateWindow }), 'Aug 26, 2026 (DATE_WINDOW)');
  assert.equal(formatCanonicalEventTime({ event_time_central: unconfirmed }), 'UNCONFIRMED');
});

test('research discovery carries earnings, political, debate, and Trump schedule timing onto the event', async () => {
  const cases = [
    {
      profile: 'earnings_mentions',
      route: 'earnings_call',
      event: eventFixture({
        ticker: 'KXEARNINGSMENTIONNVDA-26AUG26',
        series: 'KXEARNINGSMENTIONNVDA',
        title: 'What will NVIDIA say during their next earnings call?',
        schedule: { event_date_utc: '2026-08-26T15:00:00Z', confirmed: true },
      }),
      expected: '2026-08-26T15:00:00Z',
    },
    {
      profile: 'political_mentions',
      route: 'debate_hearing',
      event: eventFixture({
        ticker: 'KXHOUSEHEARING-26AUG26',
        series: 'KXHOUSEHEARING',
        title: 'What will the Senate hearing witness say?',
        schedule: { event_date_utc: '2026-08-26', confirmed: true },
      }),
      expected: '2026-08-26',
    },
    {
      profile: 'political_mentions',
      route: 'trump_event',
      event: eventFixture({
        ticker: 'KXTRUMPMENTION-26AUG26',
        series: 'KXTRUMPMENTION',
        title: 'What will Trump say during the rally?',
        schedule: { event_date_utc: '2026-08-26T19:00:00Z', confirmed: true },
      }),
      expected: '2026-08-26T19:00:00Z',
    },
  ];

  for (const { profile, route, event, expected } of cases) {
    assert.equal(resolveResearchRoute(event).route, route);
    const research = await discoveredResearch(event, profile);
    assert.equal(research.event_time, expected);
    const merged = mergeResearchIntoEvent(event, research);
    assert.equal(merged.event_time, expected);
    const reloaded = JSON.parse(JSON.stringify(merged));
    const identity = identityFor(route, reloaded);
    assert.equal(identity.event_time_central.source, 'event_time');
    assert.equal(identity.event_time_central.status, expected.length === 10 ? 'DATE_WINDOW' : 'EXACT');
    assert.equal(validateCanonicalMentionIdentity(identity, route).ok, true);
  }
});

test('earnings history timing, sports absence, and comparative allowance survive packet construction', () => {
  const earnings = eventFixture({
    ticker: 'KXEARNINGSMENTIONNVDA-26AUG26',
    series: 'KXEARNINGSMENTIONNVDA',
    title: 'What will NVIDIA say during their next earnings call?',
  });
  const earningsBuilt = buildKalshiEventPacket({
    date: '2026-08-26',
    event: earnings,
    sourceUrl: '/tmp/earnings.json',
    earningsQuarters: [{
      event_ticker: earnings.event_ticker,
      event_date: '2026-08-26T15:00:00Z',
      completed: true,
      outcomes: { budget: 'yes' },
    }],
    generatedUtc: GENERATED,
  });
  assert.equal(earningsBuilt.synthesisInput.canonical_event.event_time_central.status, 'EXACT');
  assert.equal(earningsBuilt.synthesisInput.canonical_event.event_time_central.source, 'event_time');

  const sports = eventFixture({
    ticker: 'KXMLBANNOUNCER-26AUG26',
    series: 'KXMLBANNOUNCER',
    title: 'What will the announcer say during the MLB game?',
  });
  const sportsBuilt = buildKalshiEventPacket({
    date: '2026-08-26', event: sports, sourceUrl: '/tmp/sports.json', generatedUtc: GENERATED,
  });
  assert.equal(sportsBuilt.publication_blocked, true);
  assert.equal(sportsBuilt.publication_blocker.source_gaps.includes('authoritative event start time unconfirmed'), true);
  assert.equal(sportsBuilt.publication_blocker.event_time_status, 'UNCONFIRMED');
  assert.equal(sportsBuilt.publication_blocker.event_time_source, null);
  const sportsIdentity = identityFor('sports_announcer', sports);
  assert.equal(sportsIdentity.event_time_central.status, 'UNCONFIRMED');
  assert.equal(validateCanonicalMentionIdentity(sportsIdentity, 'sports_announcer').ok, false);

  const comparative = eventFixture({
    ticker: 'KXTOPIC-26AUG26',
    series: 'KXTOPIC',
    title: 'Which topic will be mentioned most during the show?',
  });
  const comparativeIdentity = identityFor('topic_most_mentioned', comparative);
  assert.equal(comparativeIdentity.event_time_central.status, 'UNCONFIRMED');
  assert.equal(validateCanonicalMentionIdentity(comparativeIdentity, 'topic_most_mentioned').ok, true);
  const comparativeBuilt = buildKalshiEventPacket({
    date: '2026-08-26', event: comparative, sourceUrl: '/tmp/topic.json', generatedUtc: GENERATED,
  });
  assert.equal(comparativeBuilt.publication_blocked, false);
  const rendered = renderMentionPacket(comparativeBuilt.synthesisInput, { generatedAtUtc: GENERATED });
  validateRenderedPacket(rendered, comparativeBuilt.synthesisInput);
  assert.match(rendered, /event_time_central: UNCONFIRMED/);
  assert.match(rendered, /event_time_central_status: UNCONFIRMED/);
});

test('close, expiration, expected-expiration, and occurrence metadata never become event start timing', () => {
  const event = {
    close_time: '2026-08-26T15:00:00Z',
    expiration_time: '2026-08-26T15:00:00Z',
    expected_expiration_time: '2026-08-26T15:00:00Z',
    occurrence_datetime: '2026-08-26T15:00:00Z',
  };
  const time = canonicalEventTime(event);
  assert.equal(time.status, 'UNCONFIRMED');
  assert.equal(time.iso, null);
  assert.equal(time.source, null);
});
