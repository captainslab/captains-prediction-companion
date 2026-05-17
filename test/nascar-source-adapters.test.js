// NASCAR Stage 2 source adapter tests.
// Fixtures-only. No live network. No credentials. No trading.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchKalshiRaceReadonly,
  fixtureKalshiRaceEnvelope,
  RACE_LANES,
} from '../scripts/nascar/lib/source-adapters/kalshi-race-fixture.mjs';
import {
  fetchNascarOfficialReadonly,
  fixtureNascarOfficialEnvelope,
} from '../scripts/nascar/lib/source-adapters/nascar-official-fixture.mjs';
import {
  fetchPracticeQualifyingReadonly,
} from '../scripts/nascar/lib/source-adapters/practice-qualifying-fixture.mjs';
import {
  fetchLiquidityReadonly,
} from '../scripts/nascar/lib/source-adapters/liquidity-fixture.mjs';
import { runSourceAdapterDryRun } from '../scripts/nascar/source-adapter-dry-run.mjs';

const FORBIDDEN_FIELDS = [
  'trade',
  'order',
  'stake',
  'pick',
  'recommendation',
  'fair_value',
  'execution',
  'side',
  'limit_price',
  'kelly',
  'sizing',
];

function assertEnvelopeShape(env) {
  for (const key of [
    'source_id',
    'status',
    'checked_at_utc',
    'records',
    'warnings',
    'errors',
    'source_urls',
  ]) {
    assert.ok(key in env, `envelope missing ${key}`);
  }
  assert.equal(typeof env.source_id, 'string');
  assert.equal(typeof env.status, 'string');
  assert.equal(typeof env.checked_at_utc, 'string');
  assert.ok(Array.isArray(env.records));
  assert.ok(Array.isArray(env.warnings));
  assert.ok(Array.isArray(env.errors));
  assert.ok(Array.isArray(env.source_urls));
}

function assertNoForbiddenFields(env) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        assert.ok(
          !FORBIDDEN_FIELDS.includes(k),
          `forbidden field "${k}" found in ${env.source_id} envelope`,
        );
        walk(node[k]);
      }
    }
  };
  walk(env);
}

test('every adapter returns a well-formed envelope', async () => {
  const envs = [
    await fetchKalshiRaceReadonly(),
    await fetchNascarOfficialReadonly(),
    await fetchPracticeQualifyingReadonly(),
    await fetchLiquidityReadonly(),
  ];
  for (const env of envs) {
    assertEnvelopeShape(env);
    assertNoForbiddenFields(env);
  }
});

test('Kalshi race fixture includes all six race lanes', async () => {
  const env = await fetchKalshiRaceReadonly();
  const lanes = env.records.map(r => r.market_lane);
  for (const lane of RACE_LANES) {
    assert.ok(lanes.includes(lane), `missing lane: ${lane}`);
  }
  // top20 must be a finish-position market lane, not a points-pool marker
  const top20 = env.records.find(r => r.market_lane === 'top20');
  assert.ok(top20);
  assert.ok(!('current_points_rank' in top20));
  assert.match(top20.notes ?? '', /finish-position/i);
});

test('NASCAR official fixture includes race name, series, track, event_format, scheduled time, race_type', async () => {
  const env = await fetchNascarOfficialReadonly();
  const rec = env.records[0];
  for (const key of [
    'race_name',
    'series',
    'track',
    'event_format',
    'scheduled_start_utc',
    'race_type',
  ]) {
    assert.ok(key in rec, `missing ${key}`);
    assert.ok(rec[key] !== null && rec[key] !== '');
  }
});

test('practice/qualifying fixture includes starting position and practice rank fields', async () => {
  const env = await fetchPracticeQualifyingReadonly();
  assert.ok(env.records.length > 0);
  for (const r of env.records) {
    for (const key of [
      'starting_position',
      'practice_rank',
      'current_points_rank',
      'multi_lap_rank',
      'track_history_signal',
      'liquidity_signal',
      'override_reasons',
    ]) {
      assert.ok(key in r, `missing ${key}`);
    }
  }
});

test('liquidity fixture flags weak/noisy markets without making recommendations', async () => {
  const env = await fetchLiquidityReadonly();
  const flagged = env.records.filter(r => r.liquidity_status !== 'strong');
  assert.ok(flagged.length > 0, 'expected at least one thin/noisy market in fixture');
  for (const r of env.records) {
    assert.ok(['strong', 'thin', 'noisy', 'unknown'].includes(r.liquidity_status));
    assert.ok(!('recommendation' in r));
    assert.ok(!('fair_value' in r));
  }
});

test('All-Star fixture marks event_format as special/exhibition-style without making it default', async () => {
  const official = fixtureNascarOfficialEnvelope({ event_format: 'all_star' });
  assert.equal(official.records[0].event_format, 'all_star');
  assert.equal(official.records[0].is_special_event, true);
  assert.match(official.records[0].notes ?? '', /special_event_override/);
  const kalshi = fixtureKalshiRaceEnvelope({ event_format: 'all_star' });
  for (const r of kalshi.records) {
    assert.equal(r.event_format, 'all_star');
  }
  // points event must NOT be flagged special
  const points = fixtureNascarOfficialEnvelope({ event_format: 'points' });
  assert.equal(points.records[0].is_special_event, false);
});

test('no adapter output contains trade/order/stake/pick/recommendation/fair_value/execution', async () => {
  const { envelopes } = await runSourceAdapterDryRun({});
  for (const env of Object.values(envelopes)) {
    assertNoForbiddenFields(env);
  }
});

test('dry-run runner produces summary with all four sources', async () => {
  const { summary, envelopes } = await runSourceAdapterDryRun({});
  assert.equal(summary.mode, 'fixtures-only');
  for (const id of ['kalshi_race', 'nascar_official', 'practice_qualifying', 'liquidity']) {
    assert.ok(id in envelopes, `missing envelope: ${id}`);
    assert.ok(id in summary.sources, `missing summary entry: ${id}`);
  }
});
