import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeCeilingBoard,
  ALLOWED_CEILING_MARKETS,
  FORBIDDEN_CEILING_FIELDS,
} from '../scripts/nascar/lib/ceiling.mjs';
import { composeRaceDiscovery } from '../scripts/nascar/lib/discovery.mjs';
import { fixtureKalshiRaceEnvelope } from '../scripts/nascar/lib/source-adapters/kalshi-race-fixture.mjs';
import { fixtureNascarOfficialEnvelope } from '../scripts/nascar/lib/source-adapters/nascar-official-fixture.mjs';
import { fixturePracticeQualifyingEnvelope } from '../scripts/nascar/lib/source-adapters/practice-qualifying-fixture.mjs';
import { fixtureLiquidityEnvelope } from '../scripts/nascar/lib/source-adapters/liquidity-fixture.mjs';

const CHECKED = '2026-02-13T12:00:00.000Z';

function envelopes({ event_format = 'points' } = {}) {
  return {
    kalshi_race: fixtureKalshiRaceEnvelope({ checked_at_utc: CHECKED }),
    nascar_official: fixtureNascarOfficialEnvelope({ checked_at_utc: CHECKED, event_format }),
    practice_qualifying: fixturePracticeQualifyingEnvelope({ checked_at_utc: CHECKED }),
    liquidity: fixtureLiquidityEnvelope({ checked_at_utc: CHECKED }),
  };
}

function buildDiscovery(overrides = {}) {
  const envs = envelopes(overrides);
  if (overrides.event_format && overrides.event_format !== 'points') {
    const official = envs.nascar_official;
    envs.nascar_official = {
      ...official,
      records: official.records.map((r, i) =>
        i === 0
          ? { ...r, race_type: overrides.event_format, event_format: overrides.event_format, is_special_event: true }
          : r,
      ),
    };
  }
  return composeRaceDiscovery({ envelopes: envs, runDate: '2026-02-13', checkedAtUtc: CHECKED });
}

function assertNoForbidden(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) return node.forEach((it, i) => walk(it, [...path, String(i)]));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        assert.equal(
          FORBIDDEN_CEILING_FIELDS.includes(k),
          false,
          `forbidden field ${k} at ${[...path, k].join('.')}`,
        );
        walk(v, [...path, k]);
      }
    }
  };
  walk(value);
}

test('ceiling board emits exactly one ceiling_market per active candidate', () => {
  const discovery = buildDiscovery();
  const board = composeCeilingBoard({ discovery });

  assert.equal(board.ceilings.length, discovery.active_candidate_pool.length);

  const seen = new Set();
  for (const entry of board.ceilings) {
    assert.ok(entry.driver_id, 'entry has driver_id');
    assert.ok(entry.driver_name, 'entry has driver_name');
    assert.equal(typeof entry.ceiling_market, 'string');
    assert.ok(!seen.has(entry.driver_id), `driver ${entry.driver_id} appears only once`);
    seen.add(entry.driver_id);
  }
});

test('ceiling_market values are restricted to the allowed set', () => {
  const discovery = buildDiscovery();
  const board = composeCeilingBoard({ discovery });
  for (const entry of board.ceilings) {
    assert.ok(
      ALLOWED_CEILING_MARKETS.includes(entry.ceiling_market),
      `${entry.ceiling_market} must be in allowed set`,
    );
  }
});

test('fastest_lap is treated as a special prop lane, never a finish-position ceiling', () => {
  const discovery = buildDiscovery();
  const board = composeCeilingBoard({ discovery });
  for (const entry of board.ceilings) {
    if (entry.ceiling_market === 'fastest_lap') {
      assert.equal(entry.lane_type, 'special_prop');
    } else {
      assert.notEqual(entry.lane_type, 'special_prop_finish_position');
    }
  }
  // The supported_market_lanes pass-through marks fastest_lap as special_prop.
  const fl = board.supported_market_lanes.find(l => l.market_lane === 'fastest_lap');
  assert.ok(fl);
  assert.equal(fl.lane_type, 'special_prop');
});

test('top20 ceiling lane is not the current-points top 20 pool filter', () => {
  const discovery = buildDiscovery();
  const board = composeCeilingBoard({ discovery });
  // Pool rules from discovery pass through; ceiling board exposes a separation note.
  assert.equal(
    board.pool_rules.top20_lane_separation,
    discovery.pool_rules.top20_lane_separation,
  );
  // Any driver assigned ceiling top20 must not implicitly mean they are ranked top 20 in points.
  for (const entry of board.ceilings) {
    if (entry.ceiling_market === 'top20') {
      assert.equal(typeof entry.basis, 'string');
      assert.ok(!entry.basis.toLowerCase().includes('current-points top 20 pool'));
    }
  }
});

test('FIELD bucket is summarized only, never priced driver-by-driver', () => {
  const discovery = buildDiscovery();
  const board = composeCeilingBoard({ discovery });
  assert.equal(board.field_bucket.bucket_id, 'FIELD');
  assert.equal(typeof board.field_bucket.summary, 'string');
  // No ceiling entry should be tagged as a field driver.
  const activeIds = new Set(discovery.active_candidate_pool.map(d => d.driver_id));
  for (const entry of board.ceilings) {
    assert.ok(activeIds.has(entry.driver_id), `${entry.driver_id} must come from active pool`);
  }
});

test('special_event_override metadata flows through unchanged', () => {
  const discovery = buildDiscovery({ event_format: 'all_star' });
  const board = composeCeilingBoard({ discovery });
  assert.deepEqual(board.special_event_override, discovery.special_event_override);
  assert.equal(board.special_event_override.active, true);
  assert.equal(board.special_event_override.format_type, 'all_star');
});

test('no forbidden trade/order/stake/pick/recommendation/fair_value/edge/kelly/execution fields exist', () => {
  const discovery = buildDiscovery();
  const board = composeCeilingBoard({ discovery });
  assertNoForbidden(board);
});

test('user-facing lines render as "[driver_name] [ceiling]" format', () => {
  const discovery = buildDiscovery();
  const board = composeCeilingBoard({ discovery });
  for (const line of board.user_facing_lines) {
    assert.match(line, /^[^\[\]]+\s+(Win|Top 3|Top 5|Top 10|Top 20|Fastest Lap|Pass)$/);
  }
});
