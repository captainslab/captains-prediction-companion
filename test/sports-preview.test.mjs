import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORBIDDEN_MARKET_TERMS,
  buildMlbGamePreviewPrompt,
  buildMlbSlatePreviewPrompt,
  buildWorldCupMatchPreviewPrompt,
  buildWorldCupMatchdayPreviewPrompt,
} from '../scripts/shared/perplexity-preview-prompts.mjs';
import {
  BANNED_MODEL_INPUT_KEYS,
  sanitizeResearchArtifact,
  assertNoMarketLeak,
} from '../scripts/shared/preview-artifact-sanitizer.mjs';
import {
  BANNED_CUSTOMER_PREVIEW_WORDS,
  buildSportsPreview,
  assembleCpcPreviewPacket,
} from '../scripts/shared/sports-preview-builder.mjs';
import {
  validateCpcCustomerPacket,
  assertCpcPacketValid,
} from '../scripts/packets/lib/cpc-packet-validator.mjs';

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function promptCases() {
  return [
    {
      builder: buildMlbGamePreviewPrompt,
      anchor: {
        game_id: 'mlb-001',
        date: '2026-06-22',
        matchup: 'Away at Home',
        venue: 'Example Park',
      },
      packet_type: 'mlb-game',
      sport: 'mlb',
    },
    {
      builder: buildMlbSlatePreviewPrompt,
      anchor: {
        game_id: 'mlb-slate-001',
        date: '2026-06-22',
        matchup: 'Slate board',
        venue: 'Multiple parks',
      },
      packet_type: 'mlb-slate',
      sport: 'mlb',
    },
    {
      builder: buildWorldCupMatchPreviewPrompt,
      anchor: {
        match_id: 'wc-001',
        date: '2026-06-22',
        matchup: 'Team A vs Team B',
        venue: 'Example Stadium',
      },
      packet_type: 'worldcup-match',
      sport: 'worldcup',
    },
    {
      builder: buildWorldCupMatchdayPreviewPrompt,
      anchor: {
        match_id: 'wc-matchday-001',
        date: '2026-06-22',
        matchup: 'Matchday board',
        venue: 'Multiple stadiums',
      },
      packet_type: 'worldcup-matchday',
      sport: 'worldcup',
    },
  ];
}

test('prompt builders exist and forbid every market term', () => {
  for (const { builder, anchor, packet_type, sport } of promptCases()) {
    const prompt = builder(anchor);
    assert.equal(prompt.packet_type, packet_type);
    assert.equal(prompt.sport, sport);
    assert.ok(prompt.system.trim().length > 0);
    assert.ok(prompt.user.trim().length > 0);
    assert.ok(prompt.output_schema);
    for (const term of FORBIDDEN_MARKET_TERMS) {
      assert.match(prompt.user, new RegExp(escapeRegExp(term), 'i'));
    }
  }
});

test('sanitizeResearchArtifact strips market keys and records removals', () => {
  const artifact = {
    schema: 'sports_preview_research_v1',
    sport: 'mlb',
    packet_type: 'mlb-game',
    game_id: 'mlb-001',
    generated_at: '2026-06-22T12:00:00Z',
    source_id: 'perplexity',
    source_urls: ['https://example.com/a'],
    source_titles: ['Example title'],
    source_freshness: { status: 'fresh' },
    confirmed_facts: ['confirmed'],
    unconfirmed_claims: ['unconfirmed'],
    unavailable_fields: ['weather'],
    model_safe_inputs: {
      starters: {
        away: 'A',
        home: 'H',
        odds: '-110',
      },
      market: {
        bid: 11,
        ask: 12,
        open_interest: 13,
        volume: 14,
        liquidity: 15,
        orderbook: { spread_price: 16 },
      },
      nested: {
        spread: '1.5',
        deeper: {
          bid_ask: '52/48',
          yes_bid: '52',
        },
      },
    },
    editorial_context: { rivalry_h2h: 'rivalry' },
    market_context: { display_only: false, line: 'remove me' },
  };

  const sanitized = sanitizeResearchArtifact(artifact);
  assert.ok(sanitized.sanitized_removed.includes('odds'));
  assert.ok(sanitized.sanitized_removed.includes('bid'));
  assert.ok(sanitized.sanitized_removed.includes('ask'));
  assert.ok(sanitized.sanitized_removed.includes('open_interest'));
  assert.ok(sanitized.sanitized_removed.includes('volume'));
  assert.ok(sanitized.sanitized_removed.includes('liquidity'));
  assert.ok(sanitized.sanitized_removed.includes('orderbook'));
  assert.ok(sanitized.sanitized_removed.includes('spread_price'));
  assert.ok(sanitized.sanitized_removed.includes('spread'));
  assert.ok(sanitized.sanitized_removed.includes('bid_ask'));
  assert.ok(sanitized.sanitized_removed.includes('yes_bid'));
  assert.ok(sanitized.sanitized_removed.includes('market_context'));
  assert.ok(sanitized.unavailable_fields.includes('odds'));
  assert.ok(sanitized.unavailable_fields.includes('bid'));
  assert.ok(sanitized.unavailable_fields.includes('ask'));
  assert.ok(sanitized.unavailable_fields.includes('open_interest'));
  assert.ok(sanitized.unavailable_fields.includes('market_context'));
  assert.ok(!('market_context' in sanitized));
  assertNoMarketLeak(sanitized.model_safe_inputs);
});

