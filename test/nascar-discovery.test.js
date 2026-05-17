import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeRaceDiscovery,
  FORBIDDEN_DISCOVERY_FIELDS,
  RACE_MARKET_LANES,
  runDiscoveryDryRun,
} from '../scripts/nascar/lib/discovery.mjs';
import { fixtureKalshiRaceEnvelope } from '../scripts/nascar/lib/source-adapters/kalshi-race-fixture.mjs';
import { fixtureNascarOfficialEnvelope } from '../scripts/nascar/lib/source-adapters/nascar-official-fixture.mjs';
import { fixturePracticeQualifyingEnvelope } from '../scripts/nascar/lib/source-adapters/practice-qualifying-fixture.mjs';
import { fixtureLiquidityEnvelope } from '../scripts/nascar/lib/source-adapters/liquidity-fixture.mjs';

function baseEnvelopes(overrides = {}) {
  return {
    kalshi_race: fixtureKalshiRaceEnvelope({ checked_at_utc: '2026-02-13T12:00:00.000Z' }),
    nascar_official: fixtureNascarOfficialEnvelope({
      checked_at_utc: '2026-02-13T12:00:00.000Z',
      event_format: overrides.event_format ?? 'points',
    }),
    practice_qualifying: fixturePracticeQualifyingEnvelope({ checked_at_utc: '2026-02-13T12:00:00.000Z' }),
    liquidity: fixtureLiquidityEnvelope({ checked_at_utc: '2026-02-13T12:00:00.000Z' }),
  };
}

function withDriver(envelopes, driver) {
  return {
    ...envelopes,
    practice_qualifying: {
      ...envelopes.practice_qualifying,
      records: [...envelopes.practice_qualifying.records, driver],
    },
  };
}

function makeDriver({
  driver_name,
  car_number,
  current_points_rank,
  starting_position = 30,
  practice_rank = 30,
  multi_lap_rank = 30,
  track_history_signal = 'neutral',
  liquidity_signal = 'unknown',
  override_reasons = [],
}) {
  return {
    query_type: 'driver_universe_entry',
    driver_name,
    car_number,
    current_points_rank,
    starting_position,
    practice_rank,
    multi_lap_rank,
    track_history_signal,
    liquidity_signal,
    override_reasons,
    source_urls: ['fixture://nascar-discovery-test'],
  };
}

function findDriver(discovery, name) {
  return discovery.driver_universe.find(driver => driver.driver_name === name);
}

function assertNoForbiddenFields(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, [...path, String(idx)]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        assert.equal(
          FORBIDDEN_DISCOVERY_FIELDS.includes(key),
          false,
          `forbidden field ${key} found at ${[...path, key].join('.')}`,
        );
        walk(child, [...path, key]);
      }
    }
  };
  walk(value);
}

test('normal points race creates active pool from top 20 in current points', () => {
  const discovery = composeRaceDiscovery({ envelopes: baseEnvelopes() });
  const activeNames = discovery.active_candidate_pool.map(driver => driver.driver_name);

  assert.equal(discovery.event_context.event_format, 'points');
  assert.ok(activeNames.includes('Driver A'));
  assert.ok(activeNames.includes('Driver B'));
  assert.equal(findDriver(discovery, 'Driver A').pool_status, 'active');
  assert.equal(findDriver(discovery, 'Driver B').pool_status, 'active');
  assert.equal(findDriver(discovery, 'Driver A').pool_entry_reason, 'current_points_top_20');
  assert.equal(findDriver(discovery, 'Driver B').pool_entry_reason, 'current_points_top_20');
});

test('non-top-20 driver without override stays in FIELD', () => {
  const discovery = composeRaceDiscovery({ envelopes: baseEnvelopes() });
  const driver = findDriver(discovery, 'Driver C');

  assert.equal(driver.current_points_rank > 20, true);
  assert.equal(driver.pool_status, 'field');
  assert.equal(discovery.active_candidate_pool.some(candidate => candidate.driver_name === 'Driver C'), false);
  assert.ok(discovery.field_bucket.driver_names.includes('Driver C'));
});

test('non-top-20 driver with override is promoted', () => {
  const discovery = composeRaceDiscovery({
    envelopes: withDriver(baseEnvelopes(), makeDriver({
      driver_name: 'Driver D',
      car_number: 7,
      current_points_rank: 31,
      starting_position: 4,
      practice_rank: 4,
      override_reasons: ['top5_starting_position', 'top5_practice_speed'],
    })),
  });
  const driver = findDriver(discovery, 'Driver D');

  assert.equal(driver.pool_status, 'active');
  assert.equal(driver.pool_entry_reason, 'override_promoted');
  assert.deepEqual(driver.override_reasons, ['top5_starting_position', 'top5_practice_speed']);
  assert.deepEqual(discovery.override_promoted_drivers.map(d => d.driver_name), ['Driver D']);
});

test('FIELD bucket exists and counts longshots', () => {
  const discovery = composeRaceDiscovery({ envelopes: baseEnvelopes() });

  assert.equal(discovery.field_bucket.bucket_id, 'FIELD');
  assert.equal(discovery.field_bucket.longshot_driver_count, 1);
  assert.deepEqual(discovery.field_bucket.driver_names, ['Driver C']);
  assert.match(discovery.field_bucket.summary, /collapsed/i);
});

test('all six market lanes are preserved', () => {
  const discovery = composeRaceDiscovery({ envelopes: baseEnvelopes() });

  assert.deepEqual(discovery.supported_market_lanes.map(lane => lane.market_lane), RACE_MARKET_LANES);
});

test('top20 lane is not confused with top 20 points filter', () => {
  const discovery = composeRaceDiscovery({ envelopes: baseEnvelopes() });
  const top20Lane = discovery.supported_market_lanes.find(lane => lane.market_lane === 'top20');

  assert.equal(top20Lane.lane_type, 'finish_position');
  assert.match(top20Lane.description, /finishes in the top 20/i);
  assert.equal(discovery.pool_rules.default_active_rule, 'current_points_rank <= 20');
  assert.equal(findDriver(discovery, 'Driver B').pool_entry_reason, 'current_points_top_20');
});

test('fastest_lap remains a special prop lane, not a finish-position ceiling', () => {
  const discovery = composeRaceDiscovery({ envelopes: baseEnvelopes() });
  const fastestLap = discovery.supported_market_lanes.find(lane => lane.market_lane === 'fastest_lap');

  assert.equal(fastestLap.lane_type, 'special_prop');
  assert.match(fastestLap.description, /fastest single lap/i);
});

test('all_star event sets special_event_override true', () => {
  const discovery = composeRaceDiscovery({ envelopes: baseEnvelopes({ event_format: 'all_star' }) });

  assert.equal(discovery.event_context.event_format, 'all_star');
  assert.equal(discovery.special_event_override.active, true);
  assert.equal(discovery.special_event_override.format_type, 'all_star');
});

test('forbidden trade/pick/recommendation/fair-value fields are absent', async () => {
  const discovery = await runDiscoveryDryRun({ eventFormat: 'points' });

  assertNoForbiddenFields(discovery);
  const serialized = JSON.stringify(discovery);
  for (const word of ['TRADE_YES', 'TRADE_NO', 'PLACE_PASSIVE_ORDER', 'NO_TRADE']) {
    assert.equal(serialized.includes(word), false, `must not contain trading status ${word}`);
  }
});
