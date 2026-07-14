import test from 'node:test';
import assert from 'node:assert/strict';

import { composeMentionLedger, MENTION_PROFILES, POSTURES } from '../scripts/mentions/mention-composite-core.mjs';
import { PROFILE_KEY as POL_KEY, LAYER_DEFS as POL_LAYERS } from '../scripts/mentions/profiles/political-mentions.mjs';
import { PROFILE_KEY as EARN_KEY, LAYER_DEFS as EARN_LAYERS } from '../scripts/mentions/profiles/earnings-mentions.mjs';
import { PROFILE_KEY as SPORT_KEY, LAYER_DEFS as SPORT_LAYERS } from '../scripts/mentions/profiles/sports-announcer-mentions.mjs';
import { buildPoliticalLayerRecords } from '../scripts/mentions/source-adapters/political-schedule-stub.mjs';
import {
  buildEarningsLayerRecords,
  buildBaselineRelevanceRecord,
  buildSourceVelocityRecord,
  buildSecFilingLanguageRecord,
} from '../scripts/mentions/source-adapters/earnings-calendar-stub.mjs';
import { buildSportsBroadcastLayerRecords } from '../scripts/mentions/source-adapters/sports-broadcast-stub.mjs';

// ─── Profile separation ───────────────────────────────────────────────────────

test('political profile has unique layers not in earnings or sports profiles', () => {
  const polKeys  = new Set(POL_LAYERS.map(d => d.key));
  const earnKeys = new Set(EARN_LAYERS.map(d => d.key));
  const sportKeys = new Set(SPORT_LAYERS.map(d => d.key));

  assert(polKeys.has('news_cycle_pressure'), 'political must have news_cycle_pressure');
  assert(polKeys.has('opponent_topic_relevance'), 'political must have opponent_topic_relevance');
  assert(!earnKeys.has('news_cycle_pressure'), 'earnings must not have news_cycle_pressure');
  assert(!sportKeys.has('opponent_topic_relevance'), 'sports must not have opponent_topic_relevance');
});

test('earnings profile has unique layers not in political or sports profiles', () => {
  const polKeys  = new Set(POL_LAYERS.map(d => d.key));
  const earnKeys = new Set(EARN_LAYERS.map(d => d.key));
  const sportKeys = new Set(SPORT_LAYERS.map(d => d.key));

  assert(earnKeys.has('prepared_remarks_likelihood'), 'earnings must have prepared_remarks_likelihood');
  assert(earnKeys.has('analyst_qa_pathway'), 'earnings must have analyst_qa_pathway');
  assert(earnKeys.has('sec_filing_language'), 'earnings must have sec_filing_language');
  assert(!polKeys.has('prepared_remarks_likelihood'), 'political must not have prepared_remarks_likelihood');
  assert(!sportKeys.has('sec_filing_language'), 'sports must not have sec_filing_language');
});

test('sports announcer profile has unique layers not in political or earnings profiles', () => {
  const polKeys  = new Set(POL_LAYERS.map(d => d.key));
  const earnKeys = new Set(EARN_LAYERS.map(d => d.key));
  const sportKeys = new Set(SPORT_LAYERS.map(d => d.key));

  assert(sportKeys.has('storyline_relevance'), 'sports must have storyline_relevance');
  assert(sportKeys.has('injury_milestone_trigger'), 'sports must have injury_milestone_trigger');
  assert(sportKeys.has('mention_type_likelihood'), 'sports must have mention_type_likelihood');
  assert(!polKeys.has('storyline_relevance'), 'political must not have storyline_relevance');
  assert(!earnKeys.has('mention_type_likelihood'), 'earnings must not have mention_type_likelihood');
});

test('all profiles share the 7 base layers', () => {
  const sharedLayers = [
    'baseline_relevance', 'event_proximity', 'source_velocity',
    'direct_mention_pathway', 'historical_tendency', 'suppression_signal', 'evidence_quality',
  ];
  for (const [key, defs] of [[POL_KEY, POL_LAYERS], [EARN_KEY, EARN_LAYERS], [SPORT_KEY, SPORT_LAYERS]]) {
    const keys = new Set(defs.map(d => d.key));
    for (const layer of sharedLayers) {
      assert(keys.has(layer), `${key} missing shared layer "${layer}"`);
    }
  }
});

test('profile weights each sum to 1.0 (float tolerance 1e-9)', () => {
  for (const [key, defs] of [[POL_KEY, POL_LAYERS], [EARN_KEY, EARN_LAYERS], [SPORT_KEY, SPORT_LAYERS]]) {
    const total = defs.reduce((s, d) => s + d.weight, 0);
    assert(Math.abs(total - 1.0) < 1e-9, `${key} weights sum to ${total}, expected 1.0`);
  }
});

