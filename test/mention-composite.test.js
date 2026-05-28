import test from 'node:test';
import assert from 'node:assert/strict';

import { composeMentionLedger, MENTION_PROFILES, POSTURES } from '../scripts/mentions/mention-composite-core.mjs';
import { PROFILE_KEY as POL_KEY, LAYER_DEFS as POL_LAYERS } from '../scripts/mentions/profiles/political-mentions.mjs';
import { PROFILE_KEY as EARN_KEY, LAYER_DEFS as EARN_LAYERS } from '../scripts/mentions/profiles/earnings-mentions.mjs';
import { PROFILE_KEY as SPORT_KEY, LAYER_DEFS as SPORT_LAYERS } from '../scripts/mentions/profiles/sports-announcer-mentions.mjs';
import { buildPoliticalLayerRecords } from '../scripts/mentions/source-adapters/political-schedule-stub.mjs';
import { buildEarningsLayerRecords } from '../scripts/mentions/source-adapters/earnings-calendar-stub.mjs';
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

test('market_context pricing is stored separately and never enters score', () => {
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

  assert.equal(result.market_context.yes_bid_cents, 55);
  assert.equal(result.market_context.yes_ask_cents, 61);
  assert.equal(result.market_context.volume, 11442);
  assert.match(result.market_context._note, /never scoring/i);

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
  assert.equal(result.market_context.yes_bid_cents, 57);
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
