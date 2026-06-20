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
  selectAnalystTier,
  validateAnalystJson,
  validateRedteamJson,
  resolveTier,
  loadModelRouting,
  fetchAnalystFields,
  fetchRedteamFields,
  emptyAnalyst,
} from '../scripts/mentions/model-router.mjs';
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

const ANALYST_JSON = {
  fast_read: 'Three researched terms, schedule confirmed.',
  final_read: 'Research only; verify settlement wording.',
  term_notes: [
    { term: 'Malarkey', catalyst: 'signature phrase', settlement_fit: 'exact string', trap_risk: 'rarely scripted' },
  ],
  source_gaps: ['no transcript yet'],
  upgrade_triggers: ['transcript confirms phrasing'],
  downgrade_triggers: ['event reschedules'],
};

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

test('composite board is present with every term exactly once, short terms not full titles', () => {
  const input = builtInput({ sourceBacked: true });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const board = text.split('3. TOP RESEARCHED TERMS')[0].split('2. RANKED BOARD')[1];
  for (const word of ['Malarkey', 'Folks', 'Democracy']) {
    const occurrences = board.split('\n').filter((l) => /^\d+\s/.test(l.trim()) && l.includes(word));
    assert.equal(occurrences.length, 1, `${word} appears once in board`);
  }
  // No repeated full event title in board rows
  const rows = board.split('\n').filter((l) => /^\d+\s/.test(l.trim()));
  for (const row of rows) assert.ok(!row.includes('Will Biden say it? --'), 'board rows use short terms');
  assert.ok(board.includes('Rank') && board.includes('P(YES)') && board.includes('Tier') && board.includes('Settlement Fit') && board.includes('Market Context'));
});

test('market prices are excluded from score inputs (composite core throws on pricing fields)', () => {
  assert.throws(() => composeMentionLedger({
    event: 'X', targetMention: 'Y', profile: 'political_mentions',
    layerDefs: [{ key: 'event_proximity', weight: 1, label: 'proximity' }],
    layerRecords: { event_proximity: { present: true, score: 50, yes_ask: 15 } },
  }), /forbidden pricing field/);
  // and changing market context does not change the rendered CPC score column
  const input = builtInput({ sourceBacked: true });
  const text1 = renderMentionPacket(input, { generatedAtUtc: NOW });
  const mutated = JSON.parse(JSON.stringify(input));
  for (const t of mutated.terms) t.market_context = { bid_cents: 90, ask_cents: 99, implied: 0.95, note: 'NOT IN SCORE' };
  const text2 = renderMentionPacket(mutated, { generatedAtUtc: NOW });
  const scores = (t) => t.split('\n').filter((l) => /^\d+\s/.test(l.trim())).map((l) => l.split('|')[2]);
  assert.deepEqual(scores(text1), scores(text2));
});

test('all 0/100 market context is summarized once, not spammed by row', () => {
  const input = builtInput({ sourceBacked: false });
  for (const t of input.terms) {
    t.market_context = { bid_cents: 0, ask_cents: 100, implied: 0.5, note: 'NOT IN SCORE' };
  }
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const section5 = text.split('6. SOURCE GAPS')[0].split('5. MARKET CONTEXT - NOT IN SCORE')[1];
  assert.match(section5, /all 3 displayed terms show bid=0c \/ ask=100c/);
  assert.equal((section5.match(/bid=0c/g) ?? []).length, 1, '0/100 context summarized once');
  assert.match(text.split('3. TOP RESEARCHED TERMS')[0], /one-sided sec5/);
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
  const board = packet.split('3. TOP RESEARCHED TERMS')[0].split('2. RANKED BOARD')[1];
  const rows = board.split('\n').filter((l) => /^\d+\s/.test(l.trim()));
  const order = rows.map((row) => row.split('|')[1].trim());
  assert.deepEqual(order, ['Biden', 'Bibi', 'Democrat', 'Terminate']);
  assert.match(rows[0], /\|\s*88\s*\|\s*STRONG YES\s*\|/);
  assert.match(rows[1], /\|\s*79\s*\|\s*STRONG YES\s*\|/);
  assert.match(rows[2], /\|\s*72\s*\|\s*STRONG YES\s*\|/);
  assert.match(rows[3], /\|\s*41\s*\|\s*WEAK NO\s*\|/);
  assert.doesNotMatch(packet, /\b(?:WATCH|LEAN|NO_CLEAR_PICK|EVIDENCE_LEAN|composite score|source layer(?:s)?|proximity-only|stub|scaffold)\b/i);
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
  assert.match(text, /\|\s*70\s*\|\s*STRONG YES\s*\|/);
  assert.match(text, /\|\s*55\s*\|\s*WEAK YES\s*\|/);
  assert.match(text, /\|\s*40\s*\|\s*WEAK NO\s*\|/);
  assert.match(text, /\|\s*20\s*\|\s*STRONG NO\s*\|/);
});