test('earnings historical_tendency weight > political (calls are formulaic)', () => {
  const polW  = POL_LAYERS.find(d => d.key === 'historical_tendency').weight;
  const earnW = EARN_LAYERS.find(d => d.key === 'historical_tendency').weight;
  assert(earnW > polW, `earnings historical_tendency (${earnW}) must exceed political (${polW})`);
});

test('sports has highest event_proximity weight (broadcast window is critical)', () => {
  const polW   = POL_LAYERS.find(d => d.key === 'event_proximity').weight;
  const earnW  = EARN_LAYERS.find(d => d.key === 'event_proximity').weight;
  const sportW = SPORT_LAYERS.find(d => d.key === 'event_proximity').weight;
  assert(sportW >= polW && sportW >= earnW,
    `sports event_proximity (${sportW}) must be >= political (${polW}) and earnings (${earnW})`);
});

// ─── Pricing exclusion ────────────────────────────────────────────────────────

test('throws if a layer record contains yes_bid', () => {
  const badRecords = {
    historical_tendency: { present: true, score: 80, source_basis: 'test', yes_bid: 55 },
  };
  assert.throws(
    () => composeMentionLedger({ event: 'test', targetMention: 'PowerEdge', profile: EARN_KEY, layerDefs: EARN_LAYERS, layerRecords: badRecords }),
    /forbidden pricing field "yes_bid"/i
  );
});

test('throws if a layer record contains yes_ask', () => {
  const badRecords = {
    event_proximity: { present: true, score: 90, source_basis: 'test', yes_ask: 61 },
  };
  assert.throws(
    () => composeMentionLedger({ event: 'test', targetMention: 'Tailwind', profile: EARN_KEY, layerDefs: EARN_LAYERS, layerRecords: badRecords }),
    /forbidden pricing field "yes_ask"/i
  );
});

test('throws if a layer record contains odds', () => {
  const badRecords = {
    event_proximity: { present: true, score: 70, source_basis: 'test', odds: 0.55 },
  };
  assert.throws(
    () => composeMentionLedger({ event: 'test', targetMention: 'tariff', profile: POL_KEY, layerDefs: POL_LAYERS, layerRecords: badRecords }),
    /forbidden pricing field "odds"/i
  );
});

test('price firewall excludes market pricing from the composite result', () => {
  const layerRecords = {
    historical_tendency: { present: true, score: 80, source_basis: 'closed event calendar test' },
  };
  const marketContext = { yes_bid_cents: 55, yes_ask_cents: 61, volume: 11442, open_interest: 200 };

  const result = composeMentionLedger({
    event: 'Dell Earnings Call Q4 FY2026',
    targetMention: 'PowerEdge',
    profile: EARN_KEY,
    layerDefs: EARN_LAYERS,
    layerRecords,
    marketContext,
  });

  assert.equal(result.market_context, undefined);

  // Score is derived from layers only
  assert.equal(result.composite_score, 80);
  assert.equal(result._meta.pricing_excluded, true);

  // No pricing fields must appear in evidence_ledger rows
  for (const row of result.evidence_ledger) {
    for (const f of ['yes_bid_cents', 'yes_ask_cents', 'volume', 'open_interest']) {
      assert(!(f in row), `evidence_ledger row "${row.category}" must not contain "${f}"`);
    }
  }
});

test('event_proximity changes do not move the composite score or posture', () => {
  const baseLayers = {
    direct_mention_pathway: { present: true, score: 88, source_basis: 'direct research anchor' },
    historical_tendency: { present: true, score: 72, source_basis: 'historical research anchor' },
  };
  const lowProximity = composeMentionLedger({
    event: 'Axios interview', targetMention: 'Biden',
    profile: POL_KEY, layerDefs: POL_LAYERS,
    layerRecords: {
      ...baseLayers,
      event_proximity: { present: true, score: 5, source_basis: 'schedule is distant' },
    },
  });
  const highProximity = composeMentionLedger({
    event: 'Axios interview', targetMention: 'Biden',
    profile: POL_KEY, layerDefs: POL_LAYERS,
    layerRecords: {
      ...baseLayers,
      event_proximity: { present: true, score: 99, source_basis: 'schedule is imminent' },
    },
  });

  assert.equal(lowProximity.composite_score, highProximity.composite_score);
  assert.equal(lowProximity.posture, highProximity.posture);
  assert.equal(lowProximity.composite_score, 80);
});

// ─── Missing layers / no fabrication ─────────────────────────────────────────

