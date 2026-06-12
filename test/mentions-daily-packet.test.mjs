import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKalshiEventPacket,
  buildMentionCompositeForMarket,
  mentionCompositeToDecisionRow,
  synthesizeMentionsUserPacket,
  buildMentionsSynthesisPrompt,
  normalizeLayerList,
} from '../scripts/packets/generate-mentions-daily.mjs';

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

function trumpTeleRallyEvent() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUN11',
    title: 'What will Trump say during his Burt Jones Tele-Rally?',
    sub_title: 'Donald Trump - Burt Jones Tele-Rally',
    series_ticker: 'KXTRUMPMENTION',
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26JUN11-BIDE',
        title: 'What will Donald Trump say during Burt Jones Tele-Rally?',
        yes_sub_title: 'Biden',
        no_sub_title: 'Biden',
        custom_strike: { Word: 'Biden' },
        yes_bid_dollars: '0.0100',
        yes_ask_dollars: '0.0200',
        last_price_dollars: '0.0200',
        rules_primary: 'If Donald Trump says Biden as part of Burt Jones Tele-Rally, then the market resolves to Yes.',
        mention_profile: 'political_mentions',
        layer_records: {
          event_proximity: {
            present: true,
            score: 10,
            source_basis: 'official speech schedule confirmed',
          },
        },
      },
    ],
  };
}

test('mentions daily packet renders mention-composite scoring instead of WATCH-only posture', () => {
  // Refactored to the compact sectioned decision board. Same guarantee:
  // a source-backed composite produces an actual scored PICK row (not WATCH-only),
  // with the composite score, posture, and layer coverage surfaced.
  const built = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  });
  const text = built.text;

  // sectioned board, not the old YAML wall
  assert.match(text, /TLDR BOARD:/);
  assert.match(text, /TOP EDGE CANDIDATES/);
  // composite scoring surfaced: PICK posture, real score, layer coverage
  assert.match(text, /\[PICK\]/);
  assert.match(text, /PowerEdge/);
  assert.match(text, /score=90/);
  assert.match(text, /posture=PICK/);
  assert.match(text, /layers=4\/10/);
  // why-line carries the present + missing layers
  assert.match(text, /event_proximity=95/);
  assert.match(text, /Missing:/);
  // strong source-backed market is NOT downgraded to a generic WATCH-only posture
  assert.doesNotMatch(text, /posture=WATCH/);
});

test('mentions daily packet keeps market context only in NOT IN SCORE section', () => {
  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  }).text;

  // Explicit neutrality statement: market price is never a composite input.
  assert.match(text, /NEVER a composite input/);

  // Pricing (bid/ask/last) appears ONLY on the `market:` line, never on the
  // `model:` / `why:` composite lines.
  for (const line of text.split('\n')) {
    const isModelLine = /^\s*(model:|why:)/.test(line);
    if (isModelLine) {
      for (const term of ['yes_bid', 'yes_ask', 'last=', 'implied=']) {
        assert.ok(!line.includes(term), `composite line must not contain pricing token ${term}: ${line}`);
      }
    }
  }
  // Pricing is present, but on the market half.
  assert.match(text, /market: implied=.*yes_bid=57 yes_ask=61 last=59/);
});

test('mentions daily packet uses full strike text, not abbreviation-only labels', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  }).text;

  assert.match(text, /KXTRUMPMENTION-26JUN11-BIDE :: What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
  assert.doesNotMatch(text, /KXTRUMPMENTION-26JUN11-BIDE :: Biden(?:\n|$)/);
});

test('proximity-only mention rows are labeled scaffold-only, not source-backed composite', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  }).text;

  assert.match(text, /proximity scaffold only -- no pick/);
  assert.doesNotMatch(text, /source-backed composite/i);
});

