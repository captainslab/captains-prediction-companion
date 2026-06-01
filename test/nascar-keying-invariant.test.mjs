// NASCAR keying-invariant tests.
//
// INVARIANT UNDER TEST:
//   "Driver skill layers follow the DRIVER. Equipment layers follow the CAR/TEAM."
//
// Driver-keyed history (track_history, similar_track_history, recent_form,
// passing, restarts, incident risk, driver pace) is keyed by NORMALIZED DRIVER
// NAME and must never merge two different drivers who shared a car number.
// Equipment layers (team_equipment_strength, pit_crew_and_pit_road,
// crew_chief_strategy) are keyed by car_number + team + manufacturer via the
// upcoming entry list, and must be able to use car/team context.
//
// Also pins market-neutrality: neither key path reads Kalshi price fields.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loopHistoryLayerInputs,
  nascarCarEquipmentRollup,
  nascarEquipmentLayersByDriverKey,
  normalizeDriverNameForLoopHistory,
} from '../scripts/nascar/lib/source-adapters/loop-history-gen7.mjs';

// ---------------------------------------------------------------------------
// Helpers: build a tiny synthetic two-season snapshot-shaped input by driving
// the public functions through their real snapshot read. We assert on the
// committed Gen-7 snapshots (real data) so the tests double as integration
// coverage. Charlotte oval is a stable intermediate with full fields.
// ---------------------------------------------------------------------------
function charlotteRace() {
  // track_id 162 = Charlotte Motor Speedway oval (intermediate) in the snapshots.
  return { track_id: 162, track_name: 'Charlotte Motor Speedway', track_type: 'intermediate' };
}

// ---------------------------------------------------------------------------
// PROOF 1 — two drivers sharing the same car number across different years do
// NOT have their driver history merged. Car #45 was Kurt Busch then Tyler
// Reddick in the Gen-7 era; their track histories must stay separate.
// ---------------------------------------------------------------------------
test('driver history is name-keyed: two drivers who shared a car number never merge', () => {
  const inputs = loopHistoryLayerInputs({ race: charlotteRace() });
  const keys = Object.keys(inputs.by_driver);

  // Reddick and Kurt Busch both ran car #45 (23XI) at different times in Gen-7.
  const reddickKey = normalizeDriverNameForLoopHistory('Tyler Reddick');
  const buschKey = normalizeDriverNameForLoopHistory('Kurt Busch');

  // They must be DISTINCT driver keys (not collapsed into one car bucket).
  assert.notEqual(reddickKey, buschKey, 'distinct drivers normalize to distinct keys');

  // At least Reddick must be present with his OWN driver history in the pool.
  assert.ok(inputs.by_driver[reddickKey], 'Reddick present as his own driver key');
  // The driver key is a name, never a car number.
  for (const k of keys) {
    assert.ok(!/^\d+$/.test(k), `driver key "${k}" must not be a bare car number`);
  }

  // Reddick's track-history sample is HIS finishes only — it cannot include
  // Kurt Busch's races just because they shared the #45 at different times.
  const reddick = inputs.by_driver[reddickKey];
  if (reddick.layers.track_history) {
    // sample count equals the number of his own Charlotte finishes (<= seasons)
    assert.ok(reddick.layers.track_history.sample <= 6, 'his-track sample is per-driver, not per-car');
  }
});

// ---------------------------------------------------------------------------
// PROOF 2 — equipment/team strength CAN use car_number + team context, and is
// looked up by the car the driver is entered in THIS week (not the driver).
// ---------------------------------------------------------------------------
test('equipment layers are car/team-keyed and use car_number context', () => {
  const rollup = nascarCarEquipmentRollup({});
  // Real charter cars must roll up with a non-trivial multi-season sample.
  const c24 = rollup.get('24');
  const c5 = rollup.get('5');
  assert.ok(c24 && c24.sample > 20, 'car #24 has a real multi-season equipment sample');
  assert.ok(c5 && c5.sample > 20, 'car #5 has a real multi-season equipment sample');
  assert.ok(c24.seasons.length >= 2 && c24.seasons[0] >= 2022, 'Gen-7 seasons only');

  // The equipment layer attaches to whichever driver is ENTERED in that car.
  const entryList = [
    { driver_name: 'Some Driver A', car_number: 24, team: 'Hendrick Motorsports', manufacturer: 'Chevrolet' },
    { driver_name: 'Some Driver B', car_number: 24, team: 'Hendrick Motorsports', manufacturer: 'Chevrolet' },
  ];
  const equip = nascarEquipmentLayersByDriverKey({ entryList });
  const a = equip.get(normalizeDriverNameForLoopHistory('Some Driver A'));
  const b = equip.get(normalizeDriverNameForLoopHistory('Some Driver B'));
  // Both drivers entered in car #24 inherit the SAME car equipment score —
  // equipment follows the car, not the driver name.
  assert.equal(
    a.layers.team_equipment_strength.score,
    b.layers.team_equipment_strength.score,
    'two drivers in the same car share equipment strength',
  );
  assert.equal(a._car_context.keyed_by, 'car_number+team+manufacturer');
  assert.equal(a._car_context.car_number, '24');
  assert.equal(a.layers.team_equipment_strength.score, c24.score, 'equipment = car rollup score');
});