test('sanitizeResearchArtifact removes market_snapshot container entirely', () => {
  const artifact = {
    schema: 'sports_preview_research_v1',
    sport: 'mlb',
    packet_type: 'mlb-game',
    game_id: 'mlb-003',
    generated_at: '2026-06-22T12:00:00Z',
    source_id: 'perplexity',
    source_urls: ['https://example.com/snapshot'],
    source_titles: ['Snapshot source'],
    source_freshness: { status: 'fresh' },
    confirmed_facts: ['confirmed'],
    unconfirmed_claims: [],
    unavailable_fields: [],
    model_safe_inputs: {
      starters: { away: 'A', home: 'H' },
      market_snapshot: {
        bid_ask: '51/49',
        odds: '-110',
        notes: 'snapshot notes',
      },
    },
    editorial_context: { storyline: 'context' },
    why_this_game_matters: 'Why text.',
    headline_candidates: ['Headline'],
  };

  const sanitized = sanitizeResearchArtifact(artifact);
  assert.ok(!('market_snapshot' in sanitized.model_safe_inputs), 'market_snapshot must be removed from model_safe_inputs');
  assert.ok(sanitized.sanitized_removed.includes('market_snapshot'), 'market_snapshot must be recorded in sanitized_removed');
  assert.ok(sanitized.unavailable_fields.includes('market_snapshot'), 'market_snapshot must be recorded in unavailable_fields');
  assert.ok(sanitized.model_safe_inputs.starters.away === 'A', 'unrelated model_safe_inputs fields must survive');
  assertNoMarketLeak(sanitized.model_safe_inputs);
});

test('source-backed MLB preview uses research why text and model output values', () => {
  const research = sanitizeResearchArtifact({
    schema: 'sports_preview_research_v1',
    sport: 'mlb',
    packet_type: 'mlb-game',
    game_id: 'mlb-002',
    generated_at: '2026-06-22T12:00:00Z',
    source_id: 'perplexity',
    source_urls: ['https://example.com/mlb'],
    source_titles: ['MLB source title'],
    source_freshness: { status: 'fresh' },
    confirmed_facts: ['confirmed'],
    unconfirmed_claims: [],
    unavailable_fields: ['weather'],
    model_safe_inputs: { starters: { away: 'A', home: 'H' } },
    editorial_context: { tactical_angle: 'tactical contrast' },
    why_this_game_matters: 'Why text for MLB.',
    headline_candidates: ['MLB headline'],
    risk_notes: ['risk'],
  });
  const model = {
    result_edge: 'Home edge',
    projection: 'Projected 8.1 total runs',
    total_environment: 'Neutral-to-slightly under total environment',
    caveat: 'Late scratches would weaken the read.',
    context_summary: 'division race context',
    display_only_market_line: 'Home side 56¢ vs away side 44¢.',
  };
  const preview = buildSportsPreview({
    sport: 'mlb',
    packet_type: 'mlb-game',
    id: research.game_id,
    model,
    research,
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });

  assert.equal(preview.used_research, true);
  assert.equal(preview.fallback, false);
  assert.match(preview.sections.why_it_matters, /Why text for MLB\./);
  assert.match(preview.text, /Projected 8\.1 total runs/);
});