test('all-missing layers → composite_score null and NO_CLEAR_PICK', () => {
  const result = composeMentionLedger({
    event: 'Senate Hearing', targetMention: 'tariff',
    profile: POL_KEY, layerDefs: POL_LAYERS, layerRecords: {},
  });

  assert.equal(result.composite_score, null);
  assert.equal(result.posture, 'NO_CLEAR_PICK');
  assert.equal(result._meta.layers_present, 0);
  assert.equal(result.missing_layers.length, POL_LAYERS.length);

  for (const ml of result.missing_layers) {
    assert(ml.missing_note, `missing layer "${ml.category}" must have a missing_note (not fabricated)`);
  }
  for (const row of result.evidence_ledger) {
    if (!row.present) {
      assert.equal(row.value, null, `missing layer "${row.category}" must have null value`);
      assert.equal(row.contribution, null, `missing layer "${row.category}" must have null contribution`);
    }
  }
});

test('1 layer present → max posture is LEAN', () => {
  const result = composeMentionLedger({
    event: 'Dell Earnings Call', targetMention: 'Tailwind',
    profile: EARN_KEY, layerDefs: EARN_LAYERS,
    layerRecords: {
      historical_tendency: { present: true, score: 95, source_basis: 'closed events: 5/6 YES' },
    },
  });

  assert.equal(result._meta.layers_present, 1);
  assert.notEqual(result.posture, 'PICK', '1 layer must not yield PICK');
  assert.notEqual(result.posture, 'EVIDENCE_LEAN', '1 layer must not yield EVIDENCE_LEAN');
  assert(['LEAN', 'WATCH'].includes(result.posture),
    `posture "${result.posture}" must be LEAN or WATCH with 1 layer`);
});

test('2 layers present → max posture is EVIDENCE_LEAN', () => {
  const result = composeMentionLedger({
    event: 'Dell Earnings Call', targetMention: 'PowerEdge',
    profile: EARN_KEY, layerDefs: EARN_LAYERS,
    layerRecords: {
      historical_tendency: { present: true, score: 90, source_basis: 'closed events: 5/6 YES' },
      event_proximity:     { present: true, score: 95, source_basis: 'call today 3:30pm CDT' },
    },
  });

  assert.equal(result._meta.layers_present, 2);
  assert.notEqual(result.posture, 'PICK', '2 layers must not yield PICK');
});

test('4 layers with high scores → PICK or EVIDENCE_LEAN posture', () => {
  const result = composeMentionLedger({
    event: 'Dell Earnings Call Q4 FY2026', targetMention: 'PowerEdge',
    profile: EARN_KEY, layerDefs: EARN_LAYERS,
    layerRecords: {
      historical_tendency:         { present: true, score: 92, source_basis: 'closed events: 5/6 YES' },
      event_proximity:             { present: true, score: 97, source_basis: 'call today 3:30pm CDT (confirmed)' },
      prepared_remarks_likelihood: { present: true, score: 88, source_basis: 'PowerEdge in every prior call script' },
      sec_filing_language:         { present: true, score: 80, source_basis: '10-K FY2025: PowerEdge mentioned 47 times' },
    },
  });

  assert.equal(result._meta.layers_present, 4);
  assert(['PICK', 'EVIDENCE_LEAN'].includes(result.posture),
    `posture "${result.posture}" must be PICK or EVIDENCE_LEAN with 4 strong layers`);
});

// ─── Evidence ledger and provenance ──────────────────────────────────────────

test('evidence_ledger has one row per layer_def with required fields', () => {
  const result = composeMentionLedger({
    event: 'Yankees at Red Sox — ESPN SNB', targetMention: 'Aaron Judge',
    profile: SPORT_KEY, layerDefs: SPORT_LAYERS,
    layerRecords: {
      event_proximity:     { present: true, score: 85, source_basis: 'confirmed game 7:08pm ET, ESPN SNB' },
      storyline_relevance: { present: true, score: 80, source_basis: 'Judge HR record chase active' },
    },
  });

  assert.equal(result.evidence_ledger.length, SPORT_LAYERS.length);

  const required = ['category', 'label', 'raw_weight', 'normalized_weight', 'contribution',
    'source_basis', 'source_path', 'value', 'grade', 'detail', 'present', 'missing_note'];
  for (const row of result.evidence_ledger) {
    for (const f of required) {
      assert(f in row, `ledger row "${row.category}" missing field "${f}"`);
    }
  }

  // Present rows have non-null normalized_weight and contribution
  const presentRows = result.evidence_ledger.filter(r => r.present);
  assert(presentRows.length > 0);
  for (const row of presentRows) {
    assert(row.normalized_weight !== null, `present row "${row.category}" must have normalized_weight`);
    assert(row.contribution !== null, `present row "${row.category}" must have contribution`);
  }

  // Normalized weights of present rows sum to ~1.0
  const normSum = presentRows.reduce((s, r) => s + r.normalized_weight, 0);
  assert(Math.abs(normSum - 1.0) < 0.01, `normalized_weight sum ${normSum} should be ~1.0`);
});

