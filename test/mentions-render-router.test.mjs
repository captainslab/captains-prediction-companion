import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMentionPacket,
  validateRenderedPacket,
  shortTerm,
  formatCentral,
  SECTION_ORDER,
} from '../scripts/mentions/render-mention-packet.mjs';
import { buildResearchTermNote } from '../scripts/mentions/mentions-research-perplexity.mjs';
import {
  buildKalshiEventPacket,
  composeMentionPacketDeterministic,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { composeMentionLedger } from '../scripts/mentions/mention-composite-core.mjs';

const DATE = '2026-06-12';
const NOW = '2026-06-12T18:00:00.000Z';

function fixtureEvent({ ticker = 'KXHBIDENMENTION-26JUN12', sourceBacked = false } = {}) {
  const layers = sourceBacked
    ? {
        event_proximity: { present: true, score: 80, source_basis: 'official schedule' },
        historical_tendency: { present: true, score: 75, source_basis: 'past transcripts' },
        direct_mention_pathway: { present: true, score: 70, source_basis: 'agenda topic match' },
      }
    : {
        event_proximity: { present: true, score: 20, source_basis: 'official schedule' },
      };
  const market = (word) => ({
    ticker: `${ticker}-${word.toUpperCase()}`,
    title: 'Will Biden say it?',
    yes_sub_title: word,
    custom_strike: { Word: word },
    yes_bid_dollars: '0.10',
    yes_ask_dollars: '0.15',
    rules_primary: `If Biden says ${word}, resolves Yes.`,
    mention_profile: 'political_mentions',
    layer_records: layers,
  });
  return {
    event_ticker: ticker,
    title: 'Will Biden say it?',
    sub_title: 'Biden remarks mentions',
    series_ticker: 'KXHBIDENMENTION',
    markets: [market('Malarkey'), market('Folks'), market('Democracy')],
  };
}

function builtInput(opts) {
  const event = fixtureEvent(opts);
  const built = buildKalshiEventPacket({ date: DATE, event, sourceUrl: '/tmp/src.json' });
  return built.synthesisInput;
}

function axiosTrumpFixture() {
  const terms = [
    { term: 'Biden', blendedPct: 88, proximity: 18 },
    { term: 'Bibi', blendedPct: 79, proximity: 14 },
    { term: 'Democrat', blendedPct: 72, proximity: 11 },
    { term: 'Terminate', blendedPct: 41, proximity: 98 },
  ];
  return {
    event_ticker: 'KXTRUMPAXIOS-26JUN11',
    title: 'What will Trump say during his Axios interview?',
    sub_title: 'Donald Trump - Axios interview',
    series_ticker: 'KXTRUMPMENTION',
    markets: terms.map(({ term, blendedPct, proximity }) => ({
      ticker: `KXTRUMPAXIOS-26JUN11-${term.toUpperCase()}`,
      title: 'What will Donald Trump say during Axios interview?',
      yes_sub_title: term,
      no_sub_title: term,
      custom_strike: { Word: term },
      yes_bid_dollars: '0.10',
      yes_ask_dollars: '0.15',
      last_price_dollars: '0.12',
      rules_primary: `If Donald Trump says ${term}, the market resolves to Yes.`,
      mention_profile: 'political_mentions',
      blended_pct: blendedPct,
      layer_records: {
        event_proximity: { present: true, score: proximity, source_basis: 'Axios interview scheduled' },
        historical_tendency: { present: true, score: blendedPct, source_basis: 'historical transcript calibration' },
        direct_mention_pathway: { present: true, score: blendedPct, source_basis: 'direct mention pathway calibration' },
      },
    })),
  };
}

function sectionBlock(text, start, end) {
  const afterStart = text.split(start)[1] ?? '';
  return end ? afterStart.split(end)[0] : afterStart;
}

function cardHeaders(block) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#\d+\s/.test(line) && /—\s*P\(YES\)\s*(?:\d+|--)\s*—\s*(?:STRONG YES|WEAK YES|WEAK NO|STRONG NO|RESEARCH GAP)/.test(line));
}

