import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMentionPacket,
  validateRenderedPacket,
  shortTerm,
  formatCentral,
  SECTION_ORDER,
} from '../scripts/mentions/render-mention-packet.mjs';
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

const ANALYST_JSON = {
  fast_read: 'Three watch terms, schedule confirmed.',
  final_read: 'Watch only; verify settlement wording.',
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
  const board = text.split('3. TOP WATCH TERMS')[0].split('2. CPC COMPOSITE BOARD')[1];
  for (const word of ['Malarkey', 'Folks', 'Democracy']) {
    const occurrences = board.split('\n').filter((l) => /^\d+\s/.test(l.trim()) && l.includes(word));
    assert.equal(occurrences.length, 1, `${word} appears once in board`);
  }
  // No repeated full event title in board rows
  const rows = board.split('\n').filter((l) => /^\d+\s/.test(l.trim()));
  for (const row of rows) assert.ok(!row.includes('Will Biden say it? --'), 'board rows use short terms');
  assert.ok(board.includes('Rank') && board.includes('CPC') && board.includes('Posture') && board.includes('Settlement Fit') && board.includes('Market Context'));
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
  assert.ok(composed.text.includes('proximity scaffold only -- no pick'));
});

test('premium gate: gpt-5.5 only for flagged high-value source-backed events; never every event', () => {
  const sourceBackedSummary = { market_count: 3, source_backed_count: 3, proximity_only_count: 0, best_score: 75 };
  assert.equal(selectAnalystTier({ summary: sourceBackedSummary, env: {} }).tier, 'standard');
  assert.equal(selectAnalystTier({ summary: sourceBackedSummary, flags: ['high_value'], env: {} }).tier, 'premium');
  assert.equal(selectAnalystTier({ summary: { ...sourceBackedSummary, best_score: 10 }, flags: ['high_value'], env: {} }).tier, 'standard', 'score below gate threshold stays standard');
  assert.equal(selectAnalystTier({ summary: { market_count: 2, source_backed_count: 0, proximity_only_count: 2 }, flags: ['high_value'], env: {} }).tier, 'none');
});

test('provider routing: GPT tiers on OpenAI Codex, redteam Grok on XAI Grok OAuth', () => {
  const routing = loadModelRouting();
  assert.deepEqual(
    ['cheap', 'standard', 'premium'].map((t) => resolveTier(t, routing)).map(({ model, provider }) => ({ model, provider })),
    [
      { model: 'gpt-5.4-mini', provider: 'openai-codex' },
      { model: 'gpt-5.4', provider: 'openai-codex' },
      { model: 'gpt-5.5', provider: 'openai-codex' },
    ],
  );
  const rt = resolveTier('redteam', routing);
  assert.equal(rt.model, 'grok-4.3');
  assert.equal(rt.provider, 'xai-grok-oauth');
  assert.equal(rt.optional, true);
});

test('grok red-team is optional and cannot alter the final score', async () => {
  const input = builtInput({ sourceBacked: true });
  // disabled by default
  const off = await fetchRedteamFields({ input, env: {} });
  assert.equal(off.redteam, null);
  // enabled: returns flags but score/posture fields are stripped/ignored
  const hostile = { trap_flags: [{ term: 'Malarkey', note: 'meme bait' }], narrative_risks: ['X hype'], cpc_score: 99, posture: 'PICK' };
  const on = await fetchRedteamFields({ input, env: { MENTIONS_REDTEAM: '1' }, chatRunner: async () => ({ ok: true, parsed: hostile, status: 0 }) });
  assert.equal(on.redteam.trap_flags.Malarkey, 'meme bait');
  assert.equal('cpc_score' in on.redteam, false);
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
  const { value } = validateAnalystJson(ANALYST_JSON);
  const text = renderMentionPacket(input, { analyst: value, generatedAtUtc: NOW, analystTier: 'standard' });
  const row = text.split('\n').find((l) => /^\d+\s/.test(l.trim()) && l.includes('Malarkey'));
  assert.ok(row.includes('signature phrase') && row.includes('exact string'));
  assert.ok(text.includes('1. FAST READ\nThree watch terms, schedule confirmed.'));
});

test('user-facing event time renders in America/Chicago', () => {
  assert.equal(formatCentral('2026-06-12T18:00:00Z'), 'Jun 12, 2026, 1:00 PM CDT');
  assert.equal(shortTerm('Will Biden say it? -- Malarkey', 'Will Biden say it?'), 'Malarkey');
});

test('proximity-only rows show "scaffold", never the raw proximity score as CPC conviction', () => {
  const input = builtInput({ sourceBacked: false }); // event_proximity score only
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const rows = text.split('3. TOP WATCH TERMS')[0].split('\n').filter((l) => /^\d+\s/.test(l.trim()));
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.ok(row.includes('scaffold'), `proximity-only row relabeled: ${row}`);
    assert.ok(!/\|\s*20\s*\|/.test(row), 'raw proximity layer score withheld from CPC column');
    assert.ok(row.includes('WATCH'), 'posture capped at WATCH');
  }
  assert.ok(text.includes('"scaffold" = schedule-only evidence'));
});

test('FAST READ and FINAL CPC READ use post-cap posture from rendered rows, not pre-cap summary', () => {
  const input = builtInput({ sourceBacked: false });
  // simulate the pre-cap composite summary claiming LEAN (1 layer at high score)
  input.summary = { ...input.summary, best_posture: 'LEAN', source_backed_count: 0 };
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const fastRead = text.split('2. CPC COMPOSITE BOARD')[0];
  assert.ok(!fastRead.includes('LEAN'), 'pre-cap LEAN never surfaces in FAST READ');
  assert.ok(fastRead.includes('best posture WATCH (post-cap)'));
  const finalRead = text.split('8. FINAL CPC READ')[1];
  assert.ok(!finalRead.includes('best posture LEAN'), 'pre-cap LEAN never surfaces in FINAL READ');
});

test('source-backed terms always rank above proximity-only scaffolds regardless of raw score', () => {
  const input = builtInput({ sourceBacked: true });
  // add a proximity-only term with an inflated raw score
  input.terms.push({
    full_strike_text: 'Will Biden say it? -- Aardvark',
    short_term: 'Aardvark', cpc_score: 99, bucket: 'watch-only',
    evidence_status: 'proximity scaffold only -- no pick',
    layers_present: ['1/9'], composite_posture: 'WATCH',
    missing_research_layers: [], upgrade_trigger: null,
    market_context: { implied: null, bid_cents: null, ask_cents: null, note: 'NOT IN SCORE' },
  });
  const text = renderMentionPacket(input, { generatedAtUtc: NOW });
  const rows = text.split('3. TOP WATCH TERMS')[0].split('\n').filter((l) => /^\d+\s/.test(l.trim()));
  const aardvarkRank = rows.findIndex((r) => r.includes('Aardvark'));
  assert.equal(aardvarkRank, rows.length - 1, 'scaffold ranks last despite raw score 99');
  assert.ok(rows[aardvarkRank].includes('scaffold'));
});

test('redteam validator fails closed on garbage', () => {
  const r = validateRedteamJson([1, 2, 3]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.value.narrative_risks, []);
});