test('source_notes includes provenance strings for all present layers', () => {
  const result = composeMentionLedger({
    event: 'Senate Finance Hearing', targetMention: 'tariff',
    profile: POL_KEY, layerDefs: POL_LAYERS,
    layerRecords: {
      historical_tendency: { present: true, score: 75, source_basis: 'closed-event calendar: 4/6 YES' },
      event_proximity:     { present: true, score: 88, source_basis: 'confirmed Senate hearing 10am ET' },
    },
  });

  assert(result.source_notes.length >= 2);
  assert(result.source_notes.some(n => n.includes('[historical_tendency]')));
  assert(result.source_notes.some(n => n.includes('[event_proximity]')));
});

test('missing_layers list populated with category + missing_note; no fabricated values', () => {
  const result = composeMentionLedger({
    event: 'Dell Earnings Call', targetMention: 'Headwind',
    profile: EARN_KEY, layerDefs: EARN_LAYERS,
    layerRecords: {
      event_proximity: { present: true, score: 95, source_basis: 'call confirmed today 3:30pm CDT' },
    },
  });

  const missingKeys = result.missing_layers.map(m => m.category);
  assert(!missingKeys.includes('event_proximity'), 'event_proximity must not be in missing_layers');
  assert.equal(missingKeys.length, EARN_LAYERS.length - 1);

  for (const m of result.missing_layers) {
    assert(m.category);
    assert(m.missing_note, `missing_layer "${m.category}" must have missing_note`);
  }
});

test('_meta fields are present and correct', () => {
  const result = composeMentionLedger({
    event: 'test', targetMention: 'test', profile: SPORT_KEY,
    layerDefs: SPORT_LAYERS, layerRecords: {},
  });

  assert.equal(result._meta.schema_version, 'mention_composite_v1');
  assert.equal(result._meta.pricing_excluded, true);
  assert.equal(typeof result._meta.layers_present, 'number');
  assert.equal(typeof result._meta.layers_total, 'number');
});

// ─── Sample runs ─────────────────────────────────────────────────────────────

test('Dell earnings: PowerEdge with 4 strong layers → PICK or EVIDENCE_LEAN', () => {
  const result = composeMentionLedger({
    event: 'Dell Earnings Call Q4 FY2026',
    targetMention: 'PowerEdge',
    profile: EARN_KEY,
    layerDefs: EARN_LAYERS,
    layerRecords: {
      event_proximity: {
        present: true, score: 95,
        source_basis: 'Dell earnings call confirmed today 3:30pm CDT (Q4 FY2026)',
        detail: 'call starts in ~45 minutes',
      },
      historical_tendency: {
        present: true, score: 83,
        source_basis: 'closed-event calendar: 5/6 prior Dell earnings events resolved YES for PowerEdge',
        detail: 'hit rate 83% (5 of 6)',
      },
      prepared_remarks_likelihood: {
        present: true, score: 88,
        source_basis: 'PowerEdge is Dells primary server brand; appears in opening remarks on every prior transcript',
      },
      sec_filing_language: {
        present: true, score: 80,
        source_basis: '10-K FY2025: "PowerEdge" appears 47 times across risk factors and segment discussion',
        source_path: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=DELL',
      },
    },
    marketContext: { yes_bid_cents: 57, yes_ask_cents: 61, volume: 11442, open_interest: 300 },
  });

  assert.equal(result.event, 'Dell Earnings Call Q4 FY2026');
  assert.equal(result.target_mention, 'PowerEdge');
  assert.equal(result.profile, 'earnings_mentions');
  assert(['PICK', 'EVIDENCE_LEAN'].includes(result.posture),
    `expected PICK or EVIDENCE_LEAN, got "${result.posture}"`);
  assert(result.composite_score > 80, `composite_score ${result.composite_score} should be > 80`);
  assert(result.top_supporting_layers.length > 0);
  assert(result.missing_layers.length > 0);
  assert.equal(result.market_context, undefined);
  assert.equal(result._meta.pricing_excluded, true);
});

test('Dell earnings: Headwind (33% hit rate) → WATCH or lower', () => {
  const result = composeMentionLedger({
    event: 'Dell Earnings Call Q4 FY2026', targetMention: 'Headwind',
    profile: EARN_KEY, layerDefs: EARN_LAYERS,
    layerRecords: {
      event_proximity:     { present: true, score: 95, source_basis: 'Dell call confirmed today 3:30pm CDT' },
      historical_tendency: { present: true, score: 33, source_basis: 'closed-event calendar: 2/6 resolved YES', detail: 'hit rate 33%' },
    },
    marketContext: { yes_bid_cents: 37, yes_ask_cents: 41 },
  });

  assert(['WATCH', 'NO_CLEAR_PICK', 'LEAN'].includes(result.posture),
    `expected WATCH or lower for 33% hit-rate keyword, got "${result.posture}"`);
});

