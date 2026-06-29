import test from 'node:test';
import assert from 'node:assert/strict';

import { renderWorldCupPacket } from '../scripts/worldcup/lib/packet-renderer.mjs';
import { composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';

function buildBoard(homeScore, awayScore, { lineupsConfirmed = false } = {}) {
  const mk = (score) => ({ present: true, score });
  const side = (score) => Object.fromEntries(
    ['team_quality_baseline', 'recent_form', 'attacking_strength', 'defensive_strength', 'opponent_adjusted_attack', 'opponent_adjusted_defense', 'opponent_style_fit', 'set_piece_matchup', 'goalkeeper_edge', 'squad_availability', 'lineup_strength_delta', 'rest_travel_venue_climate', 'tournament_incentive_state', 'knockout_extra_time_penalty']
      .map((key) => [key, mk(score)]),
  );
  const ledger = composeEvidenceLedgerForGame(side(homeScore), side(awayScore));
  return composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [],
    isKnockout: false,
    lineupConfirmed: lineupsConfirmed,
  });
}

test('renderWorldCupPacket uses customer-facing forecast language and no raw UTC headers', () => {
  const match = {
    match_id: '400021494',
    home_team: 'Argentina',
    away_team: 'Austria',
    group: 'Group J',
    kickoff_utc: '2026-06-22T17:00:00.000Z',
    venue: 'Dallas Stadium',
    lineup_status: 'lineup_pending',
    live_context: {
      status: 'gathered',
      source_id: 'perplexity',
      source_label: 'Perplexity research',
      matched_by: 'match_id',
      match_id: '400021494',
      source_quality: 'High',
      summary: 'Argentina enters with a full-strength XI and a strong recent scoring run.',
      citations: ['[1]'],
    },
  };
  const board = buildBoard(92.7, 39.3);
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: {
      date: '2026-06-22',
      packet_stage: 'morning_board',
      composite_provenance: { source_date: '2026-06-17', provisional: true },
      research: {
        status: 'ok',
        outPath: 'state/worldcup/2026-06-22/research/perplexity_research.json',
        attached_count: 1,
      },
    },
  });

  assert.match(text, /1\. Matchday Forecast/);
  assert.match(text, /Argentina vs Austria: Argentina rates higher; projected goals 1\.79-0\.94; projected total 2\.73/);
  assert.match(text, /Status: Pre-lock, lineups not confirmed/);
  assert.match(text, /Model basis: latest prior team composite from 2026-06-17, not today's official starting lineup/);
  assert.match(text, /Kickoff: .*C(?:DT|ST).*\/ .*E(?:DT|ST)/);
  assert.match(text, /Goal forecast: Projected goals: Argentina 1\.79, Austria 0\.94/);
  assert.match(text, /Total goals forecast: Projected total 2\.73/);
  assert.match(text, /Both-score forecast: \d+%/);
  assert.match(text, /Goal-spread forecast: Argentina \+0\.85 goals; projected goal difference only; no external line attached/);
  assert.match(text, /Score-grid check: models aligned/);
  assert.match(text, /Market Context - NOT IN SCORE: no external lines attached; model output shown as forecast only\./);
  assert.match(text, /First-half markets are unavailable because no half-split model layer is sourced\./);
  assert.match(text, /live context: gathered — Perplexity research/);
  assert.match(text, /Perplexity research: live supplemental context captured/);
  assert.doesNotMatch(text, /\b(?:PICK|LEAN|WATCH|FADE|winner_lean|projection-only|actionable|monitor|top edge candidates|trigger board|overpriced)\b/i);
  assert.doesNotMatch(text, /\blineup_status\b/i);
  assert.doesNotMatch(text, /\boverall_confidence\b/i);
  assert.doesNotMatch(text, /\[null\]/i);
  assert.doesNotMatch(text, /2026-06-22T17:00:00\.000Z/);
  assert.match(text, /Reference prices are not used in the model\./);
});
