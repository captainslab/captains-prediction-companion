import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKalshiEventPacket,
  buildMentionCompositeForMarket,
  mentionCompositeToDecisionRow,
  synthesizeMentionsUserPacket,
  buildMentionsSynthesisPrompt,
  normalizeLayerList,
  buildFullStrikeInventoryAppendix,
  appendFullStrikeInventory,
  validateSynthesizedMentionPacket,
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
  // v2 customer renderer guarantee: a source-backed composite produces a
  // numeric CPC score and PICK posture in the canonical 8-section layout.
  const built = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  });
  const text = built.text;

  assert.match(text, /1\. FAST READ/);
  assert.match(text, /2\. CPC COMPOSITE BOARD/);
  assert.match(text, /PowerEdge/);
  assert.match(text, /\|\s*90\s*\|\s*PICK\s*\|/);
  assert.match(text, /missing baseline_relevance/);
  // strong source-backed market is NOT downgraded to a generic WATCH-only posture
  assert.doesNotMatch(text, /\|\s*90\s*\|\s*WATCH\s*\|/);
  assert.doesNotMatch(text, /TLDR BOARD|TOP EDGE CANDIDATES/);
});

test('mentions daily packet keeps market context only in NOT IN SCORE section', () => {
  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  }).text;

  // Explicit neutrality statement: market price is never a composite input.
  assert.match(text, /NEVER a score input/);

  // Pricing appears only in the market context section/column, never in
  // source-gap or trigger rationale sections.
  for (const line of text.split('\n')) {
    const isRationaleLine = /^\s*(- upgrade:|- downgrade:|- PowerEdge: missing)/.test(line);
    if (isRationaleLine) {
      for (const term of ['yes_bid', 'yes_ask', 'last=', 'implied=']) {
        assert.ok(!line.includes(term), `rationale line must not contain pricing token ${term}: ${line}`);
      }
    }
  }
  // Pricing is present only as compact context in section 5.
  assert.match(text, /5\. MARKET CONTEXT - NOT IN SCORE[\s\S]*bid range 57c[\s\S]*ask range 61c/);
});

test('mentions daily packet uses full strike text, not abbreviation-only labels', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  }).text;

  const board = text.split('3. TOP WATCH TERMS')[0].split('2. CPC COMPOSITE BOARD')[1];
  assert.match(board, /\|\s*Biden\s*\|/);
  assert.doesNotMatch(board, /What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
  assert.match(text, /Full Strike Inventory[\s\S]*What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
});

test('proximity-only mention rows are low-source capped, not source-backed composite', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  }).text;

  assert.match(text, /LOW-SOURCE WATCH only -- no pick/);
  assert.match(text, /LOW-SOURCE WATCH cap/);
  assert.doesNotMatch(text, /source-backed composite/i);
  assert.doesNotMatch(text, /\|\s*scaffold\s*\|/i);
});

test('old one-model mention packet_text synthesis is disabled', async () => {
  const built = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  });
  await assert.rejects(
    () => synthesizeMentionsUserPacket({
      input: built.synthesisInput,
      chatRunner: async () => ({ ok: true, parsed: { packet_text: 'old packet' } }),
    }),
    /model-written mentions packet_text synthesis is disabled/,
  );
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

test('model packet_text synthesis prompt fails closed for any layers_present shape', () => {
  for (const shape of [['event_proximity'], '1/4', { event_proximity: true }, 4, null, undefined, 'MISSING']) {
    assert.throws(() => buildMentionsSynthesisPrompt({
      date: '2026-06-11',
      event: { title: 'Trump Tele-Rally' },
      terms: [{
        full_strike_text: 'What will Donald Trump say during Burt Jones Tele-Rally? -- Biden',
        evidence_status: 'proximity-only source cap -- no pick',
        layers_present: shape,
        missing_research_layers: shape,
      }],
      layer_gaps: shape,
    }), /model-written mentions packet_text synthesis is disabled/);
  }
});

test('real generator pipeline produces v2 synthesis input with coverage-string layers_present normalized', () => {
  // End-to-end through buildKalshiEventPacket: decision rows carry
  // layers_present as a "present/total" string; the prompt builder must
  // normalize it rather than calling .join on a string.
  const built = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  });
  assert.ok(Array.isArray(built.synthesisInput.terms[0].layers_present));
  assert.equal(built.synthesisInput.packet_kind, 'mentions_customer_packet_v2');
  assert.equal(built.synthesisInput.synthesis_rules.model_written_final_packet_allowed, false);
});

// ─── full-strike reliability (Hunter Biden / "Event does not qualify" class) ─

const HUNTER_QUALIFY_STRIKE = 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Event does not qualify';
const HUNTER_NAMED_STRIKE = 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Trump';

function hunterSynthesisInput() {
  return {
    packet_kind: 'mentions_watch_user_packet_v1',
    date: '2026-06-12',
    event: { title: 'What will Hunter Biden say during This is Gavin Newsom Podcast?' },
    synthesis_rules: { use_full_strike_text_only: true },
    terms: [
      { full_strike_text: HUNTER_NAMED_STRIKE, evidence_status: 'proximity-only source cap -- no pick' },
      { full_strike_text: HUNTER_QUALIFY_STRIKE, evidence_status: 'proximity-only source cap -- no pick' },
    ],
  };
}

test('full strike inventory appendix lists every strike exactly, including "Event does not qualify"', () => {
  const appendix = buildFullStrikeInventoryAppendix(hunterSynthesisInput());
  assert.match(appendix, /Full Strike Inventory/);
  assert.ok(appendix.includes(`- ${HUNTER_NAMED_STRIKE}`));
  assert.ok(appendix.includes(`- ${HUNTER_QUALIFY_STRIKE}`));
});

test('model-written synthesis cannot restore omitted strikes because packet_text synthesis is disabled', async () => {
  const input = hunterSynthesisInput();
  await assert.rejects(
    () => synthesizeMentionsUserPacket({ input, chatRunner: async () => ({ ok: true, parsed: { packet_text: HUNTER_NAMED_STRIKE } }) }),
    /model-written mentions packet_text synthesis is disabled/,
  );
});

test('validation still catches a missing full strike when appendix is absent', () => {
  const input = hunterSynthesisInput();
  const textMissing = `Some packet\n${HUNTER_NAMED_STRIKE}\nMarket Context - NOT IN SCORE\nresearch-only`;
  assert.throws(() => validateSynthesizedMentionPacket(textMissing, input), /omitted full strike text.*Event does not qualify/);
  const textFull = appendFullStrikeInventory(textMissing, input);
  assert.doesNotThrow(() => validateSynthesizedMentionPacket(textFull, input));
});

test('abbreviation-only strike labels do not satisfy full-strike validation', () => {
  const input = hunterSynthesisInput();
  // Abbreviation-only labels ("Trump", "Event does not qualify" without the
  // event-question prefix) must not pass as full strike text.
  const abbrevOnly = 'Terms: Trump; Event does not qualify\nMarket Context - NOT IN SCORE\nresearch-only';
  assert.throws(() => validateSynthesizedMentionPacket(abbrevOnly, input), /omitted full strike text/);
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
  assert.match(text, /tariff/);
  assert.match(text, /revenue/);
  assert.match(text, /rivalry/);
  assert.match(text, /CPC COMPOSITE BOARD/);
  assert.match(text, /LOW-SOURCE WATCH cap/);
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