// ─── Source adapter stub integration ─────────────────────────────────────────

test('political adapter: confirmed hearing + 5/6 hit rate → event_proximity + historical_tendency present', () => {
  const tomorrow = new Date(Date.now() + 4 * 3_600_000).toISOString();
  const records = buildPoliticalLayerRecords({
    speaker: 'Bernie Sanders',
    keyword: 'Medicare',
    schedule: { event_type: 'Senate hearing', event_date_utc: tomorrow, confirmed: true },
    closedEventHitRate: { hits: 5, total: 6 },
  });

  const result = composeMentionLedger({
    event: 'Senate Hearing', targetMention: 'Medicare',
    profile: POL_KEY, layerDefs: POL_LAYERS, layerRecords: records,
  });

  const present = result.evidence_ledger.filter(r => r.present).map(r => r.category);
  assert(present.includes('event_proximity'), 'event_proximity must be present');
  assert(present.includes('historical_tendency'), 'historical_tendency must be present');
  assert(result._meta.layers_present >= 2);
});

test('earnings adapter: Dell call in 45min + 5/6 hit rate + SEC match + analyst coverage → 4 present layers', () => {
  const soonUTC = new Date(Date.now() + 45 * 60_000).toISOString();
  const records = buildEarningsLayerRecords({
    company: 'Dell Technologies',
    keyword: 'PowerEdge',
    earningsEvent: { call_date_utc: soonUTC, confirmed: true, fiscal_quarter: 'Q4 FY2026' },
    closedEventHitRate: { hits: 5, total: 6 },
    secFilingMatch: { found: true, filing_type: '10-K FY2025', snippet: '"PowerEdge" in risk factors' },
    analystCoverage: { mentions_in_coverage: true, detail: 'analysts ask about PowerEdge every quarter' },
  });

  const result = composeMentionLedger({
    event: 'Dell Earnings Call Q4 FY2026', targetMention: 'PowerEdge',
    profile: EARN_KEY, layerDefs: EARN_LAYERS, layerRecords: records,
    marketContext: { yes_bid_cents: 57, yes_ask_cents: 61, volume: 11442 },
  });

  assert(result._meta.layers_present >= 4, `expected >= 4 present layers, got ${result._meta.layers_present}`);
  assert(result.composite_score !== null);
  assert.equal(result._meta.pricing_excluded, true);

  const presentKeys = result.evidence_ledger.filter(r => r.present).map(r => r.category);
  assert(presentKeys.includes('event_proximity'));
  assert(presentKeys.includes('historical_tendency'));
  assert(presentKeys.includes('sec_filing_language'));
  assert(presentKeys.includes('analyst_qa_pathway'));
});

test('sports adapter: live broadcast today + rivalry storyline → 5 present layers', () => {
  const gameUTC = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const records = buildSportsBroadcastLayerRecords({
    announcer: 'ESPN Sunday Night Baseball',
    keyword: 'Aaron Judge',
    broadcastEvent: { game_date_utc: gameUTC, network: 'ESPN', show_type: 'live', confirmed: true },
    closedEventHitRate: { hits: 4, total: 6 },
    storylineContext: { active: true, type: 'milestone', detail: 'Judge chasing HR record in this series' },
    breakingTrigger: { present: false },
  });

  const result = composeMentionLedger({
    event: 'Yankees at Red Sox — ESPN Sunday Night Baseball',
    targetMention: 'Aaron Judge',
    profile: SPORT_KEY, layerDefs: SPORT_LAYERS, layerRecords: records,
  });

  assert(result._meta.layers_present >= 4, `expected >= 4 present layers, got ${result._meta.layers_present}`);
  assert(['PICK', 'EVIDENCE_LEAN', 'LEAN'].includes(result.posture),
    `posture "${result.posture}" should reflect multiple layers of support`);

  const presentKeys = result.evidence_ledger.filter(r => r.present).map(r => r.category);
  assert(presentKeys.includes('event_proximity'));
  assert(presentKeys.includes('historical_tendency'));
  assert(presentKeys.includes('storyline_relevance'));
  assert(presentKeys.includes('injury_milestone_trigger'));
  assert(presentKeys.includes('mention_type_likelihood'));
});

// ─── Re-normalization ─────────────────────────────────────────────────────────