test('customer packet omits retired jargon and keeps event proximity out of the text', () => {
  const input = builtInput({ sourceBacked: true });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  for (const term of ['EVIDENCE_LEAN', 'LEAN', 'WATCH', 'NO_CLEAR_PICK', 'source layer', 'proximity-only', 'stub', 'scaffold', 'composite score']) {
    assert.doesNotMatch(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.doesNotMatch(text, /\bevent_proximity\b/i);
});

test('missing model fields fall back safely to MISSING/deterministic text', () => {
  const input = builtInput({ sourceBacked: true });
  const { value, ok } = validateAnalystJson({});
  assert.equal(ok, false);
  const text = renderMentionPacket(input, { analyst: value, generatedAtUtc: NOW });
  assert.ok(text.includes('MISSING'));
  assert.equal(validateRenderedPacket(text, input), true);
});

test('invalid model JSON fails closed into the deterministic fallback (packet still renders)', async () => {
  const input = builtInput({ sourceBacked: true });
  const badRunner = async () => ({ ok: true, parsed: 'not-an-object', status: 0 });
  const run = await fetchAnalystFields({ input, summary: input.summary, env: {}, chatRunner: badRunner });
  assert.equal(run.fallback, true);
  assert.deepEqual(run.analyst, { ...emptyAnalyst(), ...run.analyst });
  const composed = await composeMentionPacketDeterministic({ input, env: {}, chatRunner: badRunner, now: () => NOW });
  assert.equal(validateRenderedPacket(composed.text, input), true);
});

test('proximity-only packet renders with NO model call (no GPT-5.5, no analyst at all)', async () => {
  const input = builtInput({ sourceBacked: false });
  let calls = 0;
  const composed = await composeMentionPacketDeterministic({
    input, env: {}, chatRunner: async () => { calls += 1; return { ok: true, parsed: {} }; }, now: () => NOW,
  });
  assert.equal(calls, 0, 'no model invoked for proximity-only event');
  assert.equal(composed.invocation.analyst_tier, 'none');
  assert.ok(composed.text.includes('RESEARCH GAP'));
  assert.ok(!composed.text.includes('LOW-SOURCE WATCH only -- no pick'));
});

test('premium gate: gpt-5.5 only for flagged high-value source-backed events; never every event', () => {
  const sourceBackedSummary = { market_count: 3, source_backed_count: 3, proximity_only_count: 0, best_score: 75 };
  assert.equal(selectAnalystTier({ summary: sourceBackedSummary, env: {} }).tier, 'standard');
  assert.equal(selectAnalystTier({ summary: sourceBackedSummary, flags: ['high_value'], env: {} }).tier, 'premium');
  assert.equal(selectAnalystTier({ summary: { ...sourceBackedSummary, best_score: 10 }, flags: ['high_value'], env: {} }).tier, 'standard', 'score below gate threshold stays standard');
  assert.equal(selectAnalystTier({ summary: { market_count: 2, source_backed_count: 0, proximity_only_count: 2 }, flags: ['high_value'], env: {} }).tier, 'none');
});

test('provider routing: Gemini cheap, mini fallback, GPT analyst tiers on Codex, redteam Grok on XAI OAuth', () => {
  const routing = loadModelRouting();
  assert.deepEqual(
    ['cheap', 'cheap_fallback', 'standard', 'premium'].map((t) => resolveTier(t, routing)).map(({ model, provider }) => ({ model, provider })),
    [
      { model: 'gemini-3.5-flash', provider: 'gemini' },
      { model: 'gpt-5.4-mini', provider: 'openai-codex' },
      { model: 'gpt-5.4', provider: 'openai-codex' },
      { model: 'gpt-5.5', provider: 'openai-codex' },
    ],
  );
  const rt = resolveTier('redteam', routing);
  assert.equal(rt.model, 'grok-4.3');
  assert.equal(rt.provider, 'xai-oauth');
  assert.equal(rt.optional, true);
});

test('grok red-team is optional and cannot alter the final score', async () => {
  const input = builtInput({ sourceBacked: true });
  // disabled by default
  const off = await fetchRedteamFields({ input, env: {} });
  assert.equal(off.redteam, null);
  // enabled: returns flags but score/posture fields are stripped/ignored
  const hostile = {
    trap_flags: [{ term: 'Malarkey', note: 'meme bait' }],
    narrative_risks: ['X hype'],
    x_narrative_heat: [{ term: 'Malarkey', note: 'trending on X' }],
    cpc_score: 99, posture: 'PICK',
    layer_records: { direct_mention_pathway: { present: true, score: 99 } },
  };
  const on = await fetchRedteamFields({ input, env: { MENTIONS_REDTEAM: '1' }, chatRunner: async () => ({ ok: true, parsed: hostile, status: 0 }) });
  assert.equal(on.redteam.trap_flags.Malarkey, 'meme bait');
  assert.equal('cpc_score' in on.redteam, false);
  assert.equal('layer_records' in on.redteam, false, 'X chatter can never become a source evidence layer');
  assert.ok(on.redteam.x_narrative_heat.Malarkey.includes('NOT source evidence'), 'X heat labeled as narrative context only');
  const base = renderMentionPacket(input, { generatedAtUtc: NOW });
  const withRt = renderMentionPacket(input, { redteam: on.redteam, generatedAtUtc: NOW });
  const scores = (t) => t.split('\n').filter((l) => /^\d+\s/.test(l.trim())).map((l) => l.split('|').slice(2, 4).join('|'));
  assert.deepEqual(scores(base), scores(withRt), 'red-team never changes CPC score or posture columns');
});

test('analyst JSON cannot smuggle scores/prices (forbidden fields flagged and ignored)', () => {
  const { ok, errors, value } = validateAnalystJson({ ...ANALYST_JSON, cpc_score: 99, yes_ask: 12 });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('cpc_score')));
  assert.equal('cpc_score' in value, false);
});