// ---------------------------------------------------------------------------
// PROOF 2b — a driver who CHANGES cars inherits the NEW car's equipment, while
// keeping their OWN driver track history. This is the core of the invariant.
// ---------------------------------------------------------------------------
test('changing cars: equipment follows the new car, driver history stays with the driver', () => {
  const rollup = nascarCarEquipmentRollup({});
  // Put William Byron (whose name-keyed history is his own) into car #5 instead
  // of his usual #24. His track history must be unchanged; his equipment must
  // become car #5's program, not #24's.
  const inCar5 = loopHistoryLayerInputs({
    race: charlotteRace(),
    entryList: [{ driver_name: 'William Byron', car_number: 5, team: 'Hendrick Motorsports', manufacturer: 'Chevrolet' }],
  });
  const inCar24 = loopHistoryLayerInputs({
    race: charlotteRace(),
    entryList: [{ driver_name: 'William Byron', car_number: 24, team: 'Hendrick Motorsports', manufacturer: 'Chevrolet' }],
  });
  const key = normalizeDriverNameForLoopHistory('William Byron');
  const b5 = inCar5.by_driver[key];
  const b24 = inCar24.by_driver[key];

  // Driver track history identical regardless of which car he is entered in.
  assert.deepEqual(b5.layers.track_history, b24.layers.track_history, 'driver history is car-agnostic');

  // Equipment strength tracks the entered car.
  assert.equal(b5.layers.team_equipment_strength.score, rollup.get('5').score);
  assert.equal(b24.layers.team_equipment_strength.score, rollup.get('24').score);
  assert.equal(b5.equipment_inputs.car_number, '5');
  assert.equal(b24.equipment_inputs.car_number, '24');
});

// ---------------------------------------------------------------------------
// PROOF 3 — driver-based history and car/team equipment context are exposed as
// SEPARATE bundles on the candidate (track_specific_inputs vs equipment_inputs)
// so a packet can render them side by side without conflation.
// ---------------------------------------------------------------------------
test('driver history and equipment context are separate, side-by-side bundles', () => {
  const inputs = loopHistoryLayerInputs({
    race: charlotteRace(),
    entryList: [{ driver_name: 'Denny Hamlin', car_number: 11, team: 'Joe Gibbs Racing', manufacturer: 'Toyota' }],
  });
  const d = inputs.by_driver[normalizeDriverNameForLoopHistory('Denny Hamlin')];
  // Driver-keyed bundle.
  assert.ok(Object.hasOwn(d, 'track_specific_inputs'));
  assert.equal(typeof d.track_specific_inputs.this_track_races, 'number');
  // Car/team-keyed bundle, kept separate.
  assert.ok(Object.hasOwn(d, 'equipment_inputs'));
  assert.equal(d.equipment_inputs.car_number, '11');
  assert.equal(d.equipment_inputs.team, 'Joe Gibbs Racing');
  // The two bundles are NOT the same object and carry different provenance.
  assert.notEqual(d.track_specific_inputs, d.equipment_inputs);
  assert.ok(Object.hasOwn(d.evidence_summary, 'this_track_sample'));
  assert.ok(Object.hasOwn(d.evidence_summary, 'equipment_car_sample'));
});

// ---------------------------------------------------------------------------
// PROOF 4 — market-neutrality: injecting Kalshi price fields into the race, the
// entry list, and driver records changes NOTHING in either key path's output.
// ---------------------------------------------------------------------------
const PRICE_POISON = {
  yes_ask: 0.91, yes_bid: 0.88, no_ask: 0.12, no_bid: 0.07, last_price: 0.82,
  implied_prob: 0.78, market_prob: 0.81, kalshi_ask: 0.91, kalshi_bid: 0.88,
  volume: 12000, open_interest: 5000, moneyline_odds: -180, price: 0.83, odds: 1.55,
};

test('market-neutrality: Kalshi price fields are never read by the driver OR car key path', () => {
  const race = charlotteRace();
  const cleanEntry = [{ driver_name: 'Kyle Larson', car_number: 5, team: 'Hendrick Motorsports', manufacturer: 'Chevrolet' }];
  const dirtyEntry = [{ ...cleanEntry[0], ...PRICE_POISON }];
  const dirtyRace = { ...race, ...PRICE_POISON };

  const clean = loopHistoryLayerInputs({ race, entryList: cleanEntry });
  const dirty = loopHistoryLayerInputs({ race: dirtyRace, entryList: dirtyEntry });

  // Whole-output equality: price injection is a no-op.
  assert.deepEqual(dirty.by_driver, clean.by_driver, 'price fields changed model output');

  // And no price token appears anywhere in the serialized candidate output.
  const json = JSON.stringify(clean.by_driver);
  for (const k of ['yes_ask', 'yes_bid', 'no_ask', 'no_bid', 'last_price', 'implied_prob',
    'market_prob', 'kalshi_ask', 'kalshi_bid', 'moneyline_odds', 'open_interest']) {
    assert.ok(!json.includes(`"${k}"`), `forbidden market key leaked: ${k}`);
  }
});

test('era floor: every aggregated season is Gen-7 (2022+)', () => {
  const rollup = nascarCarEquipmentRollup({});
  for (const [, rec] of rollup) {
    for (const s of rec.seasons) assert.ok(s >= 2022, `season ${s} below Gen-7 floor leaked into equipment`);
  }
});