test('3 of 10 layers present → normalized weights of present layers sum to ~1.0', () => {
  const result = composeMentionLedger({
    event: 'test', targetMention: 'Tailwind', profile: EARN_KEY, layerDefs: EARN_LAYERS,
    layerRecords: {
      historical_tendency: { present: true, score: 80, source_basis: '4/6 closed events YES' },
      event_proximity:     { present: true, score: 90, source_basis: 'call today' },
      sec_filing_language: { present: true, score: 65, source_basis: '10-K match' },
    },
  });

  const presentRows = result.evidence_ledger.filter(r => r.present);
  assert.equal(presentRows.length, 3);
  const normSum = presentRows.reduce((s, r) => s + r.normalized_weight, 0);
  assert(Math.abs(normSum - 1.0) < 0.01,
    `normalized_weight sum ${normSum} should equal ~1.0 after re-normalization`);
});

test('invalid profile name throws with descriptive message', () => {
  assert.throws(
    () => composeMentionLedger({ event: 'test', targetMention: 'test', profile: 'invalid_profile', layerDefs: EARN_LAYERS, layerRecords: {} }),
    /unknown mention profile/i
  );
});

// ─── New layer builders ───────────────────────────────────────────────────────

test('buildBaselineRelevanceRecord: populates from transcript hit rate + core flag', () => {
  const rec = buildBaselineRelevanceRecord({
    company: 'Dell Technologies', keyword: 'PowerEdge',
    transcriptHitRate: 0.83, transcriptAvgHitsPerCall: 5.0,
    isCoreProductOrMetric: true, analystTopicScore: 80, inEarningsRelease: true,
  });
  assert.equal(rec.present, true);
  assert(rec.score >= 70, `expected score >= 70, got ${rec.score}`);
  assert(rec.source_basis.includes('transcript_hit_rate'), 'source_basis must reference transcript_hit_rate');
  assert(rec.source_basis.includes('core_product'), 'source_basis must reference core_product flag');
  assert(!rec.missing_note, 'should have no missing_note when data is present');
});

test('buildBaselineRelevanceRecord: returns present=false when no data supplied', () => {
  const rec = buildBaselineRelevanceRecord({ company: 'Dell', keyword: 'test' });
  assert.equal(rec.present, false);
  assert.equal(rec.score, null);
  assert(rec.missing_note, 'must have missing_note explaining what to supply');
});

test('buildBaselineRelevanceRecord: high-frequency generic words are capped by normalizedCount', () => {
  // avgHitsPerCall=100 should not dominate — capped at 15 hits = 100 score
  const highFreq = buildBaselineRelevanceRecord({
    company: 'Dell', keyword: 'the', transcriptHitRate: 1.0, transcriptAvgHitsPerCall: 100,
    isCoreProductOrMetric: false, analystTopicScore: 50,
  });
  // normalized count component capped: 100/15 = 100 → score still bounded at 100
  assert(highFreq.score <= 100, 'score must not exceed 100 even for very high frequency');
  assert(highFreq.present, 'should be present with valid inputs');
});

test('buildSourceVelocityRecord: scores from multiple independent source types', () => {
  const rec = buildSourceVelocityRecord({
    company: 'Dell Technologies', keyword: 'EPS Growth',
    sources: [
      { type: 'news',       mentionsKeyword: true,  recencyDays: 0 },
      { type: 'analyst',    mentionsKeyword: true,  recencyDays: 3 },
      { type: 'company',    mentionsKeyword: true,  recencyDays: 0 },
      { type: 'transcript', mentionsKeyword: true,  recencyDays: 1 },
    ],
  });
  assert.equal(rec.present, true);
  assert(rec.score >= 60, `expected score >= 60 for 4-type coverage, got ${rec.score}`);
  assert(rec.source_basis.includes('4 independent source type'), 'source_basis must count source types');
});

test('buildSourceVelocityRecord: deduplicates same source type — takes most recent', () => {
  const rec = buildSourceVelocityRecord({
    company: 'Dell', keyword: 'test',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 1 },
      { type: 'news', mentionsKeyword: true, recencyDays: 5 },  // same type — should be deduped
      { type: 'news', mentionsKeyword: true, recencyDays: 10 },
    ],
  });
  // Only 1 distinct type → lower score than 3 types
  assert.equal(rec.present, true);
  assert(rec.score < 40, `single source type should score low, got ${rec.score}`);
  assert(rec.source_basis.includes('1 independent source type'));
});

test('buildSourceVelocityRecord: zero-mention sources → present=true score=10', () => {
  const rec = buildSourceVelocityRecord({
    company: 'Dell', keyword: 'Mistral',
    sources: [
      { type: 'news',    mentionsKeyword: false, recencyDays: 5 },
      { type: 'analyst', mentionsKeyword: false, recencyDays: 3 },
    ],
  });
  assert.equal(rec.present, true);
  assert.equal(rec.score, 10);
  assert(/none mention/i.test(rec.source_basis), `must note no mentions; got: "${rec.source_basis}"`);
});

