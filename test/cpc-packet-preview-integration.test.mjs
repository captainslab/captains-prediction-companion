// Integration tests for the unified CPC packet preview adapter: proves that a
// banked, sanitized research artifact for the exact Kalshi fixtures renders a
// source-backed Headline / Why it matters / Storyline / Quick read block, that
// stale/absent research falls back cleanly, and that price/market data can
// never reach the preview. Hermetic + network-free (temp bank root only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeEmptyCpcResearchArtifact } from '../scripts/shared/cpc-research-artifact-schema.mjs';
import { sanitizeResearchArtifact } from '../scripts/shared/preview-artifact-sanitizer.mjs';
import {
  writeResearchBankArtifacts,
  classifyResearchFreshness,
  readResearchBankArtifact,
} from '../scripts/shared/cpc-research-bank.mjs';
import {
  buildPacketPreviewBlock,
  buildMentionsPreview,
} from '../scripts/shared/cpc-preview-adapter.mjs';
import {
  BANNED_CUSTOMER_PREVIEW_WORDS,
  assembleCpcPreviewPacket,
} from '../scripts/shared/sports-preview-builder.mjs';
import { renderWorldCupPacket } from '../scripts/worldcup/lib/packet-renderer.mjs';

const DATE = '2026-06-22';

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bankFixture(root, { generated_at = `${DATE}T13:00:00Z`, freshness = 'same_day', ...partial }) {
  const artifact = makeEmptyCpcResearchArtifact({
    generated_at,
    source_freshness: [{ url: 'https://example.com', published_at: 'unavailable', checked_at: generated_at, freshness }],
    ...partial,
  });
  const sanitized = sanitizeResearchArtifact(artifact);
  writeResearchBankArtifacts({
    date: DATE,
    packet_family: sanitized.packet_family,
    packet_type: sanitized.packet_type,
    event_id: sanitized.event_id,
    route: sanitized.route,
    submarket: sanitized.submarket,
    raw: artifact,
    normalized: artifact,
    sanitized,
    builderInput: { sanitized_artifact: sanitized },
    previewText: 'banked',
    lineage: {
      generated_at,
      source_id: 'perplexity',
      source_urls: artifact.source_urls,
      source_titles: artifact.source_titles,
      source_freshness: artifact.source_freshness,
    },
    root,
  });
  return sanitized;
}

function withTempBank(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpc-preview-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertCustomerSafe(text) {
  for (const term of BANNED_CUSTOMER_PREVIEW_WORDS) {
    assert.doesNotMatch(text, new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'), `banned word ${term} leaked`);
  }
  assert.doesNotMatch(text, /\/home\//, 'local path leaked');
  assert.doesNotMatch(text, /\.mjs/, 'module path leaked');
  assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:\d\d/, 'ISO timestamp leaked');
}

function assertPreviewShape(block) {
  assert.match(block.text, /^Headline: /m);
  assert.match(block.text, /^Why it matters: /m);
  assert.match(block.text, /^Storyline: /m);
  assert.match(block.text, /^Quick read:/m);
  assertCustomerSafe(block.text);
}

test('earnings mention packet renders source-backed call/company context', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'mentions',
      packet_type: 'earnings-call-mention',
      route: 'earnings_call',
      submarket: 'event',
      event_id: 'KXEARNINGSMENTIONCCL-26JUN23',
      source_titles: ['News & Events | Carnival Corporation & plc'],
      model_safe_inputs: { company_identity: 'Carnival Corporation & plc', current_guidance_topics: ['booking trends', 'fuel costs'] },
      why_this_matters: 'Cruise-line calls revisit demand, yield, and cost vocabulary.',
      headline_candidates: ['Carnival call centers on demand and cost vocabulary'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'earnings-call-mention',
      route: 'earnings_call', submarket: 'event', event_id: 'KXEARNINGSMENTIONCCL-26JUN23',
      model: { model_read: 'demand-vocabulary posture', caveat: 'prepared remarks may post late' }, root,
    });
    assertPreviewShape(block);
    assert.equal(block.used_research, true);
    assert.equal(block.freshness_status, 'fresh');
    assert.match(block.text, /Carnival Corporation/);
    assert.match(block.text, /Route \/ market family: earnings_call/);
  });
});