test('source-backed world cup preview uses match why text and model output values', () => {
  const research = sanitizeResearchArtifact({
    schema: 'sports_preview_research_v1',
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    match_id: 'wc-002',
    generated_at: '2026-06-22T12:00:00Z',
    source_id: 'perplexity',
    source_urls: ['https://example.com/worldcup'],
    source_titles: ['World Cup source title'],
    source_freshness: { status: 'fresh' },
    confirmed_facts: ['confirmed'],
    unconfirmed_claims: [],
    unavailable_fields: ['weather'],
    model_safe_inputs: { lineup_status: 'confirmed' },
    editorial_context: { tactical_angle: 'tactical contrast' },
    why_this_match_matters: 'Why text for the match.',
    headline_candidates: ['World Cup headline'],
    risk_notes: ['risk'],
  });
  const model = {
    result_edge: 'Compact shape edge',
    projection: 'Projected 2.3 goals',
    total_environment: 'Controlled total environment',
    caveat: 'A single set piece can flip the read.',
    context_summary: 'bracket stakes',
  };
  const preview = buildSportsPreview({
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    id: research.match_id,
    model,
    research,
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });

  assert.equal(preview.used_research, true);
  assert.equal(preview.fallback, false);
  assert.match(preview.sections.why_it_matters, /Why text for the match\./);
  assert.match(preview.text, /Projected 2\.3 goals/);
});

test('preview does not invent weather when weather is unavailable', () => {
  const research = sanitizeResearchArtifact({
    schema: 'sports_preview_research_v1',
    sport: 'mlb',
    packet_type: 'mlb-game',
    game_id: 'mlb-003',
    generated_at: '2026-06-22T12:00:00Z',
    source_id: 'perplexity',
    source_urls: ['https://example.com/mlb-weather'],
    source_titles: ['Weather source'],
    source_freshness: { status: 'fresh' },
    confirmed_facts: ['confirmed'],
    unconfirmed_claims: [],
    unavailable_fields: ['weather'],
    model_safe_inputs: { starters: { away: 'A', home: 'H' } },
    editorial_context: { public_narrative: 'Narrative only' },
    why_this_game_matters: 'Why text for weather test.',
    headline_candidates: ['Weather headline'],
    risk_notes: ['risk'],
  });
  const preview = buildSportsPreview({
    sport: 'mlb',
    packet_type: 'mlb-game',
    id: research.game_id,
    model: {
      result_edge: 'Home edge',
      projection: 'Projected 8.0 runs',
      total_environment: 'Neutral total environment',
      caveat: 'Caveat',
      context_summary: 'Context',
    },
    research,
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });

  assert.match(preview.sections.storyline, /weather context is not sourced/i);
  assert.doesNotMatch(preview.sections.storyline, /weather.*\d/i);
});

test('fallback preview keeps why_it_matters and avoids source citations', () => {
  const preview = buildSportsPreview({
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    id: 'wc-004',
    model: {
      why_it_matters: 'Bracket position keeps the match meaningful.',
      context_summary: 'Bracket position keeps the match meaningful.',
      result_edge: 'Transition edge',
      projection: 'Projected 2.1 goals',
      total_environment: 'Controlled total environment',
      caveat: 'Nothing sourced.',
    },
    research: null,
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });

  assert.equal(preview.used_research, false);
  assert.equal(preview.fallback, true);
  assert.match(preview.sections.why_it_matters, /Bracket position keeps the match meaningful\./);
  assert.match(preview.text, /No external source confirmed for this preview\./);
  assert.doesNotThrow(() => preview.text);
});