test('buildSourceVelocityRecord: no sources → present=false', () => {
  const rec = buildSourceVelocityRecord({ company: 'Dell', keyword: 'test', sources: [] });
  assert.equal(rec.present, false);
  assert.equal(rec.score, null);
  assert(rec.missing_note, 'must have missing_note');
});

test('buildSecFilingLanguageRecord: scores from press release + 10-K counts', () => {
  const rec = buildSecFilingLanguageRecord({
    company: 'Dell Technologies', keyword: 'dividend',
    pressReleaseMentions: 5, tenKMentions: 41, tenQMentions: 8,
    inRiskFactors: true, filingType: '10-K FY26 + Q1 FY27 8-K',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000021/exhibit991earnings8kq1fy27.htm',
  });
  assert.equal(rec.present, true);
  assert(rec.score >= 85, `dividend with 5x PR + 41x 10-K + risk factor should score >= 85, got ${rec.score}`);
  assert(rec.source_basis.includes('press_release=5x'), 'source_basis must cite press release count');
  assert(rec.source_basis.includes('10-K=41x'), 'source_basis must cite 10-K count');
  assert(rec.source_basis.includes('risk_factor=YES'), 'source_basis must cite risk factor presence');
  assert(rec.source_path.includes('sec.gov'), 'source_path must be SEC EDGAR URL');
});

test('buildSecFilingLanguageRecord: absent keyword scores 15 (not null)', () => {
  const rec = buildSecFilingLanguageRecord({
    company: 'Dell', keyword: 'tailwind',
    pressReleaseMentions: 0, tenKMentions: 0, tenQMentions: 0,
    inRiskFactors: false, filingType: '10-K FY26',
  });
  assert.equal(rec.present, true, 'absent keywords still produce a present record (confirmed absence is evidence)');
  assert.equal(rec.score, 15, `all-zero counts should score 15, got ${rec.score}`);
  assert(!rec.missing_note, 'should have no missing_note when filing was checked');
});

test('buildSecFilingLanguageRecord: risk factor bonus adds +8 to base score', () => {
  const withoutRisk = buildSecFilingLanguageRecord({
    company: 'Dell', keyword: 'test',
    pressReleaseMentions: 1, tenKMentions: 0, inRiskFactors: false,
  });
  const withRisk = buildSecFilingLanguageRecord({
    company: 'Dell', keyword: 'test',
    pressReleaseMentions: 1, tenKMentions: 0, inRiskFactors: true,
  });
  assert(withRisk.score === withoutRisk.score + 8 || withRisk.score === 100,
    `risk factor should add 8 points: ${withoutRisk.score} → ${withRisk.score}`);
});

test('buildSecFilingLanguageRecord: no data → present=false', () => {
  const rec = buildSecFilingLanguageRecord({ company: 'Dell', keyword: 'test' });
  assert.equal(rec.present, false);
  assert.equal(rec.score, null);
  assert(rec.missing_note, 'must have missing_note when no filing data supplied');
});

test('earnings adapter: all 3 new layers populate via baselineRelevance + sourceVelocity + secFilingMatch', () => {
  const soonUTC = new Date(Date.now() + 30 * 60_000).toISOString();
  const records = buildEarningsLayerRecords({
    company: 'Dell Technologies',
    keyword: 'dividend',
    earningsEvent: { call_date_utc: soonUTC, confirmed: true, fiscal_quarter: 'Q1 FY2027' },
    closedEventHitRate: { hits: 4, total: 6 },
    secFilingMatch: {
      pressReleaseMentions: 5, tenKMentions: 41, tenQMentions: 8,
      inRiskFactors: true, filingType: '10-K FY26 + Q1 FY27 8-K',
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000021/exhibit991earnings8kq1fy27.htm',
    },
    baselineRelevance: {
      transcriptHitRate: 0.67, transcriptAvgHitsPerCall: 3.0,
      isCoreProductOrMetric: true, analystTopicScore: 55, inEarningsRelease: true,
    },
    sourceVelocity: {
      sources: [
        { type: 'company', mentionsKeyword: true, recencyDays: 0 },
        { type: 'news',    mentionsKeyword: true, recencyDays: 0 },
      ],
    },
  });

  assert.equal(records.baseline_relevance.present, true, 'baseline_relevance must be present');
  assert.equal(records.source_velocity.present, true, 'source_velocity must be present');
  assert.equal(records.sec_filing_language.present, true, 'sec_filing_language must be present');

  assert(records.baseline_relevance.score >= 60, `baseline_relevance score ${records.baseline_relevance.score} should be >= 60`);
  assert(records.source_velocity.score >= 30, `source_velocity score ${records.source_velocity.score} should be >= 30`);
  assert(records.sec_filing_language.score >= 85, `sec_filing_language score ${records.sec_filing_language.score} should be >= 85`);
});

