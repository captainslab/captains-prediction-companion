import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildKalshiEventPacket } from '../scripts/packets/generate-mentions-daily.mjs';

function sectionBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const bodyStart = startIndex + start.length;
  const endIndex = end ? text.indexOf(end, bodyStart) : -1;
  return text.slice(bodyStart, endIndex === -1 ? undefined : endIndex);
}

function strongEarningsEvent() {
  return {
    event_ticker: 'KXDELLMENTION-99JAN01',
    title: 'Will Dell mention PowerEdge on its earnings call?',
    sub_title: 'Dell earnings call',
    series_ticker: 'KXDELLMENTION',
    markets: [
      {
        ticker: 'KXDELLMENTION-99JAN01-POWEREDGE',
        title: 'Will Dell mention PowerEdge?',
        yes_sub_title: 'PowerEdge',
        no_sub_title: 'No',
        close_time: '2099-01-01T23:00:00Z',
        expected_expiration_time: '2099-01-01T23:00:00Z',
        yes_bid_dollars: '0.57',
        yes_ask_dollars: '0.61',
        no_bid_dollars: '0.39',
        no_ask_dollars: '0.43',
        last_price_dollars: '0.59',
        liquidity_dollars: '1200.00',
        volume_fp: '11442',
        open_interest_fp: '300',
        rules_primary: 'If Dell says PowerEdge during the earnings call, this market resolves Yes.',
        mention_profile: 'earnings_mentions',
        layer_records: {
          event_proximity: {
            present: true,
            score: 95,
            source_basis: 'official IR calendar confirms Dell earnings call before market close',
          },
          historical_tendency: {
            present: true,
            score: 90,
            source_basis: 'closed-event calendar: 5/6 prior Dell earnings calls resolved YES',
          },
          prepared_remarks_likelihood: {
            present: true,
            score: 88,
            source_basis: 'prior prepared remarks repeatedly use PowerEdge in server discussion',
          },
          sec_filing_language: {
            present: true,
            score: 80,
            source_basis: 'SEC filing language includes PowerEdge in segment discussion',
          },
        },
      },
    ],
  };
}

test('mentions daily packet renders mention-composite scoring instead of WATCH-only posture', () => {
  const built = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  });
  const text = built.text;

  assert.match(text, /--- Composite Evidence ---/);
  assert.match(text, /scoring_model: mention_composite_v1/);
  assert.match(text, /target_mention: PowerEdge/);
  assert.match(text, /profile: earnings_mentions/);
  assert.match(text, /composite_score: \d+/);
  assert.match(text, /composite_posture: PICK/);
  assert.match(text, /layers_present: 4\/10/);
  assert.match(text, /top_support:/);
  assert.match(text, /missing_layers:/);
  assert.match(text, /source_notes:/);
  assert.match(text, /posture: PICK \(mention composite; research only, no trade\)/);
  assert.doesNotMatch(text, /^posture: WATCH/m);
});

test('mentions daily packet keeps market context only in NOT IN SCORE section', () => {
  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  }).text;

  const compositeEvidence = sectionBetween(text, '--- Composite Evidence ---', 'kalshi_contract_inventory_NOT_IN_SCORE:');
  const marketContext = sectionBetween(text, '--- Market Context - NOT IN SCORE ---', 'resolution_mechanics:');

  for (const term of ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'last_price', 'liquidity', 'volume', 'open_interest']) {
    assert.doesNotMatch(compositeEvidence, new RegExp(term, 'i'), `Composite Evidence must not contain ${term}`);
    assert.match(marketContext, new RegExp(term, 'i'), `Market Context - NOT IN SCORE must contain ${term}`);
  }
  assert.match(text, /pricing_excluded: true/);
});

test('mentions daily packet preserves all mention composite profiles', () => {
  const event = {
    event_ticker: 'KXMENTIONPROFILES-99JAN01',
    title: 'Mention profile coverage',
    sub_title: 'Profile smoke test',
    series_ticker: 'KXMENTIONPROFILES',
    markets: [
      {
        ticker: 'KXMENTIONPROFILES-POL',
        title: 'Will the speaker say tariff?',
        yes_sub_title: 'tariff',
        no_sub_title: 'No',
        mention_profile: 'political_mentions',
        layer_records: {
          event_proximity: { present: true, score: 80, source_basis: 'official speech schedule confirmed' },
        },
      },
      {
        ticker: 'KXMENTIONPROFILES-EARN',
        title: 'Will the company say revenue?',
        yes_sub_title: 'revenue',
        no_sub_title: 'No',
        mention_profile: 'earnings_mentions',
        layer_records: {
          event_proximity: { present: true, score: 80, source_basis: 'official earnings call schedule confirmed' },
        },
      },
      {
        ticker: 'KXMENTIONPROFILES-SPORT',
        title: 'Will the announcer say rivalry?',
        yes_sub_title: 'rivalry',
        no_sub_title: 'No',
        mention_profile: 'sports_announcer_mentions',
        layer_records: {
          event_proximity: { present: true, score: 80, source_basis: 'official broadcast schedule confirmed' },
        },
      },
    ],
  };

  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event,
    sourceUrl: '/tmp/profile-mentions.json',
  }).text;

  assert.match(text, /profile: political_mentions/);
  assert.match(text, /profile: earnings_mentions/);
  assert.match(text, /profile: sports_announcer_mentions/);
});

test('mentions packet generator preserves forbidden pricing field guard in layer records', () => {
  const event = strongEarningsEvent();
  event.markets[0].layer_records.event_proximity.yes_bid = 57;
  assert.throws(
    () => buildKalshiEventPacket({
      date: '2099-01-01',
      event,
      sourceUrl: '/tmp/dell-mentions.json',
    }),
    /forbidden pricing field "yes_bid"/i,
  );
});