test('customer-facing preview text avoids banned words, paths, and ISO timestamps', () => {
  const preview = buildSportsPreview({
    sport: 'mlb',
    packet_type: 'mlb-game',
    id: 'mlb-005',
    model: {
      result_edge: 'Home edge',
      projection: 'Projected 8.0 runs',
      total_environment: 'Neutral total environment',
      caveat: 'Caveat',
      context_summary: 'Context',
    },
    research: {
      status: 'ok',
      headline_candidates: ['A clean headline'],
      why_this_game_matters: 'Clean why text.',
      source_titles: ['Clean source'],
      editorial_context: { tactical_angle: 'Clean angle' },
      unavailable_fields: [],
    },
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });

  for (const term of BANNED_CUSTOMER_PREVIEW_WORDS) {
    assert.doesNotMatch(preview.text, new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'));
  }
  assert.doesNotMatch(preview.text, /\/home\//);
  assert.doesNotMatch(preview.text, /\.mjs/);
  assert.doesNotMatch(preview.text, /\d{4}-\d\d-\d\dT\d\d:\d\d/);
});

test('display-only market context does not change model-facing preview sections', () => {
  const research = {
    status: 'ok',
    headline_candidates: ['Display-only headline'],
    why_this_game_matters: 'Display-only why text.',
    source_titles: ['Display-only source'],
    editorial_context: { tactical_angle: 'Display-only angle' },
    unavailable_fields: [],
  };
  const sharedModel = {
    result_edge: 'Home edge',
    projection: 'Projected 8.0 runs',
    total_environment: 'Neutral total environment',
    caveat: 'Caveat',
    context_summary: 'Context',
  };
  const base = buildSportsPreview({
    sport: 'mlb',
    packet_type: 'mlb-game',
    id: 'mlb-006',
    model: sharedModel,
    research,
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });
  const withMarketLine = buildSportsPreview({
    sport: 'mlb',
    packet_type: 'mlb-game',
    id: 'mlb-006',
    model: {
      ...sharedModel,
      display_only_market_line: 'Home side 56¢ vs away side 44¢.',
    },
    research,
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });

  assert.deepEqual(withMarketLine.sections.quick_read, base.sections.quick_read);
  assert.equal(withMarketLine.sections.headline, base.sections.headline);
  assert.equal(withMarketLine.sections.why_it_matters, base.sections.why_it_matters);
  assert.equal(withMarketLine.sections.storyline, base.sections.storyline);
  assert.notEqual(withMarketLine.text, base.text);
  assert.match(withMarketLine.text, /Market context \(display only, NOT IN SCORE\):/);
});

test('assembled CPC preview packets pass the shared validator', () => {
  const researchBackedPreview = buildSportsPreview({
    sport: 'mlb',
    packet_type: 'mlb-game',
    id: 'mlb-007',
    model: {
      result_edge: 'Home edge',
      projection: 'Projected 8.0 runs',
      total_environment: 'Neutral total environment',
      caveat: 'Caveat',
      context_summary: 'Context',
    },
    research: {
      status: 'ok',
      headline_candidates: ['Valid headline'],
      why_this_game_matters: 'Valid why text.',
      source_titles: ['Valid source'],
      editorial_context: { tactical_angle: 'Angle' },
      unavailable_fields: [],
    },
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });
  const fallbackPreview = buildSportsPreview({
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    id: 'wc-007',
    model: {
      why_it_matters: 'Valid match context.',
      result_edge: 'Compact edge',
      projection: 'Projected 2.2 goals',
      total_environment: 'Controlled total environment',
      caveat: 'Caveat',
    },
    research: null,
    generatedAtUtc: '2026-06-22T12:00:00Z',
  });

  const researchBackedPacket = assembleCpcPreviewPacket({
    title: 'Research-backed preview',
    generatedAtUtc: '2026-06-22T12:00:00Z',
    previewText: researchBackedPreview.text,
  });
  const fallbackPacket = assembleCpcPreviewPacket({
    title: 'Fallback preview',
    generatedAtUtc: '2026-06-22T12:00:00Z',
    previewText: fallbackPreview.text,
  });

  assert.equal(validateCpcCustomerPacket(researchBackedPacket).valid, true);
  assert.equal(validateCpcCustomerPacket(fallbackPacket).valid, true);
  assert.doesNotThrow(() => assertCpcPacketValid(researchBackedPacket, 'research-backed'));
  assert.doesNotThrow(() => assertCpcPacketValid(fallbackPacket, 'fallback'));
});
