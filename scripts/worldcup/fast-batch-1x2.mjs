
import { composeEvidenceLedgerForGame } from './lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from './lib/multi-lane-ceiling.mjs';
import { buildOpponentMatchup } from './source-adapters/opponent-matchup.mjs';
import { readFileSync } from 'node:fs';

const stateRoot = 'state';
const date = '2026-06-11';

// Load structure
const struct = JSON.parse(readFileSync(`${stateRoot}/worldcup/${date}/discovery/static_structure.json`, 'utf8'));

// Load baseline
const baseline = JSON.parse(readFileSync(`${stateRoot}/worldcup/${date}/discovery/team_baseline.json`, 'utf8'));
const teamBaselines = Object.fromEntries((baseline.teams || []).map(t => [t.team_name, t]));

const requested = [
  ['Korea Republic', 'Czechia'],
  ['Canada', 'Bosnia and Herzegovina'],
  ['USA', 'Paraguay'],
  ['Brazil', 'Morocco'],
  ['Australia', 'Türkiye'],
  ['Germany', 'Curaçao'],
  ['Netherlands', 'Japan'],
  ['Ivory Coast', 'Ecuador'],
  ['Sweden', 'Tunisia'],
  ['Belgium', 'Egypt'],
  ['Saudi Arabia', 'Uruguay'],
  ['IR Iran', 'New Zealand'],
  ['France', 'Senegal'],
  ['Argentina', 'Algeria'],
  ['England', 'Croatia'],
  ['Ghana', 'Panama'],
];

function quality(b) {
  return b?.quality_score_0_100 ?? b?.attack_rating ?? null;
}

const results = [];