test('one-model mention synthesis uses dynamic default Hermes routing with no hardcoded provider/model', async () => {
  const built = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  });
  const fullStrike = built.synthesisInput.terms[0].full_strike_text;
  const calls = [];

  const result = await synthesizeMentionsUserPacket({
    input: built.synthesisInput,
    chatRunner: async (prompt, options) => {
      calls.push({ prompt, options });
      return {
        ok: true,
        status: 0,
        sessionId: 'test-session',
        parsed: {
          packet_text: [
            'Event title: What will Trump say during his Burt Jones Tele-Rally?',
            'Date/time: 2026-06-11',
            'Setup: proximity scaffold only -- no pick.',
            `Watch-only terms: ${fullStrike} - proximity scaffold only -- no pick.`,
            'Blocked/no-source terms: none.',
            'Missing research layers: transcript, quote, historical tendency.',
            'What would upgrade/downgrade the read: official transcript or video exact phrase.',
            'Market Context - NOT IN SCORE: yes bid/ask are context only.',
            'Research-only footer: No trades placed. Research-only.',
          ].join('\n'),
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].options, 'provider'), false);
  assert.equal(Object.hasOwn(calls[0].options, 'model'), false);
  assert.equal(calls[0].options.source, 'mentions-watch-packet-synthesis');
  assert.match(calls[0].prompt, /source_packet:/);
  assert.equal(result.invocation.provider_arg, 'omitted');
  assert.equal(result.invocation.model_arg, 'omitted');
  assert.match(result.text, /What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
});

test('normalizeLayerList tolerates every layers_present shape', () => {
  assert.deepEqual(normalizeLayerList(['event_proximity', 'historical_tendency']), ['event_proximity', 'historical_tendency']);
  assert.deepEqual(normalizeLayerList([{ category: 'event_proximity' }, { label: 'sec_filing_language' }]), ['event_proximity', 'sec_filing_language']);
  assert.deepEqual(normalizeLayerList('1/4'), ['1/4']);
  assert.deepEqual(normalizeLayerList('a, b'), ['a', 'b']);
  assert.deepEqual(normalizeLayerList('MISSING'), []);
  assert.deepEqual(normalizeLayerList({ event_proximity: true, historical_tendency: true }), ['event_proximity', 'historical_tendency']);
  assert.deepEqual(normalizeLayerList(4), []);
  assert.deepEqual(normalizeLayerList(null), []);
  assert.deepEqual(normalizeLayerList(undefined), []);
});

test('synthesis prompt does not crash for any layers_present shape (the .join regression)', () => {
  for (const shape of [['event_proximity'], '1/4', { event_proximity: true }, 4, null, undefined, 'MISSING']) {
    const prompt = buildMentionsSynthesisPrompt({
      date: '2026-06-11',
      event: { title: 'Trump Tele-Rally' },
      terms: [{
        full_strike_text: 'What will Donald Trump say during Burt Jones Tele-Rally? -- Biden',
        evidence_status: 'proximity scaffold only -- no pick',
        layers_present: shape,
        missing_research_layers: shape,
      }],
      layer_gaps: shape,
    });
    assert.match(prompt, /full_strike_text: What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
  }
});

test('real generator pipeline produces a synthesis prompt without crashing on coverage-string layers_present', () => {
  // End-to-end through buildKalshiEventPacket: decision rows carry
  // layers_present as a "present/total" string; the prompt builder must
  // normalize it rather than calling .join on a string.
  const built = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  });
  assert.ok(Array.isArray(built.synthesisInput.terms[0].layers_present));
  const prompt = buildMentionsSynthesisPrompt(built.synthesisInput);
  assert.match(prompt, /layers_present:/);
});

test('mention implied probability is sane for 1/2 cent prices', () => {
  const ev = trumpTeleRallyEvent();
  const row = mentionCompositeToDecisionRow(buildMentionCompositeForMarket({ event: ev, market: ev.markets[0] }));
  assert.equal(row.market_yes_bid, 1);
  assert.equal(row.market_yes_ask, 2);
  assert.equal(row.implied_probability, 0.015);
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

  // All three profile markets render in the board (profile routing preserved).
  assert.match(text, /KXMENTIONPROFILES-POL/);
  assert.match(text, /tariff/);
  assert.match(text, /KXMENTIONPROFILES-EARN/);
  assert.match(text, /revenue/);
  assert.match(text, /KXMENTIONPROFILES-SPORT/);
  assert.match(text, /rivalry/);
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