test('valid analyst JSON lands in board catalyst/settlement-fit columns', () => {
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
  const analyst = validateAnalystJson({
    ...ANALYST_JSON,
    term_notes: [
      ...ANALYST_JSON.term_notes,
      { term: 'Aardvark', catalyst: 'fabricated stub', settlement_fit: 'fabricated stub', trap_risk: 'stub' },
    ],
  }).value;
  const text = renderMentionPacket(input, { analyst, generatedAtUtc: NOW, analystTier: 'standard' });
  const row = text.split('\n').find((l) => /^\d+\s/.test(l.trim()) && l.includes('Malarkey'));
  assert.ok(row.includes('habit/news-cycle press'), 'board catalyst should come from research note');
  assert.ok(row.includes('YES only if the exact'), 'board settlement fit should come from research note');
  const gapRow = text.split('\n').find((l) => /^\d+\s/.test(l.trim()) && l.includes('Aardvark'));
  assert.ok(gapRow.includes('MISSING'), 'gap row keeps catalyst/settlement fit un-fabricated');
  assert.ok(text.includes('1. FAST READ\nThree researched terms, schedule confirmed.'));
});

test('user-facing event time renders in America/Chicago', () => {
  assert.equal(formatCentral('2026-06-12T18:00:00Z'), 'Jun 12, 2026, 1:00 PM CDT');
  assert.equal(shortTerm('Will Biden say it? -- Malarkey', 'Will Biden say it?'), 'Malarkey');
});

test('proximity-only rows show capped numeric CPC scores, never scaffold text', () => {
  const input = builtInput({ sourceBacked: false }); // event_proximity score only
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const rows = text.split('3. TOP RESEARCHED TERMS')[0].split('\n').filter((l) => /^\d+\s/.test(l.trim()));
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.equal(row.split('|')[2].trim(), '--', `proximity-only row must show no P(YES): ${row}`);
    assert.ok(row.includes('RESEARCH GAP'), 'proximity-only row must be labeled research gap');
    assert.ok(!row.includes('scaffold'), `proximity-only row leaked scaffold text: ${row}`);
  }
  assert.ok(text.includes('best tier RESEARCH GAP'));
});

test('FAST READ and FINAL READ use post-cap tier from rendered rows, not summary', () => {
  const input = builtInput({ sourceBacked: false });
  input.summary = { ...input.summary, best_posture: 'STRONG YES', source_backed_count: 0 };
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const fastRead = text.split('2. RANKED BOARD')[0];
  assert.ok(fastRead.includes('best tier RESEARCH GAP'));
  assert.ok(!fastRead.includes('STRONG YES'), 'pre-cap summary never overrides the rendered tier');
  const finalRead = text.split('8. FINAL READ')[1];
  assert.ok(finalRead.includes('Best tier RESEARCH GAP on the board above.'));
});

test('research-backed terms always rank above research-gap rows regardless of raw score', () => {
  const input = builtInput({ sourceBacked: true });
  // add a research-gap term with an inflated raw score
  input.terms.push({
    full_strike_text: 'Will Biden say it? -- Aardvark',
    short_term: 'Aardvark', cpc_score: 99, bucket: 'watch-only',
    evidence_status: 'research gap',
    research_state: 'research gap',
    layers_present: ['1/9'], composite_posture: 'RESEARCH GAP',
    missing_research_layers: [], upgrade_trigger: null,
    market_context: { implied: null, bid_cents: null, ask_cents: null, note: 'NOT IN SCORE' },
  });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const rows = text.split('3. TOP RESEARCHED TERMS')[0].split('\n').filter((l) => /^\d+\s/.test(l.trim()));
  const aardvarkRank = rows.findIndex((r) => r.includes('Aardvark'));
  assert.equal(aardvarkRank, rows.length - 1, 'research-gap row ranks last despite raw score 99');
  assert.match(rows[aardvarkRank], /\|\s*--\s*\|\s*RESEARCH GAP\s*\|/);
  assert.ok(!rows[aardvarkRank].includes('scaffold'));
});

test('redteam validator fails closed on garbage', () => {
  const r = validateRedteamJson([1, 2, 3]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.value.narrative_risks, []);
});