for (const [homeTeam, awayTeam] of requested) {
  const match = struct.matches.find(m => m.home_team === homeTeam && m.away_team === awayTeam);
  
  const homeBase = teamBaselines[homeTeam] || {};
  const awayBase = teamBaselines[awayTeam] || {};
  
  const matchup = buildOpponentMatchup({ homeTeam, awayTeam, teamBaselines, historicalH2H: [] });
  
  const homeEntry = {
    team_quality_baseline: { present: quality(homeBase) != null, score: quality(homeBase), basis: 'normalized Elo / FIFA quality (0-100)' },
    recent_form: { present: false, score: null, basis: 'recent international form', missing_reason: 'not yet sourced' },
    attacking_strength: { present: homeBase.attack_rating != null, score: homeBase.attack_rating ?? null, basis: 'normalized attack rating (0-100)' },
    defensive_strength: { present: homeBase.defense_rating != null, score: homeBase.defense_rating ?? null, basis: 'normalized defense rating (0-100)' },
    opponent_adjusted_attack: { present: !!matchup.ok, score: matchup.home?.attack_vs_opponent_defense?.score ?? null, basis: matchup.home?.attack_vs_opponent_defense?.basis },
    opponent_adjusted_defense: { present: !!matchup.ok, score: matchup.home?.defense_vs_opponent_attack?.score ?? null, basis: matchup.home?.defense_vs_opponent_attack?.basis },
    opponent_style_fit: { present: !!matchup.ok, score: matchup.home?.style_fit?.score ?? null, basis: matchup.home?.style_fit?.basis },
    set_piece_matchup: { present: !!matchup.ok, score: matchup.home?.set_piece_vs_opponent?.score ?? null, basis: matchup.home?.set_piece_vs_opponent?.basis },
    goalkeeper_edge: { present: !!matchup.ok, score: matchup.home?.goalkeeper_vs_opponent_chance_quality?.score ?? null, basis: matchup.home?.goalkeeper_vs_opponent_chance_quality?.basis },
    squad_availability: { present: false, score: null, basis: 'squad availability', missing_reason: 'not yet sourced' },
    lineup_strength_delta: { present: false, score: null, basis: 'lineup strength delta', missing_reason: 'lineups not confirmed' },
    rest_travel_venue_climate: { present: false, score: null, basis: 'rest/travel/venue/climate', missing_reason: 'not yet sourced' },
    tournament_incentive_state: { present: false, score: null, basis: 'tournament incentive', missing_reason: 'not yet sourced' },
    knockout_extra_time_penalty: { present: false, score: null, basis: 'knockout extra time / penalties', missing_reason: 'group stage' },
  };

  const awayEntry = {
    team_quality_baseline: { present: quality(awayBase) != null, score: quality(awayBase), basis: 'normalized Elo / FIFA quality (0-100)' },
    recent_form: { present: false, score: null, basis: 'recent international form', missing_reason: 'not yet sourced' },
    attacking_strength: { present: awayBase.attack_rating != null, score: awayBase.attack_rating ?? null, basis: 'normalized attack rating (0-100)' },
    defensive_strength: { present: awayBase.defense_rating != null, score: awayBase.defense_rating ?? null, basis: 'normalized defense rating (0-100)' },
    opponent_adjusted_attack: { present: !!matchup.ok, score: matchup.away?.attack_vs_opponent_defense?.score ?? null, basis: matchup.away?.attack_vs_opponent_defense?.basis },
    opponent_adjusted_defense: { present: !!matchup.ok, score: matchup.away?.defense_vs_opponent_attack?.score ?? null, basis: matchup.away?.defense_vs_opponent_attack?.basis },
    opponent_style_fit: { present: !!matchup.ok, score: matchup.away?.style_fit?.score ?? null, basis: matchup.away?.style_fit?.basis },
    set_piece_matchup: { present: !!matchup.ok, score: matchup.away?.set_piece_vs_opponent?.score ?? null, basis: matchup.away?.set_piece_vs_opponent?.basis },
    goalkeeper_edge: { present: !!matchup.ok, score: matchup.away?.goalkeeper_vs_opponent_chance_quality?.score ?? null, basis: matchup.away?.goalkeeper_vs_opponent_chance_quality?.basis },
    squad_availability: { present: false, score: null, basis: 'squad availability', missing_reason: 'not yet sourced' },
    lineup_strength_delta: { present: false, score: null, basis: 'lineup strength delta', missing_reason: 'lineups not confirmed' },
    rest_travel_venue_climate: { present: false, score: null, basis: 'rest/travel/venue/climate', missing_reason: 'not yet sourced' },
    tournament_incentive_state: { present: false, score: null, basis: 'tournament incentive', missing_reason: 'not yet sourced' },
    knockout_extra_time_penalty: { present: false, score: null, basis: 'knockout extra time / penalties', missing_reason: 'group stage' },
  };

  const ledger = composeEvidenceLedgerForGame(homeEntry, awayEntry, { isKnockout: false });
  const board = composeMultiLaneCeilingBoard({ homeLedger: ledger.home, awayLedger: ledger.away, marketContexts: [], isKnockout: false, lineupConfirmed: false });
  
  const matchWinnerLane = board.lanes.find(l => l.lane === 'match_winner');
  const probs = board.probabilities;
  
  results.push({
    match: `${homeTeam} vs ${awayTeam}`,
    kickoff: match?.kickoff_utc ?? 'unknown',
    composite_home: ledger.home.composite_score,
    composite_away: ledger.away.composite_score,
    p_home: probs?.p_home ?? null,
    p_draw: probs?.p_draw ?? null,
    p_away: probs?.p_away ?? null,
    winner_lean: probs?.winner_lean ?? null,
    draw_risk: probs?.draw_risk ?? null,
    draw_evaluation: probs?.draw_evaluation ?? null,
    recommendation: matchWinnerLane?.recommendation ?? 'NO CLEAR PICK',
    confidence: matchWinnerLane?.confidence ?? 'low',
    explanation: matchWinnerLane?.explanation ?? '',
    goal_env: probs?.goal_environment ?? null,
  });
}

console.log(JSON.stringify(results, null, 2));