test('same input renders the same packet text (deterministic)', () => {
  const input = builtInput({ sourceBacked: true });
  const a = renderMentionPacket(input, { generatedAtUtc: NOW, analystTier: 'standard' });
  const b = renderMentionPacket(input, { generatedAtUtc: NOW, analystTier: 'standard' });
  assert.equal(a, b);
});

test('section order is stable and validated', () => {
  const input = builtInput({ sourceBacked: true });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  assert.equal(validateRenderedPacket(text, input), true);
  let last = -1;
  for (const s of SECTION_ORDER) {
    const idx = text.indexOf(s);
    assert.ok(idx > last, `section ${s} in order`);
    last = idx;
  }
});

test('stacked cards render each researched term once with mobile-friendly sectioning', () => {
  const input = builtInput({ sourceBacked: true });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const topYes = sectionBlock(text, '2. TOP YES CASE', '3. WEAK YES WATCHLIST');
  const headers = cardHeaders(topYes);
  assert.equal(headers.length, 3);
  for (const word of ['Malarkey', 'Folks', 'Democracy']) {
    const occurrences = headers.filter((line) => line.includes(word));
    assert.equal(occurrences.length, 1, `${word} appears once in the top-yes cards`);
  }
  for (const header of headers) assert.ok(!header.includes('Will Biden say it? --'), 'card headers use short terms');
  assert.ok(topYes.includes('Why it could hit:'));
  assert.ok(topYes.includes('Settlement fit:'));
  assert.ok(topYes.includes('Research: source-backed / fresh'));
  assert.doesNotMatch(topYes, /\|/);
});