test('hearing/testimony packet renders source-backed hearing context', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'mentions', packet_type: 'hearing-testimony-mention',
      route: 'debate_hearing', submarket: 'event', event_id: 'KXHEARINGMENTION-26JUN23B',
      source_titles: ['Hearings | Senate Committee on Banking, Housing, and Urban Affairs'],
      model_safe_inputs: { committee_or_agency: 'Senate Banking Committee', hearing_title: 'The Affordability Agenda' },
      why_this_matters: 'The hearing topic frames which policy terms surface.',
      headline_candidates: ['Affordability hearing frames the testimony vocabulary'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'hearing-testimony-mention',
      route: 'debate_hearing', submarket: 'event', event_id: 'KXHEARINGMENTION-26JUN23B', model: {}, root,
    });
    assertPreviewShape(block);
    assert.match(block.text, /Senate Banking Committee|Affordability Agenda/);
  });
});

test('hearing word-bank packet renders word_bank and threshold_rule context', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'mentions', packet_type: 'hearing-word-bank-mention',
      route: 'debate_hearing', submarket: 'word_bank_threshold', event_id: 'KXHEARINGMENTION-26JUN23B',
      source_titles: ['Hearings | Senate Committee on Banking, Housing, and Urban Affairs'],
      model_safe_inputs: {
        word_bank: ['American Dream', 'Fannie / Freddie', 'Trump'],
        threshold_rule: 'Trump (3+ times)',
      },
      why_this_matters: 'The hearing title narrows the likely word-bank universe.',
      headline_candidates: ['Affordability hearing narrows the likely word-bank universe'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'hearing-word-bank-mention',
      route: 'debate_hearing', submarket: 'word_bank_threshold', event_id: 'KXHEARINGMENTION-26JUN23B', model: {}, root,
    });
    assertPreviewShape(block);
    assert.match(block.text, /American Dream/);
    assert.match(block.text, /Trump \(3\+ times\)/);
    assert.match(block.text, /Route \/ market family: debate_hearing \/ word_bank_threshold/);
  });
});

test('Trump/public-figure packet renders source-backed event/horizon context', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'mentions', packet_type: 'public-figure-mention',
      route: 'trump_event', submarket: 'event', event_id: 'KXTRUMPMENTION-26JUN23',
      source_titles: ['News | The White House'],
      model_safe_inputs: { speaker_identity: 'President of the United States', event_type: 'public address', horizon: 'event' },
      why_this_matters: 'The scheduled appearance frames likely recurring topics.',
      headline_candidates: ['Scheduled address frames the likely topic vocabulary'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'public-figure-mention',
      route: 'trump_event', submarket: 'event', event_id: 'KXTRUMPMENTION-26JUN23', model: {}, root,
    });
    assertPreviewShape(block);
    assert.match(block.text, /public address|President of the United States/);
  });
});

test('sports mention packet renders source-backed game/broadcast context', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'mentions', packet_type: 'sports-mention',
      route: 'sports_announcer', submarket: 'event', event_id: 'KXWCMENTION-26JUN22NORSEN',
      source_titles: ['Match Centre | FIFA'],
      model_safe_inputs: { matchup: 'Norway vs Senegal', competition_stage: 'group stage' },
      why_this_matters: 'Broadcast framing around a group-stage decider shapes announcer phrasing.',
      headline_candidates: ['Group-stage stakes shape the broadcast vocabulary'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'sports-mention',
      route: 'sports_announcer', submarket: 'event', event_id: 'KXWCMENTION-26JUN22NORSEN', model: {}, root,
    });
    assertPreviewShape(block);
    assert.match(block.text, /Norway vs Senegal/);
  });
});

test('TV/show mention packet renders source-backed show/episode context', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'mentions', packet_type: 'tv-show-mention',
      route: 'talk_show_media', submarket: 'event', event_id: 'KXLOVEISLMENTION-26JUN22',
      source_titles: ['Love Island | ITVX'],
      model_safe_inputs: { show_title: 'Love Island', network_or_platform: 'ITVX' },
      why_this_matters: 'Recurring show vocabulary shapes which phrases appear.',
      headline_candidates: ['Recurring format beats shape the episode vocabulary'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'tv-show-mention',
      route: 'talk_show_media', submarket: 'event', event_id: 'KXLOVEISLMENTION-26JUN22', model: {}, root,
    });
    assertPreviewShape(block);
    assert.match(block.text, /Love Island|ITVX/);
  });
});

