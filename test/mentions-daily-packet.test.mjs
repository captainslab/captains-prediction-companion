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
import { buildResearchTermNote } from '../scripts/mentions/mentions-research-perplexity.mjs';

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

function trumpHousingEvent() {
  return {
    event_ticker: 'KXTRUMPMENTIONB-26JUN24',
    title: 'What will Trump say during the Road to Housing Act signing?',
    sub_title: 'Donald Trump - Road to Housing Act signing',
    close_time: '2026-07-09T14:00:00Z',
    series_ticker: 'KXTRUMPMENTIONB',
    markets: [
      {
        ticker: 'KXTRUMPMENTIONB-26JUN24-SING',
        title: 'What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act?',
        yes_sub_title: 'Single Family',
        yes_bid_dollars: '0.64',
        yes_ask_dollars: '0.69',
        last_price_dollars: '0.67',
        volume_fp: '172',
        open_interest_fp: '172',
        rules_primary: 'Resolves Yes if Trump says Single Family during the housing act signing.',
        mention_profile: 'political_mentions',
        research_term_note: buildResearchTermNote({
          phrase: 'Single Family',
          reason: 'Core of bill: ban institutional buyers of single-family homes.',
          kalshiNativePct: 71,
          kalshiNativeN: 14,
          proofPct: 75,
          handicapPct: 78,
          speaker: 'Trump',
        }),
        layer_records: {
          event_proximity: { present: true, score: 95, source_basis: 'official signing calendar' },
          historical_tendency: { present: true, score: 75, source_basis: 'source-backed housing history' },
          direct_mention_pathway: { present: true, score: 75, source_basis: 'direct policy language' },
        },
      },
      {
        ticker: 'KXTRUMPMENTIONB-26JUN24-PERM',
        title: 'What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act?',
        yes_sub_title: 'Permit / Zoning',
        yes_bid_dollars: '0.69',
        yes_ask_dollars: '0.76',
        last_price_dollars: '0.72',
        volume_fp: '41',
        open_interest_fp: '41',
        rules_primary: 'Resolves Yes if Trump says permit or zoning during the housing act signing.',
        mention_profile: 'political_mentions',
        research_term_note: buildResearchTermNote({
          phrase: 'Permit / Zoning',
          reason: 'Trump cites permits and zoning as barriers.',
          proofPct: 63,
          handicapPct: 64,
          speaker: 'Trump',
        }),
        layer_records: {
          event_proximity: { present: true, score: 72, source_basis: 'official signing calendar' },
          historical_tendency: { present: true, score: 64, source_basis: 'permit/zoning references in prior remarks' },
          direct_mention_pathway: { present: true, score: 53, source_basis: 'housing policy remarks' },
        },
      },
      {
        ticker: 'KXTRUMPMENTIONB-26JUN24-IRAN',
        title: 'What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act?',
        yes_sub_title: 'Iran (3+ times)',
        yes_bid_dollars: '0.53',
        yes_ask_dollars: '0.54',
        last_price_dollars: '0.53',
        volume_fp: '42.79',
        open_interest_fp: '42.79',
        rules_primary: 'Resolves Yes if Trump says Iran 3+ times during the housing act signing.',
        mention_profile: 'political_mentions',
        research_term_note: buildResearchTermNote({
          phrase: 'Iran (3+ times)',
          reason: 'Iran not a focus in current housing policy context.',
          proofPct: 53,
          handicapPct: 53,
          requiredCount: 3,
          speaker: 'Trump',
        }),
        layer_records: {
          event_proximity: { present: true, score: 70, source_basis: 'official signing calendar' },
          historical_tendency: { present: true, score: 53, source_basis: 'Iran references in prior remarks' },
          direct_mention_pathway: { present: true, score: 53, source_basis: 'foreign-policy references in housing remarks' },
        },
      },
      {
        ticker: 'KXTRUMPMENTIONB-26JUN24-NQE',
        title: 'What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act?',
        yes_sub_title: 'Event does not qualify',
        last_price_dollars: '0.10',
        yes_bid_dollars: '0.07',
        yes_ask_dollars: '0.08',
        volume_fp: '620',
        open_interest_fp: '420',
        rules_primary: 'Event does not qualify resolves Yes if the signing does not qualify.',
        mention_profile: 'political_mentions',
        is_qualification_term: true,
        qualification_status: 'high',
        layer_records: {
          event_proximity: { present: true, score: 10, source_basis: 'qualifying-path rules only' },
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
  assert.match(text, /PowerEdge — 88 — STRONG YES/);
  assert.match(text, /Why:/);
  assert.match(text, /Settlement:/);
  assert.match(text, /Evidence:[\s\S]*no direct current context\./);
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

test('mentions daily packet uses clean strike terms, not repeated market titles', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-11',
    event: trumpTeleRallyEvent(),
    sourceUrl: '/tmp/trump.json',
  }).text;

  const inventory = text.split('8. FULL STRIKE INVENTORY')[1];
  assert.match(inventory, /- Biden/);
  assert.doesNotMatch(inventory, /What will Donald Trump say during Burt Jones Tele-Rally\? -- Biden/);
  assert.doesNotMatch(inventory, /Biden — P\(YES\)/);
  assert.match(text, /8\. FULL STRIKE INVENTORY[\s\S]*- Biden/);
});

test('Trump housing packet cleans settlement wording and keeps comparable-history provenance separate from settled_history', () => {
  const text = buildKalshiEventPacket({
    date: '2026-06-24',
    event: trumpHousingEvent(),
    sourceUrl: '/tmp/housing.json',
  }).text;

  assert.doesNotMatch(text, /0\. QUALIFICATION CHECK/);
  assert.match(text, /1\. FAST READ/);
  assert.match(text, /#1 Single Family — 75 — STRONG YES/);
  assert.match(text, /#1 Single Family — 75 — STRONG YES\n\nWhy:/);
  assert.match(text, /Settlement:[\s\S]*YES if Trump says "Single Family"[\s\S]*qualifying event[\s\S]*window\./);
  assert.match(text, /Evidence:[\s\S]*current-event context \+ comparable history\./);
  assert.match(text, /#2 Permit \/ Zoning — \d+ — WEAK YES/);
  assert.match(text, /Settlement:[\s\S]*YES if Trump says either "Permit" or "Zoning"[\s\S]*qualifying event[\s\S]*window\./);
  assert.match(text, /Evidence:[\s\S]*current-event context\./);
  assert.match(text, /#3 Iran \(3\+ times\) — 53 — WEAK YES/);
  assert.match(text, /Settlement:[\s\S]*YES if Trump says "Iran"[\s\S]*3 or more qualifying times[\s\S]*during[\s\S]*the event window\./);
  assert.match(text, /Evidence:[\s\S]*current-event context\./);
  assert.match(text, /Provenance:[\s\S]*comparable_event_history: source=kalshi_native n=14 yes=10[\s\S]*hit_rate=0\.71/);
  assert.match(text, /Settlement:[\s\S]*EDNQ is a separate settlement path if the event\/rules do not qualify\.[\s\S]*This[\s\S]*is not a content-term pick\./);
  assert.match(text, /Read:[\s\S]*Neutral fallback, not a pick\./);
  assert.match(text, /settled_history: tier=none n=0 hits=0 misses=0 hit_rate=n\/a/);
  assert.doesNotMatch(text, /YES only if the exact token "What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act\? -- Single Family"[\s\S]*is said/);
  assert.doesNotMatch(text, /YES if either exact token "What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act\? -- Permit"[\s\S]*"Zoning" is said/);
  assert.doesNotMatch(text, /YES only if the exact token "What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act\? -- Iran"[\s\S]*is said/);
  assert.doesNotMatch(text, /^\s*\|.*\|\s*$/m);
  assert.match(text, /- Single Family/);
  assert.match(text, /- Permit \/ Zoning/);
  assert.match(text, /- Iran \(3\+ times\)/);
  assert.match(text, /- Event does not qualify/);
  assert.doesNotMatch(text, /What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act\? -- Single Family/);
  assert.doesNotMatch(text, /What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act\? -- Permit \/ Zoning/);
  assert.doesNotMatch(text, /What will Donald Trump say during THE PRESIDENT signs the 21st Century ROAD to Housing Act\? -- Iran \(3\+ times\)/);
  assert.doesNotMatch(text, /\/home\/jordan\//);
  assert.doesNotMatch(text, /\b2026-06-24T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/);
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