test('market prices are excluded from score inputs (composite core throws on pricing fields)', () => {
  assert.throws(() => composeMentionLedger({
    event: 'X',
    targetMention: 'Y',
    profile: 'political_mentions',
    layerDefs: [{ key: 'event_proximity', weight: 1, label: 'proximity' }],
    layerRecords: { event_proximity: { present: true, score: 50, yes_ask: 15 } },
  }), /forbidden pricing field/);

  const input = builtInput({ sourceBacked: true });
  const text1 = renderMentionPacket(input, { generatedAtUtc: NOW });
  const mutated = JSON.parse(JSON.stringify(input));
  for (const t of mutated.terms) t.market_context = { bid_cents: 90, ask_cents: 99, implied: 0.95, note: 'NOT IN SCORE' };
  const text2 = renderMentionPacket(mutated, { generatedAtUtc: NOW });
  const headers = (t) => t.split('\n').filter((l) => /^#\d+\s/.test(l.trim()) && /—\s*P\(YES\)\s*/.test(l));
  assert.deepEqual(headers(text1), headers(text2));
});

test('market context stays display-only and price values do not leak into the packet', () => {
  const input = builtInput({ sourceBacked: false });
  for (const t of input.terms) {
    t.market_context = { bid_cents: 0, ask_cents: 100, implied: 0.5, note: 'NOT IN SCORE' };
  }
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  assert.match(text, /Market Context - NOT IN SCORE: display-only context; never a score input\./);
  assert.doesNotMatch(text, /\b0c \/ 100c\b/);
  assert.doesNotMatch(text, /\bbid=0c\b/);
});

test('research-backed Trump/Axios fixture ranks by research P(YES), not event proximity', () => {
  const packet = renderMentionPacket({
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-06-11',
    event: {
      title: 'What will Trump say during his Axios interview?',
      subtitle: 'Donald Trump - Axios interview',
      date_time: '2026-06-11T18:00:00Z',
      settlement_source_link: 'https://kalshi.com/events/KXTRUMPAXIOS-26JUN11',
      rules_primary: 'If Donald Trump says the strike term, the market resolves Yes.',
    },
    summary: { market_count: 4 },
    terms: axiosTrumpFixture().markets.map((market) => ({
      full_strike_text: `${market.title} -- ${market.yes_sub_title}`,
      short_term: market.yes_sub_title,
      cpc_score: market.blended_pct,
      research_state: 'research-backed',
      market_context: { bid_cents: 10, ask_cents: 15, note: 'NOT IN SCORE' },
    })),
  }, { generatedAtUtc: NOW });
  const topYes = sectionBlock(packet, '2. TOP YES CASE', '3. WEAK YES WATCHLIST');
  const traps = sectionBlock(packet, '4. WEAK NO / STRONG NO TRAPS', '5. SOURCE GAPS');
  const headers = cardHeaders(topYes);
  const trapHeaders = cardHeaders(traps);
  const order = [...headers, ...trapHeaders].map((row) => row.match(/^#\d+\s+(.+?)\s+—\s+P\(YES\)/)?.[1]);
  assert.deepEqual(order, ['Biden', 'Bibi', 'Democrat', 'Terminate']);
  assert.deepEqual(headers.map((row) => row.match(/^#\d+\s+(.+?)\s+—\s+P\(YES\)/)?.[1]), ['Biden', 'Bibi', 'Democrat']);
  assert.deepEqual(trapHeaders.map((row) => row.match(/^#\d+\s+(.+?)\s+—\s+P\(YES\)/)?.[1]), ['Terminate']);
  assert.match(headers[0], /—\s*P\(YES\)\s*88\s*—\s*STRONG YES/);
  assert.match(headers[1], /—\s*P\(YES\)\s*79\s*—\s*STRONG YES/);
  assert.match(headers[2], /—\s*P\(YES\)\s*72\s*—\s*STRONG YES/);
  assert.match(trapHeaders[0], /—\s*P\(YES\)\s*41\s*—\s*WEAK NO/);
  assert.doesNotMatch(packet, /\b(?:LEAN|NO_CLEAR_PICK|EVIDENCE_LEAN|composite score|source layer(?:s)?|proximity-only|stub|scaffold)\b/i);
});

test('P(YES) tier buckets render as STRONG YES, WEAK YES, WEAK NO, STRONG NO', () => {
  const input = {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-06-11',
    event: {
      title: 'Tier mapping test',
      subtitle: 'tier mapping',
      date_time: '2026-06-11T18:00:00Z',
      settlement_source_link: 'https://kalshi.com/events/KXTIER',
      rules_primary: 'If the word appears, resolves Yes.',
    },
    summary: { market_count: 4 },
    terms: [
      { full_strike_text: 'Tier Alpha', short_term: 'Alpha', cpc_score: 70, research_state: 'research-backed', market_context: { note: 'NOT IN SCORE' } },
      { full_strike_text: 'Tier Beta', short_term: 'Beta', cpc_score: 55, research_state: 'research-backed', market_context: { note: 'NOT IN SCORE' } },
      { full_strike_text: 'Tier Gamma', short_term: 'Gamma', cpc_score: 40, research_state: 'research-backed', market_context: { note: 'NOT IN SCORE' } },
      { full_strike_text: 'Tier Delta', short_term: 'Delta', cpc_score: 20, research_state: 'research-backed', market_context: { note: 'NOT IN SCORE' } },
    ],
  };
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  assert.match(text, /Tier Alpha — P\(YES\) 70 — STRONG YES/);
  assert.match(text, /Tier Beta — P\(YES\) 55 — WEAK YES/);
  assert.match(text, /Tier Gamma — P\(YES\) 40 — WEAK NO/);
  assert.match(text, /Tier Delta — P\(YES\) 20 — STRONG NO/);
});

test('count thresholds and EDNQ render in separate sections', () => {
  const input = {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-06-11',
    event: {
      title: 'What will Trump say during his press portion?',
      subtitle: 'Donald Trump - press portion',
      date_time: '2026-06-11T18:00:00Z',
      settlement_source_link: 'https://kalshi.com/events/KXTHRESH',
      rules_primary: 'If Trump says tariff 3+ times during the press portion, the market resolves Yes.',
    },
    summary: { market_count: 3 },
    terms: [
      {
        full_strike_text: 'Will Trump say tariff 3+ times? -- tariff',
        short_term: 'tariff',
        cpc_score: 42,
        research_state: 'research-backed',
        market_type: 'threshold_count',
        required_count: 3,
        repeat_requirement: '3+ times',
        research_term_note: buildResearchTermNote({
          phrase: 'tariff',
          reason: 'repeat pressure and repeated references',
          kalshiNativePct: 67,
          kalshiNativeN: 3,
          proofPct: 42,
          handicapPct: 55,
          requiredCount: 3,
          speaker: 'Trump',
        }),
        market_context: { note: 'NOT IN SCORE' },
      },
      {
        full_strike_text: 'What will Hunter Biden say? -- Event does not qualify',
        short_term: 'Event does not qualify',
        cpc_score: null,
        research_state: 'qualification fallback',
        market_type: 'ednq',
        is_qualification_term: true,
        qualification_status: 'high',
        market_context: { note: 'NOT IN SCORE' },
      },
      {
        full_strike_text: 'Will Trump say rally?',
        short_term: 'rally',
        cpc_score: 70,
        research_state: 'research-backed',
        market_context: { note: 'NOT IN SCORE' },
      },
    ],
  };
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  assert.match(text, /Content terms are words likely to be said; count terms are the exact token plus the required repeat count; EDNQ is a separate settlement path if the event or rules do not qualify\./);
  const topYes = sectionBlock(text, '2. TOP YES CASE', '3. WEAK YES WATCHLIST');
  assert.match(topYes, /rally/);
  assert.doesNotMatch(topYes, /Event does not qualify/);

  const traps = sectionBlock(text, '4. WEAK NO \/ STRONG NO TRAPS', '5. SOURCE GAPS');
  assert.match(traps, /tariff/);
  assert.match(traps, /YES if Trump says "tariff"[\s\S]*3 or more qualifying times[\s\S]*during the event window\./);

  const qualification = sectionBlock(text, '6. QUALIFICATION RISK', '7. SETTLEMENT NOTES');
  assert.match(qualification, /Event does not qualify/);
  assert.match(qualification, /EDNQ is a separate settlement path if the event\/rules do not qualify\. This is not a content-term pick\./);
  assert.match(qualification, /YES-leaning qualification risk proven \(high\)/);
  assert.doesNotMatch(qualification, /P\(YES\)/);
});

test('threshold-supported repeated mention evidence can still render a YES tier', () => {
  const input = {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-06-11',
    event: {
      title: 'What will Trump say during his press portion?',
      subtitle: 'Donald Trump - press portion',
      date_time: '2026-06-11T18:00:00Z',
      settlement_source_link: 'https://kalshi.com/events/KXTHRESHYES',
      rules_primary: 'If Trump says tariff 3+ times during the press portion, the market resolves Yes.',
    },
    summary: { market_count: 1 },
    terms: [
      {
        full_strike_text: 'Will Trump say tariff 3+ times? -- tariff',
        short_term: 'tariff',
        cpc_score: 66,
        research_state: 'research-backed',
        market_type: 'threshold_count',
        required_count: 3,
        repeat_requirement: '3+ times',
        research_term_note: buildResearchTermNote({
          phrase: 'tariff',
          reason: 'repeated references in the appearance',
          kalshiNativePct: 67,
          kalshiNativeN: 3,
          proofPct: 66,
          handicapPct: 72,
          requiredCount: 3,
          speaker: 'Trump',
        }),
        market_context: { note: 'NOT IN SCORE' },
      },
    ],
  };
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const topYes = sectionBlock(text, '2. TOP YES CASE', '3. WEAK YES WATCHLIST');
  assert.match(topYes, /tariff — P\(YES\) 66 — STRONG YES/);
  assert.match(topYes, /YES if Trump says "tariff"[\s\S]*3 or more qualifying times[\s\S]*during the event window\./);
});

test('customer packet omits retired jargon and keeps event proximity out of the text', () => {
  const input = builtInput({ sourceBacked: true });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const body = text.split('\n').filter((line) => line.trim() !== '3. WEAK YES WATCHLIST').join('\n');
  for (const term of ['EVIDENCE_LEAN', 'LEAN', 'WATCH', 'NO_CLEAR_PICK', 'source layer', 'event_proximity', 'proximity-only', 'stub', 'scaffold', 'composite score']) {
    assert.doesNotMatch(body, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.doesNotMatch(body, /\bevent_proximity\b/i);
});

test('fast read uses the rendered tier, not the summary, and research gaps sort last', () => {
  const input = builtInput({ sourceBacked: false });
  input.summary = { ...input.summary, best_posture: 'STRONG YES', source_backed_count: 0 };
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const fastRead = text.split('2. TOP YES CASE')[0];
  assert.ok(fastRead.includes('best tier RESEARCH GAP'));
  assert.ok(!fastRead.includes('STRONG YES'), 'pre-cap summary never overrides the rendered tier');

  const gapInput = builtInput({ sourceBacked: true });
  gapInput.terms.push({
    full_strike_text: 'Will Biden say it? -- Aardvark',
    short_term: 'Aardvark',
    cpc_score: 99,
    bucket: 'watch-only',
    evidence_status: 'research gap',
    research_state: 'research gap',
    layers_present: ['1/9'],
    composite_posture: 'RESEARCH GAP',
    missing_research_layers: [],
    upgrade_trigger: null,
    market_context: { implied: null, bid_cents: null, ask_cents: null, note: 'NOT IN SCORE' },
  });
  const gapText = renderMentionPacket(gapInput, { generatedAtUtc: NOW });
  const gapSection = sectionBlock(gapText, '5. SOURCE GAPS', '6. QUALIFICATION RISK');
  assert.match(gapSection, /Aardvark/);
  assert.doesNotMatch(gapText, /Aardvark — P\(YES\)/);
});

test('valid analyst JSON lands in card catalyst/settlement-fit text', () => {
  const input = builtInput({ sourceBacked: true });
  input.terms[0].research_term_note = buildResearchTermNote({
    phrase: 'Malarkey',
    reason: 'habit/news-cycle pressure',
    kalshiNativePct: 60,
    kalshiNativeN: 5,
    proofPct: 12,
    handicapPct: 74,
    citations: ['https://example.com/proof', 'https://example.com/hcap'],
  });
  input.terms.push({
    full_strike_text: 'Will Biden say it? -- Aardvark',
    short_term: 'Aardvark',
    cpc_score: null,
    research_state: 'research gap',
    bucket: 'blocked/no-source',
    market_context: { note: 'NOT IN SCORE' },
  });
  const text = renderMentionPacket(input, {
    analyst: {
      fast_read: 'Three researched terms, schedule confirmed.',
      final_read: 'Research only; verify settlement wording.',
      term_notes: [
        { term: 'Malarkey', catalyst: 'signature phrase', settlement_fit: 'exact string', trap_risk: 'rarely scripted' },
        { term: 'Aardvark', catalyst: 'fabricated stub', settlement_fit: 'fabricated stub', trap_risk: 'stub' },
      ],
      source_gaps: ['no transcript yet'],
      upgrade_triggers: ['transcript confirms phrasing'],
      downgrade_triggers: ['event reschedules'],
    },
    generatedAtUtc: NOW,
    analystTier: 'standard',
  });
  const topYes = sectionBlock(text, '2. TOP YES CASE', '3. WEAK YES WATCHLIST');
  assert.match(topYes, /Malarkey — P\(YES\) \d+ — STRONG YES/);
  assert.match(topYes, /habit\/news-cycle pressure/);
  assert.match(topYes, /YES only if the exact token "Malarkey" is said/);
  assert.match(topYes, /Provenance: comparable_event_history: source=kalshi_native n=5 yes=3[\s\S]*hit_rate=0\.60/);
  assert.ok(!topYes.includes('…'), 'full catalyst and settlement fit text should not truncate');

  const gaps = sectionBlock(text, '5. SOURCE GAPS', '6. QUALIFICATION RISK');
  assert.match(gaps, /Aardvark/);
  assert.doesNotMatch(gaps, /Aardvark — P\(YES\)/);
});

test('source gaps stay compact and settlement notes preserve provenance', () => {
  const input = builtInput({ sourceBacked: false });
  input.deterministic_provenance_lines = ['settled_history: tier=exact_horizon n=2 hits=2 misses=0 hit_rate=1.00'];
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const gaps = sectionBlock(text, '5. SOURCE GAPS', '6. QUALIFICATION RISK');
  assert.match(gaps, /research gap/i);
  assert.doesNotMatch(gaps, /Malarkey.*Malarkey/);

  const notes = sectionBlock(text, '7. SETTLEMENT NOTES', '8. FULL STRIKE INVENTORY');
  assert.match(notes, /settled_history: tier=exact_horizon n=2 hits=2 misses=0 hit_rate=1\.00/);
  assert.ok(!notes.includes('yes_bid'));
});

test('full strike inventory preserves every exact strike text', () => {
  const input = builtInput({ sourceBacked: true });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const inventory = text.split('8. FULL STRIKE INVENTORY')[1];
  for (const term of ['Malarkey', 'Folks', 'Democracy']) {
    assert.match(inventory, new RegExp(`Will Biden say it\\? -- ${term}`));
  }
});

test('proximity-only packet renders with NO model call and still fails closed on no research', async () => {
  const input = builtInput({ sourceBacked: false });
  let calls = 0;
  const composed = await composeMentionPacketDeterministic({
    input,
    env: {},
    chatRunner: async () => { calls += 1; return { ok: true, parsed: {} }; },
    now: () => NOW,
  });
  assert.equal(calls, 0, 'no model invoked for proximity-only event');
  assert.equal(composed.invocation.analyst_tier, 'none');
  assert.ok(composed.text.includes('RESEARCH GAP'));
  assert.ok(!composed.text.includes('LOW-SOURCE WATCH only -- no pick'));
});

test('market prices never change the rendered score/order and full strike text remains present', () => {
  const input = builtInput({ sourceBacked: true });
  const base = renderMentionPacket(input, { generatedAtUtc: NOW });
  const mutated = JSON.parse(JSON.stringify(input));
  mutated.terms.forEach((term) => {
    term.market_context = { bid_cents: 90, ask_cents: 99, implied: 0.95, note: 'NOT IN SCORE' };
  });
  const changed = renderMentionPacket(mutated, { generatedAtUtc: NOW });
  const baseHeaders = base.split('\n').filter((l) => /^#\d+\s/.test(l.trim()) && /—\s*P\(YES\)\s*/.test(l));
  const changedHeaders = changed.split('\n').filter((l) => /^#\d+\s/.test(l.trim()) && /—\s*P\(YES\)\s*/.test(l));
  assert.deepEqual(baseHeaders, changedHeaders);
  for (const term of ['Will Biden say it? -- Malarkey', 'Will Biden say it? -- Folks', 'Will Biden say it? -- Democracy']) {
    assert.ok(changed.includes(term));
  }
});

test('user-facing event time renders in America/Chicago', () => {
  assert.equal(formatCentral('2026-06-12T18:00:00Z'), 'Jun 12, 2026, 1:00 PM CDT');
  assert.equal(shortTerm('Will Biden say it? -- Malarkey', 'Will Biden say it?'), 'Malarkey');
});