test('MLB packet renders source-backed preview from sanitized artifact', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'sports', packet_type: 'mlb-game',
      route: 'mlb_game', submarket: 'game_preview', event_id: 'KXMLBGAME-26JUN221810NYYDET',
      source_titles: ['Baseball Probable Pitchers | MLB.com'],
      model_safe_inputs: { probable_pitchers: { away: 'Gerrit Cole', home: 'Framber Valdez' } },
      editorial_context: { public_narrative: 'A brand-name Yankees road game against a below-.500 Detroit club.' },
      why_this_matters: 'Both teams have standings stakes in late June.',
      headline_candidates: ['Division leader meets spoiler candidate in Detroit'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'sports', packet_type: 'mlb-game',
      route: 'mlb_game', submarket: 'game_preview', event_id: 'KXMLBGAME-26JUN221810NYYDET',
      model: { result_edge: 'home rotation steadier', projection: 'projected 8 runs', caveat: 'lineups unconfirmed' }, root,
    });
    assertPreviewShape(block);
    assert.equal(block.used_research, true);
    assert.match(block.text, /Division leader meets spoiler/);
    // Envelope assembly must validate.
    const packet = assembleCpcPreviewPacket({ title: 'MLB — KXMLBGAME', generatedAtUtc: `${DATE}T18:10:00Z`, previewText: block.text });
    assert.match(packet, /=== CPC Packet:/);
    assert.match(packet, /Research only\. No trades\./);
  });
});

test('World Cup packet renders source-backed preview from sanitized artifact', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'sports', packet_type: 'worldcup-match',
      route: 'worldcup_match', submarket: 'match_preview', event_id: 'KXWCGAME-26JUN22NORSEN',
      source_titles: ['Match Centre | FIFA'],
      editorial_context: { public_storyline: 'A cross-confederation group fixture with contrasting styles.' },
      why_this_matters: 'The result reshapes group advancement for both federations.',
      headline_candidates: ['Group-stage advancement on the line in Norway vs Senegal'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'sports', packet_type: 'worldcup-match',
      route: 'worldcup_match', submarket: 'match_preview', event_id: 'KXWCGAME-26JUN22NORSEN',
      model: { result_edge: 'narrow model read', projection: 'projected 2 goals', caveat: 'lineups unconfirmed' }, root,
    });
    assertPreviewShape(block);
    assert.equal(block.used_research, true);
    assert.match(block.text, /Norway vs Senegal/);
  });
});

test('World Cup matchday RENDERER injects a source-backed preview for the resolved ticker', () => {
  withTempBank((root) => {
    bankFixture(root, {
      packet_family: 'sports', packet_type: 'worldcup-match',
      route: 'worldcup_match', submarket: 'match_preview', event_id: 'KXWCGAME-26JUN22NORSEN',
      source_titles: ['Match Centre | FIFA'],
      why_this_matters: 'The result reshapes group advancement for both federations.',
      headline_candidates: ['Group-stage advancement on the line in Norway vs Senegal'],
    });

    // kickoff resolves to America/Chicago calendar date 2026-06-22 → ticker
    // KXWCGAME-26JUN22NORSEN, matching the banked artifact above.
    const match = {
      match_id: '400021491', home_team: 'Norway', away_team: 'Senegal',
      group: 'Group I', kickoff_utc: '2026-06-23T00:00:00.000Z', venue: 'New York/New Jersey Stadium',
    };
    const board = {
      goal_projection: {
        projection_status: 'PROJECTED', projected_home_goals: 1.14, projected_away_goals: 1.52,
        projected_total_goals: 2.66, projected_goal_margin_home: -0.38, cross_check_1x2: { verdict: 'CONSISTENT' },
      },
      lanes: [{ lane: 'match_winner', recommendation: 'LEAN_AWAY', p_home: 0.30, p_draw: 0.28, p_away: 0.42 }],
      layers_total: 14, layers_present_home: 6, layers_present_away: 6,
    };

    const packet = renderWorldCupPacket({
      matches: [match], boards: [board], meta: { date: DATE, research: { status: 'ok' }, research_root: root },
    });

    assert.match(packet, /Source-backed preview:/, 'renderer did not inject the source-backed block');
    assert.match(packet, /source-backed preview: gathered — Perplexity research, event KXWCGAME-26JUN22NORSEN, freshness fresh/);
    assert.match(packet, /Perplexity source-backed previews: attached for 1\/1 matches\./);
    assert.match(packet, /Group-stage advancement on the line in Norway vs Senegal/);
    assert.match(packet, /Primary source: Match Centre \| FIFA/);
    // Customer-safety is asserted on the INJECTED preview block only — the WC
    // packet's own sections (e.g. "Pre-lock") are governed by the WC janitor /
    // contract validators, not the preview banned-word list.
    const start = packet.indexOf('  Source-backed preview:');
    const previewBlock = packet.slice(start, packet.indexOf('────────', start));
    assertCustomerSafe(previewBlock);
  });
});

