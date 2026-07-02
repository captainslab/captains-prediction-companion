// Regression tests for the World Cup lineup name-join.
//
// The ESPN event id is resolved by canonicalizing team names on both sides of
// the join (static structure vs ESPN scoreboard). These assert that the
// known-divergent spellings that historically dropped as "no structure map"
// now reconcile to the same match key, while genuinely different matchups do
// not collide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTeamKey, matchKey } from '../scripts/worldcup/source-adapters/fetch-official-lineups.mjs';

test('divergent team spellings canonicalize to the same key', () => {
  const pairs = [
    ['IR Iran', 'Iran'],
    ['Cabo Verde', 'Cape Verde'],
    ['Cape Verde Islands', 'Cape Verde'],
    ['Türkiye', 'Turkey'],
    ['Korea Republic', 'South Korea'],
    ["Côte d'Ivoire", 'Ivory Coast'],
    ['Congo DR', 'DR Congo'],
    ['Czechia', 'Czech Republic'],
    ['USA', 'United States'],
    ['Bosnia and Herzegovina', 'Bosnia Herzegovina'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(canonicalTeamKey(a), canonicalTeamKey(b), `${a} !== ${b}`);
  }
});

test('divergent matchups reconcile to one order-independent match key', () => {
  const cases = [
    [['IR Iran', 'Egypt'], ['Iran', 'Egypt']],
    [['Cabo Verde', 'Saudi Arabia'], ['Cape Verde', 'Saudi Arabia']],
    [['Türkiye', 'Paraguay'], ['Turkey', 'Paraguay']],
    [['Korea Republic', 'Czechia'], ['South Korea', 'Czech Republic']],
    [["Côte d'Ivoire", 'Ecuador'], ['Ivory Coast', 'Ecuador']],
    [['Portugal', 'Congo DR'], ['Portugal', 'DR Congo']],
  ];
  for (const [structNames, espnNames] of cases) {
    assert.equal(
      matchKey(structNames[0], structNames[1]),
      matchKey(espnNames[0], espnNames[1]),
      `${structNames.join('/')} !== ${espnNames.join('/')}`,
    );
  }
});

test('match key is order-independent', () => {
  assert.equal(matchKey('Spain', 'Austria'), matchKey('Austria', 'Spain'));
});

test('genuinely different matchups do not collide', () => {
  assert.notEqual(matchKey('Spain', 'Austria'), matchKey('Iran', 'Egypt'));
  assert.notEqual(canonicalTeamKey('Iran'), canonicalTeamKey('Iraq'));
  assert.notEqual(canonicalTeamKey('South Korea'), canonicalTeamKey('South Africa'));
  // DR Congo variants reconcile, but Republic of Congo must stay distinct: the
  // "dr" prefix is not dropped, so it cannot collapse into DR Congo.
  assert.equal(canonicalTeamKey('Congo DR'), canonicalTeamKey('DR Congo'));
  assert.notEqual(canonicalTeamKey('Congo'), canonicalTeamKey('DR Congo'));
});
