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

test('mentions daily packet renders stacked cards instead of the old wide board', () => {
  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  }).text;

  assert.match(text, /1\. FAST READ/);
  assert.match(text, /2\. TOP YES CASE/);
  assert.match(text, /PowerEdge/);
  assert.match(text, /PowerEdge — P\(YES\) 88 — STRONG YES/);
  assert.match(text, /Why it could hit:/);
  assert.match(text, /Settlement fit:/);
  assert.match(text, /Research: source-backed \/ fresh/);
  assert.doesNotMatch(text, /RANKED BOARD|TOP RESEARCHED TERMS|TLDR BOARD|TOP EDGE CANDIDATES|LOW-SOURCE WATCH/);
});

test('mentions daily packet keeps market context display-only / NOT IN SCORE', () => {
  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  }).text;

  assert.match(text, /Market Context - NOT IN SCORE: display-only context; never a score input\./);
  assert.doesNotMatch(text, /yes_bid|yes_ask|last=|implied=/);
  assert.doesNotMatch(text, /Market Context - NOT IN SCORE[\s\S]*bid range/);
});

test('mentions daily packet uses full strike text, not abbreviation-only labels', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  }).text;

  const inventory = text.split('8. FULL STRIKE INVENTORY')[1];
  assert.match(inventory, /What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
  assert.doesNotMatch(inventory, /Biden — P\(YES\)/);
  assert.match(text, /8\. FULL STRIKE INVENTORY[\s\S]*What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
});

test('proximity-only mention rows are low-source capped, not source-backed composite', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  }).text;

  assert.match(text, /RESEARCH GAP/);
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

test('buildMentionsSynthesisPrompt stays disabled even when source layers are present', () => {
  assert.throws(() => buildMentionsSynthesisPrompt({
    date: '2026-06-11',
    event: { title: 'Trump Tele-Rally' },
    terms: [{
      full_strike_text: 'What will Donald Trump say during Burt Jones Tele-Rally? -- Biden',
      evidence_status: 'source-backed',
      layers_present: ['event_proximity', 'historical_tendency'],
      missing_research_layers: [],
    }],
  }), /model-written mentions packet_text synthesis is disabled/);
});

test('full strike inventory appendix lists every strike exactly, including "Event does not qualify"', () => {
  const input = {
    packet_kind: 'mentions_watch_user_packet_v1',
    date: '2026-06-12',
    event: { title: 'What will Hunter Biden say during This is Gavin Newsom Podcast?' },
    synthesis_rules: { use_full_strike_text_only: true },
    terms: [
      { full_strike_text: 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Trump', evidence_status: 'proximity-only source cap -- no pick' },
      { full_strike_text: 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Event does not qualify', evidence_status: 'proximity-only source cap -- no pick' },
    ],
  };
  const appendix = buildFullStrikeInventoryAppendix(input);
  assert.match(appendix, /Full Strike Inventory/);
  assert.ok(appendix.includes('- What will Hunter Biden say during This is Gavin Newsom Podcast? -- Trump'));
  assert.ok(appendix.includes('- What will Hunter Biden say during This is Gavin Newsom Podcast? -- Event does not qualify'));
});

test('validation catches a missing full strike when appendix is absent', () => {
  const input = {
    packet_kind: 'mentions_watch_user_packet_v1',
    date: '2026-06-12',
    event: { title: 'What will Hunter Biden say during This is Gavin Newsom Podcast?' },
    synthesis_rules: { use_full_strike_text_only: true },
    terms: [
      { full_strike_text: 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Trump', evidence_status: 'proximity-only source cap -- no pick' },
      { full_strike_text: 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Event does not qualify', evidence_status: 'proximity-only source cap -- no pick' },
    ],
  };
  const textMissing = `Some packet\nWhat will Hunter Biden say during This is Gavin Newsom Podcast? -- Trump\nMarket Context - NOT IN SCORE\nresearch-only`;
  assert.throws(() => validateSynthesizedMentionPacket(textMissing, input), /omitted full strike text.*Event does not qualify/);
  const textFull = appendFullStrikeInventory(textMissing, input);
  assert.doesNotThrow(() => validateSynthesizedMentionPacket(textFull, input));
});

test('abbreviation-only strike labels do not satisfy full-strike validation', () => {
  const input = {
    packet_kind: 'mentions_watch_user_packet_v1',
    date: '2026-06-12',
    event: { title: 'What will Hunter Biden say during This is Gavin Newsom Podcast?' },
    synthesis_rules: { use_full_strike_text_only: true },
    terms: [
      { full_strike_text: 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Trump', evidence_status: 'proximity-only source cap -- no pick' },
      { full_strike_text: 'What will Hunter Biden say during This is Gavin Newsom Podcast? -- Event does not qualify', evidence_status: 'proximity-only source cap -- no pick' },
    ],
  };
  const abbrevOnly = 'Terms: Trump; Event does not qualify\nMarket Context - NOT IN SCORE\nresearch-only';
  assert.throws(() => validateSynthesizedMentionPacket(abbrevOnly, input), /omitted full strike text/);
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
