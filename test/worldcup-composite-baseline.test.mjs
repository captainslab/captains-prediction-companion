// Prior-composite baseline fallback + provenance labeling tests.
//
// When no team_baseline exists for the target date and a live fetch fails,
// the generator must fall back to the most recent PRIOR baseline (last
// available composite) rather than emitting an empty all-BLOCKED board — and
// the packet must label that provenance honestly as PRE_LOCK / PRIOR_COMPOSITE.

import test from 'node:test';
import assert from 'node:assert/strict';

import { findLatestPriorBaseline } from '../scripts/worldcup/lib/composite-baseline.mjs';
import { renderWorldCupPacket } from '../scripts/worldcup/lib/packet-renderer.mjs';
import { composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';

test('findLatestPriorBaseline picks the most recent baseline before the target date', () => {
  const found = findLatestPriorBaseline('state', '2026-06-22');
  assert.ok(found, 'a prior baseline should be found for 2026-06-22');
  assert.equal(found.sourceDate, '2026-06-17', 'latest prior baseline is 2026-06-17');
  const arg = (found.baseline.teams || []).find(t => t.team_name === 'Argentina');
  assert.ok(arg && (arg.quality_score_0_100 ?? arg.attack_rating) != null, 'baseline carries Argentina composite');
});

test('findLatestPriorBaseline returns null when no prior baseline exists', () => {
  assert.equal(findLatestPriorBaseline('state', '2026-01-01'), null);
});

test('packet labels provisional prior-composite provenance as PRE_LOCK', () => {
  const match = {
    match_id: '400021494', home_team: 'Argentina', away_team: 'Austria',
    stage: 'group', kickoff_utc: '2026-06-22T17:00:00.000Z', lineup_status: 'lineup_pending',
  };
  const mk = (s) => ({ present: true, score: s });
  const side = (s) => Object.fromEntries(
    ['team_quality_baseline','recent_form','attacking_strength','defensive_strength','opponent_adjusted_attack','opponent_adjusted_defense','opponent_style_fit','set_piece_matchup','goalkeeper_edge','squad_availability','lineup_strength_delta','rest_travel_venue_climate','tournament_incentive_state','knockout_extra_time_penalty'].map(k => [k, mk(s)]),
  );
  const ledger = composeEvidenceLedgerForGame(side(92), side(39));
  const board = composeMultiLaneCeilingBoard({ homeLedger: ledger.home, awayLedger: ledger.away, marketContexts: [], isKnockout: false, lineupConfirmed: false });

  const text = renderWorldCupPacket({
    matches: [match], boards: [board],
    meta: { date: '2026-06-22', composite_provenance: { source_date: '2026-06-17', provisional: true } },
  });
  assert.ok(text.includes('latest prior team composite from 2026-06-17'), 'must name prior-composite model basis');
  assert.ok(text.includes('Pre-lock forecast: lineups are not confirmed'), 'must mark the pre-lock state');
  assert.ok(text.includes('not today\'s confirmed XI'), 'must disclose the pre-lock XI basis');
});

test('packet omits the provisional banner when provenance is current', () => {
  const match = { match_id: 'x', home_team: 'A', away_team: 'B', stage: 'group', kickoff_utc: '2026-06-22T17:00:00.000Z', lineup_status: 'lineup_confirmed' };
  const mk = (s) => ({ present: true, score: s });
  const side = (s) => Object.fromEntries(
    ['team_quality_baseline','recent_form','attacking_strength','defensive_strength','opponent_adjusted_attack','opponent_adjusted_defense','opponent_style_fit','set_piece_matchup','goalkeeper_edge','squad_availability','lineup_strength_delta','rest_travel_venue_climate','tournament_incentive_state','knockout_extra_time_penalty'].map(k => [k, mk(s)]),
  );
  const ledger = composeEvidenceLedgerForGame(side(80), side(60));
  const board = composeMultiLaneCeilingBoard({ homeLedger: ledger.home, awayLedger: ledger.away, marketContexts: [], isKnockout: false, lineupConfirmed: true });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22', packet_stage: 'lineup_locked' } });
  assert.ok(!text.includes('latest prior team composite from'), 'no prior-composite banner when provenance is current');
});