test('World Cup matchday RENDERER omits the preview block when no artifact is banked', () => {
  withTempBank((root) => {
    const match = {
      match_id: '999', home_team: 'Norway', away_team: 'Senegal',
      group: 'Group I', kickoff_utc: '2026-06-23T00:00:00.000Z',
    };
    const board = { goal_projection: { projection_status: 'NONE' }, lanes: [], layers_total: 14, layers_present_home: 0, layers_present_away: 0 };
    const packet = renderWorldCupPacket({
      matches: [match], boards: [board], meta: { date: DATE, research: { status: 'ok' }, research_root: root },
    });
    assert.doesNotMatch(packet, /Source-backed preview:/, 'no source → no injected block');
    assert.match(packet, /source-backed preview: unavailable — no fresh match-level preview attached/);
    assert.match(packet, /Perplexity source-backed previews: unavailable — no fresh match-level preview attachment\./);
    assert.match(packet, /Norway vs Senegal/, 'match breakdown still renders');
  });
});

test('World Cup matchday RENDERER omits stale preview artifacts from the source-backed attachment path', () => {
  withTempBank((root) => {
    bankFixture(root, {
      generated_at: '2026-06-10T12:00:00Z',
      freshness: 'stale',
      packet_family: 'sports', packet_type: 'worldcup-match',
      route: 'worldcup_match', submarket: 'match_preview', event_id: 'KXWCGAME-26JUN22NORSEN',
      source_titles: ['Match Centre | FIFA'],
      why_this_matters: 'Historical note only.',
      headline_candidates: ['Historical preview only'],
    });

    const match = {
      match_id: '400021491', home_team: 'Norway', away_team: 'Senegal',
      group: 'Group I', kickoff_utc: '2026-06-23T00:00:00.000Z', venue: 'New York/New Jersey Stadium',
    };
    const board = {
      goal_projection: {
        projection_status: 'PROJECTED', projected_home_goals: 1.14, projected_away_goals: 1.52,
        projected_total_goals: 2.66, projected_goal_margin_home: -0.38, cross_check_1x2: { verdict: 'CONSISTENT' },
      },
      lanes: [{ lane: 'match_winner', recommendation: 'LEAN_AWAY', p_home: 0.30, p_draw: 0.28, p_away: 0.42 }],
      layers_total: 14, layers_present_home: 6, layers_present_away: 6,
    };

    const packet = renderWorldCupPacket({
      matches: [match], boards: [board], meta: { date: DATE, research: { status: 'ok' }, research_root: root },
    });

    assert.doesNotMatch(packet, /Source-backed preview:/, 'stale research must not render as a source-backed preview block');
    assert.match(packet, /source-backed preview: unavailable — banked preview stale and not treated as fresh evidence/);
    assert.match(packet, /Perplexity source-backed previews: unavailable — no fresh match-level preview attachment\./);
  });
});

test('fallback preview works when research artifact is unavailable', () => {
  withTempBank((root) => {
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'earnings-call-mention',
      route: 'earnings_call', submarket: 'event', event_id: 'KXNOSUCHEVENT-26JUN23',
      model: { why_it_matters: 'Deterministic model context only.', model_read: 'model-only read', key_uncertainty: 'no banked source' }, root,
    });
    assertPreviewShape(block);
    assert.equal(block.artifact_found, false);
    assert.equal(block.used_research, false);
    assert.equal(block.fallback, true);
    assert.equal(block.freshness_status, 'no_artifact');
    assert.match(block.text, /deterministic model and source-health only|Research gap/i);
  });
});

test('stale banked artifact is labeled and not treated as fresh fact', () => {
  withTempBank((root) => {
    bankFixture(root, {
      generated_at: '2026-01-01T13:00:00Z',
      freshness: 'stale',
      packet_family: 'mentions', packet_type: 'tv-show-mention',
      route: 'talk_show_media', submarket: 'event', event_id: 'KXLOVEISLMENTION-26JUN22',
      source_titles: ['Love Island | ITVX'],
      model_safe_inputs: { show_title: 'Love Island' },
      headline_candidates: ['Stale banked headline that must not be treated as fresh'],
    });
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'mentions', packet_type: 'tv-show-mention',
      route: 'talk_show_media', submarket: 'event', event_id: 'KXLOVEISLMENTION-26JUN22',
      model: { model_read: 'model-only read' }, root,
    });
    assertPreviewShape(block);
    assert.equal(block.artifact_found, true);
    assert.equal(block.used_research, false, 'stale artifact must not be used as fresh research');
    assert.equal(block.freshness_status, 'stale');
    assert.match(block.text, /Research note: banked context is stale/);
    // The stale banked headline must NOT appear as a fresh fact.
    assert.doesNotMatch(block.text, /Stale banked headline/);
  });
});

