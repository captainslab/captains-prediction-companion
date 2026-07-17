import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';
import { composeMentionLedgerFromTermRecord } from '../scripts/mentions/mention-composite-core.mjs';

function baseInput(terms) {
  return {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-07-16',
    research_provenance: { research_route: 'earnings_call' },
    event: {
      title: 'What will Acme say during their next earnings call?',
      subtitle: 'Acme earnings call',
      settlement_source_link: 'https://ir.acme.example/events/2026',
      rules_primary: 'If Acme says the strike term during the earnings call, resolves Yes.',
    },
    summary: { market_count: terms.length },
    terms,
  };
}

test('a row without canonical_term_record renders exactly as before (no Model: block)', () => {
  const text = renderMentionPacket(baseInput([
    { full_strike_text: 'Acme earnings -- Widget', short_term: 'Widget', cpc_score: 60, research_state: 'research-backed' },
  ]), { generatedAtUtc: '2026-07-16T12:00:00.000Z' });
  assert.doesNotMatch(text, /^Model:/m, 'rows without a canonical_term_record must not gain a Model: block');
});

test('a row carrying canonical_term_record renders Pd/Ph/Pe/historical/final and citations', () => {
  const rec = composeMentionLedgerFromTermRecord({
    event: 'Acme Q2 FY26',
    targetMention: 'Widget',
    profile: 'earnings_mentions',
    layerDefs: [
      { key: 'baseline_relevance', weight: 0.5, label: 'baseline' },
      { key: 'direct_mention_pathway', weight: 0.5, label: 'direct' },
    ],
    layerRecords: {
      baseline_relevance: { present: true, score: 85, source_basis: 'confirmed agenda', source_path: 'https://example.com/agenda' },
      direct_mention_pathway: { present: true, score: 80, source_basis: 'prior call script', source_path: 'https://example.com/script' },
    },
    canonicalHistory: { status: 'present', hits: 3, sample_size: 6 },
  });

  const text = renderMentionPacket(baseInput([
    {
      full_strike_text: 'Acme earnings -- Widget',
      short_term: 'Widget',
      cpc_score: rec.composite_score,
      research_state: 'research-backed',
      canonical_term_record: rec.canonical_term_record,
    },
  ]), { generatedAtUtc: '2026-07-16T12:00:00.000Z' });

  assert.match(text, /^Model:/m, 'a row with canonical_term_record must render a Model: block');
  assert.match(text, /Historical prior:/);
  assert.match(text, /Pd: \d+%/);
  assert.match(text, /Ph: \d+%/);
  assert.match(text, /Pe: \d+%/);
  assert.match(text, /Final: \d+% \[term_pd_ph_pe_v1\]/);
  assert.match(text, /Model citations:/);
  assert.match(text, /example\.com/);
});

test('canonical_term_record with no citations omits the citations line but still renders the model block', () => {
  const rec = composeMentionLedgerFromTermRecord({
    event: 'Acme Q2 FY26',
    targetMention: 'Gadget',
    profile: 'earnings_mentions',
    layerDefs: [{ key: 'baseline_relevance', weight: 1, label: 'baseline' }],
    layerRecords: { baseline_relevance: { present: true, score: 40 } }, // no source_basis/source_path -> uncited
  });
  const text = renderMentionPacket(baseInput([
    {
      full_strike_text: 'Acme earnings -- Gadget',
      short_term: 'Gadget',
      cpc_score: rec.composite_score,
      research_state: 'research-backed',
      canonical_term_record: rec.canonical_term_record,
    },
  ]), { generatedAtUtc: '2026-07-16T12:00:00.000Z' });
  assert.match(text, /^Model:/m);
  assert.doesNotMatch(text, /Model citations:/, 'uncited evidence must not fabricate a citation line');
});
