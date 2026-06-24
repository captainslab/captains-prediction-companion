import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CPC_RESEARCH_ARTIFACT_SCHEMA,
  validateCpcResearchArtifact,
  assertCpcResearchArtifact,
  makeEmptyCpcResearchArtifact,
} from '../scripts/shared/cpc-research-artifact-schema.mjs';
import {
  FORBIDDEN_MARKET_TERMS,
  CPC_RESEARCH_PROMPT_BUILDERS,
} from '../scripts/shared/perplexity-preview-prompts.mjs';
import {
  BANNED_MODEL_INPUT_KEYS,
  SANITIZER_VERSION,
  sanitizeResearchArtifact,
  assertNoMarketLeak,
} from '../scripts/shared/preview-artifact-sanitizer.mjs';
import {
  BANNED_CUSTOMER_PREVIEW_WORDS,
  scrubCustomerText,
} from '../scripts/shared/sports-preview-builder.mjs';
import {
  writeResearchBankArtifacts,
  researchBankDir,
  RESEARCH_BANK_FILES,
} from '../scripts/shared/cpc-research-bank.mjs';

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXPECTED_BUILDERS = [
  'mlb-game',
  'mlb-slate',
  'worldcup-match',
  'worldcup-matchday',
  'mentions-daily',
  'mention-event',
  'earnings-call-mention',
  'hearing-testimony-mention',
  'hearing-word-bank-mention',
  'public-figure-mention',
  'sports-mention',
  'tv-show-mention',
  'topic-most-mentioned',
];

const MENTIONS_PACKET_TYPES = new Set([
  'mentions-daily',
  'mention-event',
  'earnings-call-mention',
  'hearing-testimony-mention',
  'hearing-word-bank-mention',
  'public-figure-mention',
  'sports-mention',
  'tv-show-mention',
  'topic-most-mentioned',
]);

test('all 13 CPC research builders exist with valid contract shape', () => {
  assert.equal(Object.keys(CPC_RESEARCH_PROMPT_BUILDERS).length, 13);
  for (const packetType of EXPECTED_BUILDERS) {
    const builder = CPC_RESEARCH_PROMPT_BUILDERS[packetType];
    assert.equal(typeof builder, 'function', `${packetType} builder missing`);
    const prompt = builder({ event_id: 'EVT', market_id: 'MKT', event_url: 'https://example.com', date_central: '2026-06-22' });
    assert.equal(prompt.schema, CPC_RESEARCH_ARTIFACT_SCHEMA);
    assert.equal(prompt.packet_type, packetType);
    assert.ok(prompt.system.trim().length > 0, `${packetType} empty system`);
    assert.ok(prompt.user.trim().length > 0, `${packetType} empty user`);
    assert.ok(prompt.output_schema && typeof prompt.output_schema === 'object');
    assert.ok(['sports', 'mentions'].includes(prompt.packet_family));
    assert.ok(prompt.route && prompt.submarket);
    for (const term of FORBIDDEN_MARKET_TERMS) {
      assert.ok(prompt.forbidden_market_terms.includes(term));
    }
  }
});

test('every builder user prompt forbids all market terms and requires the split', () => {
  for (const packetType of EXPECTED_BUILDERS) {
    const prompt = CPC_RESEARCH_PROMPT_BUILDERS[packetType]();
    for (const term of FORBIDDEN_MARKET_TERMS) {
      assert.match(prompt.user, new RegExp(escapeRegExp(term), 'i'), `${packetType} missing forbidden term ${term}`);
    }
    assert.match(prompt.user, /one JSON object/i, `${packetType} missing one-JSON-object rule`);
    assert.match(prompt.user, /model_safe_inputs/, `${packetType} missing model_safe_inputs`);
    assert.match(prompt.user, /editorial_context/, `${packetType} missing editorial_context`);
  }
});