test('classifyResearchFreshness: fresh, aging, stale, unknown', () => {
  assert.equal(classifyResearchFreshness({ metadata: { generated_at: `${DATE}T10:00:00Z`, source_freshness: [{ freshness: 'same_day' }] }, packetDate: DATE }).status, 'fresh');
  assert.equal(classifyResearchFreshness({ metadata: { generated_at: '2026-06-19T10:00:00Z', source_freshness: [{ freshness: '2to7d' }] }, packetDate: DATE }).status, 'aging');
  assert.equal(classifyResearchFreshness({ metadata: { generated_at: '2026-01-01T10:00:00Z', source_freshness: [{ freshness: '2to7d' }] }, packetDate: DATE }).status, 'stale');
  assert.equal(classifyResearchFreshness({ metadata: { generated_at: 'unavailable' }, packetDate: DATE }).status, 'unknown');
});

test('market_context display-only cannot change model preview sections', () => {
  withTempBank((root) => {
    const common = {
      date: DATE, packet_family: 'sports', packet_type: 'mlb-game',
      route: 'mlb_game', submarket: 'game_preview', event_id: 'KXMLBGAME-26JUN221810NYYDET', root,
    };
    bankFixture(root, {
      packet_family: 'sports', packet_type: 'mlb-game', route: 'mlb_game', submarket: 'game_preview',
      event_id: 'KXMLBGAME-26JUN221810NYYDET', headline_candidates: ['Stable headline'],
      why_this_matters: 'Stable why.',
    });
    const baseModel = { result_edge: 'steady read', projection: 'projected 8 runs', caveat: 'lineups unconfirmed' };
    const a = buildPacketPreviewBlock({ ...common, model: { ...baseModel } });
    const b = buildPacketPreviewBlock({
      ...common,
      model: { ...baseModel, market_context: { display_only: true, line: 'NYY 58c, DET 44c', odds: '-132' }, prices: [58, 44] },
    });
    // Display-only market context may add a trailing line but must not alter the
    // core preview sections (headline/why/storyline/quick-read).
    assert.deepEqual(a.sections, b.sections, 'market context changed model preview sections');
  });
});

test('price-like fields in a banked artifact are stripped before rendering', () => {
  withTempBank((root) => {
    // Simulate a bank file that still carries price residue (older sanitizer).
    const dirty = makeEmptyCpcResearchArtifact({
      generated_at: `${DATE}T13:00:00Z`,
      source_freshness: [{ url: 'https://x', checked_at: `${DATE}T13:00:00Z`, freshness: 'same_day' }],
      packet_family: 'sports', packet_type: 'mlb-game', route: 'mlb_game', submarket: 'game_preview',
      event_id: 'KXMLBGAME-26JUN221810NYYDET',
      model_safe_inputs: { probable_pitchers: { away: 'Gerrit Cole' }, yes_bid: 58, market_snapshot: { odds: '-132' }, implied_probability: 0.58 },
      headline_candidates: ['Headline'],
    });
    writeResearchBankArtifacts({
      date: DATE, packet_family: 'sports', packet_type: 'mlb-game', event_id: 'KXMLBGAME-26JUN221810NYYDET',
      route: 'mlb_game', submarket: 'game_preview',
      raw: dirty, normalized: dirty, sanitized: dirty /* intentionally not sanitized */,
      builderInput: {}, previewText: 'x',
      lineage: { generated_at: `${DATE}T13:00:00Z`, source_freshness: dirty.source_freshness },
      root,
    });
    const banked = readResearchBankArtifact({ date: DATE, packet_family: 'sports', packet_type: 'mlb-game', event_id: 'KXMLBGAME-26JUN221810NYYDET', root });
    assert.ok('yes_bid' in banked.sanitized.model_safe_inputs, 'precondition: bank file carries residue');
    // Adapter must not throw and must not leak any price digits/words.
    const block = buildPacketPreviewBlock({
      date: DATE, packet_family: 'sports', packet_type: 'mlb-game', route: 'mlb_game', submarket: 'game_preview',
      event_id: 'KXMLBGAME-26JUN221810NYYDET', model: { result_edge: 'read' }, root,
    });
    assertCustomerSafe(block.text);
    assert.doesNotMatch(block.text, /yes_bid|market_snapshot|implied_probability|-132|58c/i);
  });
});