test('Dell full 10/10 layers via composeMentionLedger with all three new layers wired', () => {
  const soonUTC = new Date(Date.now() + 10 * 60_000).toISOString();
  // Adapter wires 6 layers: baseline_relevance, event_proximity, historical_tendency,
  // sec_filing_language, analyst_qa_pathway, source_velocity.
  // Supply the remaining 4 inline to achieve 10/10.
  const adapterRecords = buildEarningsLayerRecords({
    company: 'Dell Technologies', keyword: 'EPS Growth',
    earningsEvent: { call_date_utc: soonUTC, confirmed: true, fiscal_quarter: 'Q1 FY2027' },
    closedEventHitRate: { hits: 6, total: 6 },
    secFilingMatch: {
      pressReleaseMentions: 27, tenKMentions: 20, tenQMentions: 8,
      inRiskFactors: false, filingType: '10-K FY26 + Q1 FY27 8-K',
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000021/exhibit991earnings8kq1fy27.htm',
    },
    baselineRelevance: {
      transcriptHitRate: 1.0, transcriptAvgHitsPerCall: 7.0,
      isCoreProductOrMetric: true, analystTopicScore: 92, inEarningsRelease: true,
    },
    sourceVelocity: {
      sources: [
        { type: 'news',       mentionsKeyword: true, recencyDays: 3 },
        { type: 'analyst',    mentionsKeyword: true, recencyDays: 5 },
        { type: 'company',    mentionsKeyword: true, recencyDays: 0 },
        { type: 'transcript', mentionsKeyword: true, recencyDays: 1 },
      ],
    },
    analystCoverage: { mentions_in_coverage: true, detail: 'EPS beat and guidance raise are top Q&A topics' },
  });

  // Supply the 4 remaining stub layers inline
  const records = {
    ...adapterRecords,
    direct_mention_pathway:      { present: true, score: 99, source_basis: 'Core Dell financial metric — stated verbatim every call' },
    prepared_remarks_likelihood: { present: true, score: 99, source_basis: 'Record EPS $4.86 leads every prepared remarks section' },
    suppression_signal:          { present: true, score: 98, source_basis: 'Record EPS — zero incentive to suppress' },
    evidence_quality:            { present: true, score: 92, source_basis: 'Kalshi event confirmed; EDGAR filing accessible; IR calendar confirmed' },
  };

  const result = composeMentionLedger({
    event: 'Dell Technologies Q1 FY27 Earnings Call',
    targetMention: 'EPS Growth',
    profile: EARN_KEY, layerDefs: EARN_LAYERS, layerRecords: records,
    marketContext: { yes_bid_cents: 83, yes_ask_cents: 85 },
  });

  // Verify the three previously-missing adapter layers are now present
  const ledgerMap = Object.fromEntries(result.evidence_ledger.map(r => [r.category, r]));
  assert(ledgerMap.baseline_relevance.present, 'baseline_relevance must now be present');
  assert(ledgerMap.source_velocity.present, 'source_velocity must now be present');
  assert(ledgerMap.sec_filing_language.present, 'sec_filing_language must now be present');

  // All 10 layers must be present
  assert.equal(result._meta.layers_present, 10, `expected 10 layers, got ${result._meta.layers_present}`);
  assert.equal(result._meta.layers_total, 10);
  assert.equal(result.missing_layers.length, 0, 'no layers should be missing');

  // Normalized weights of all present layers sum to ~1.0
  const normSum = result.evidence_ledger.reduce((s, r) => s + (r.normalized_weight ?? 0), 0);
  assert(Math.abs(normSum - 1.0) < 0.01, `normalized_weight sum ${normSum} must be ~1.0`);

  // All three new layers have provenance in source_notes
  assert(result.source_notes.some(n => n.includes('[baseline_relevance]')), 'source_notes must include baseline_relevance');
  assert(result.source_notes.some(n => n.includes('[source_velocity]')), 'source_notes must include source_velocity');
  assert(result.source_notes.some(n => n.includes('[sec_filing_language]')), 'source_notes must include sec_filing_language');

  // Pricing excluded
  assert.equal(result._meta.pricing_excluded, true);
  assert.equal(result.market_context, undefined);

  // Strong score given 10 layers of evidence
  assert(['PICK', 'EVIDENCE_LEAN'].includes(result.posture),
    `expected PICK or EVIDENCE_LEAN for 10-layer EPS Growth, got "${result.posture}"`);
});