test('mentions builders consume resolved route/submarket and never reclassify', () => {
  for (const packetType of EXPECTED_BUILDERS) {
    if (!MENTIONS_PACKET_TYPES.has(packetType)) continue;
    const prompt = CPC_RESEARCH_PROMPT_BUILDERS[packetType]({ route: 'forced_route', submarket: 'forced_submarket' });
    assert.equal(prompt.route, 'forced_route', `${packetType} did not consume resolved route`);
    assert.equal(prompt.submarket, 'forced_submarket', `${packetType} did not consume resolved submarket`);
    assert.match(prompt.user, /route: forced_route/);
    assert.match(prompt.user, /submarket: forced_submarket/);
    assert.match(prompt.user, /do not reclassify/i, `${packetType} missing do-not-reclassify rule`);
  }
});

test('schema validation passes for representative artifacts and fails on defects', () => {
  for (const packetType of EXPECTED_BUILDERS) {
    const prompt = CPC_RESEARCH_PROMPT_BUILDERS[packetType]();
    const artifact = makeEmptyCpcResearchArtifact({
      packet_family: prompt.packet_family,
      packet_type: prompt.packet_type,
      route: prompt.route,
      submarket: prompt.submarket,
      event_id: 'EVT',
      event_url: 'https://example.com',
      source_freshness: [{ url: 'https://example.com', published_at: 'unavailable', checked_at: '2026-06-22T13:00:00Z', freshness: 'same_day' }],
    });
    assert.doesNotThrow(() => assertCpcResearchArtifact(artifact, packetType));
  }

  const base = makeEmptyCpcResearchArtifact({ packet_family: 'sports', packet_type: 'mlb-game' });

  const missing = { ...base };
  delete missing.why_this_matters;
  assert.equal(validateCpcResearchArtifact(missing).valid, false);

  const badFamily = { ...base, packet_family: 'crypto' };
  assert.equal(validateCpcResearchArtifact(badFamily).valid, false);

  const badFreshness = { ...base, source_freshness: [{ url: 'https://x', checked_at: 'now', freshness: 'eventually' }] };
  assert.equal(validateCpcResearchArtifact(badFreshness).valid, false);

  const badSource = { ...base, source_id: 'kalshi' };
  assert.equal(validateCpcResearchArtifact(badSource).valid, false);
});

test('extended sanitizer strips price-like keys, market_snapshot container, and settled-history residue', () => {
  for (const key of ['implied_probability', 'market_price', 'no_bid', 'no_ask', 'order_book', 'sportsbook_lines']) {
    assert.ok(BANNED_MODEL_INPUT_KEYS.includes(key), `superset missing ${key}`);
  }

  const artifact = makeEmptyCpcResearchArtifact({
    packet_family: 'mentions',
    packet_type: 'hearing-word-bank-mention',
    event_id: 'EVT',
    model_safe_inputs: {
      hearing_title: 'keep me',
      price: 1,
      odds: '-110',
      bid: 1,
      ask: 2,
      volume: 3,
      open_interest: 4,
      liquidity: 5,
      orderbook: { spread_price: 6 },
      ladder: ['a'],
      implied_probability: 0.5,
      market_snapshot: { bid_ask: '50/50', odds: '-110' },
      settled_history: {
        prior_event: 'kept context',
        last_price: 42,
        yes_bid: 41,
      },
    },
    market_context: { display_only: false, line: 'remove me' },
  });

  const sanitized = sanitizeResearchArtifact(artifact);
  for (const key of ['price', 'odds', 'bid', 'ask', 'volume', 'open_interest', 'liquidity', 'orderbook', 'ladder', 'implied_probability', 'market_snapshot', 'last_price', 'yes_bid']) {
    assert.ok(sanitized.sanitized_removed.includes(key), `expected ${key} removed`);
    assert.ok(sanitized.unavailable_fields.includes(key), `expected ${key} in unavailable_fields`);
  }
  assert.ok(!('market_snapshot' in sanitized.model_safe_inputs), 'market_snapshot container must be gone');
  assert.equal(sanitized.model_safe_inputs.hearing_title, 'keep me', 'unrelated fields must survive');
  assert.equal(sanitized.model_safe_inputs.settled_history.prior_event, 'kept context', 'price-free settled-history survives');
  assert.ok(!('last_price' in sanitized.model_safe_inputs.settled_history), 'settled-history price-like stripped');
  assert.ok(!('market_context' in sanitized), 'non-display_only market_context removed');
  assert.doesNotThrow(() => assertNoMarketLeak(sanitized.model_safe_inputs));
});

test('display_only market_context survives sanitization', () => {
  const artifact = makeEmptyCpcResearchArtifact({
    packet_family: 'sports',
    packet_type: 'mlb-game',
    market_context: { display_only: true, text: 'NYY 58c, DET 44c.' },
  });
  const sanitized = sanitizeResearchArtifact(artifact);
  assert.ok(sanitized.market_context && sanitized.market_context.display_only === true);
});

test('research bank writes six date/event-scoped files with non-evidence lineage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpc-bank-'));
  try {
    const sanitized = makeEmptyCpcResearchArtifact({
      packet_family: 'mentions',
      packet_type: 'tv-show-mention',
      route: 'talk_show_media',
      submarket: 'event',
      event_id: 'KXLOVEISLMENTION-26JUN22',
      source_urls: ['https://www.itv.com/watch/love-island/2a3697'],
      source_titles: ['Love Island | ITVX'],
      source_freshness: [{ url: 'https://www.itv.com/watch/love-island/2a3697', published_at: 'unavailable', checked_at: '2026-06-22T13:00:00Z', freshness: 'same_day' }],
      generated_at: '2026-06-22T13:00:00Z',
    });
    const { dir, files } = writeResearchBankArtifacts({
      date: '2026-06-22',
      packet_family: sanitized.packet_family,
      packet_type: sanitized.packet_type,
      event_id: sanitized.event_id,
      route: sanitized.route,
      submarket: sanitized.submarket,
      raw: sanitized,
      normalized: sanitized,
      sanitized,
      builderInput: { sanitized_artifact: sanitized },
      previewText: 'Headline: clean preview',
      root,
    });

    const expectedDir = researchBankDir({ date: '2026-06-22', packet_family: 'mentions', packet_type: 'tv-show-mention', event_id: 'KXLOVEISLMENTION-26JUN22', root });
    assert.equal(dir, expectedDir);
    assert.match(dir, /2026-06-22\/mentions\/tv-show-mention\/KXLOVEISLMENTION-26JUN22$/);

    for (const name of Object.values(RESEARCH_BANK_FILES)) {
      assert.ok(fs.existsSync(path.join(dir, name)), `missing bank file ${name}`);
    }

    const metadata = JSON.parse(fs.readFileSync(files.metadata, 'utf8'));
    assert.equal(metadata.narrative_is_evidence, false);
    assert.equal(metadata.schema_version, CPC_RESEARCH_ARTIFACT_SCHEMA);
    assert.equal(metadata.sanitizer_version, SANITIZER_VERSION);
    assert.equal(metadata.event_id, 'KXLOVEISLMENTION-26JUN22');
    assert.deepEqual(metadata.source_titles, ['Love Island | ITVX']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mentions customer preview text avoids banned words, paths, and ISO timestamps', () => {
  const previewText = scrubCustomerText([
    'Headline: Affordability hearing narrows the likely word-bank universe',
    'Why it matters: The hearing title suggests a narrow policy vocabulary.',
    'Confirmed context:',
    "- The committee lists an upcoming hearing titled 'The Affordability Agenda'.",
    'Primary source: Hearings | United States Committee on Banking, Housing, and Urban Affairs',
  ].join('\n'));

  for (const term of BANNED_CUSTOMER_PREVIEW_WORDS) {
    assert.doesNotMatch(previewText, new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'), `banned word ${term} leaked`);
  }
  assert.doesNotMatch(previewText, /\/home\//);
  assert.doesNotMatch(previewText, /\.mjs/);
  assert.doesNotMatch(previewText, /\d{4}-\d\d-\d\dT\d\d:\d\d/);
});
