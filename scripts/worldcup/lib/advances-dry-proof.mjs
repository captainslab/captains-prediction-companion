#!/usr/bin/env node
// Dry-proof runner for the World Cup advances model.
//
// Uses fixtures only. No live network. No persistent artifacts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeEmptyCpcResearchArtifact } from '../../shared/cpc-research-artifact-schema.mjs';
import { sanitizeResearchArtifact } from '../../shared/preview-artifact-sanitizer.mjs';
import { writeResearchBankArtifacts } from '../../shared/cpc-research-bank.mjs';
import { buildPacketPreviewBlock } from '../../shared/cpc-preview-adapter.mjs';
import { buildSportsPreview } from '../../shared/sports-preview-builder.mjs';
import { composeEvidenceLedgerForGame } from './evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from './multi-lane-ceiling.mjs';
import { loadCachedEloBaseline } from './elo-baseline.mjs';
import { renderWorldCupPacket, worldCupModelSummary } from './packet-renderer.mjs';
import { parseMarketContract } from './market-parser.mjs';

const DATE = '2026-06-30';
const FIXTURES = [
  { home_team: 'Ivory Coast', away_team: 'Norway', match_id: 'wc-adv-ico-nor', round: 4, stage: 'round_of_16', kickoff_utc: '2026-06-30T19:00:00Z', venue: 'Fixture Arena' },
  { home_team: 'France', away_team: 'Sweden', match_id: 'wc-adv-fra-swe', round: 5, stage: 'quarter_final', kickoff_utc: '2026-06-30T21:00:00Z', venue: 'Fixture Arena' },
  { home_team: 'Mexico', away_team: 'Ecuador', match_id: 'wc-adv-mex-ecu', round: 6, stage: 'semi_final', kickoff_utc: '2026-06-30T23:00:00Z', venue: 'Fixture Arena' },
];

function mkSide(score) {
  const r = (value) => ({ present: true, score: value });
  return {
    team_quality_baseline: r(score),
    recent_form: r(score),
    attacking_strength: r(score),
    defensive_strength: r(score),
    opponent_adjusted_attack: r(score),
    opponent_adjusted_defense: r(score),
    opponent_style_fit: r(score),
    set_piece_matchup: r(score),
    goalkeeper_edge: r(score),
    squad_availability: r(score),
    lineup_strength_delta: r(score),
    rest_travel_venue_climate: r(score),
    tournament_incentive_state: r(score),
    knockout_extra_time_penalty: r(score),
  };
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wc-advances-'));
}

function writeFixtureBank(root, fixture, sourceId) {
  const research = makeEmptyCpcResearchArtifact({
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    match_id: fixture.match_id,
    generated_at: `${DATE}T12:00:00Z`,
    source_id: 'perplexity',
    source_urls: ['https://example.com/worldcup-fixture'],
    source_titles: ['Fixture source'],
    source_freshness: [{ url: 'https://example.com/worldcup-fixture', published_at: `${DATE}T11:00:00Z`, checked_at: `${DATE}T12:00:00Z`, freshness: 'same_day' }],
    confirmed_facts: ['confirmed'],
    unconfirmed_claims: [],
    unavailable_fields: [],
    model_safe_inputs: { lineup_status: 'projected', conditions: 'unknown' },
    editorial_context: { tournament_storyline: 'Fixture storyline' },
    why_this_match_matters: 'Fixture matters.',
    headline_candidates: [`${fixture.home_team} vs ${fixture.away_team}`],
    risk_notes: [],
  });
  const sanitized = sanitizeResearchArtifact(research);
  writeResearchBankArtifacts({
    date: DATE,
    packet_family: sanitized.packet_family,
    packet_type: sanitized.packet_type,
    event_id: `KX-${fixture.match_id}`,
    route: 'worldcup_match',
    submarket: 'match_preview',
    raw: research,
    normalized: research,
    sanitized,
    builderInput: { sanitized_artifact: sanitized },
    previewText: 'banked',
    lineage: {
      generated_at: `${DATE}T12:00:00Z`,
      source_id: sourceId,
      source_urls: research.source_urls,
      source_titles: research.source_titles,
      source_freshness: research.source_freshness,
    },
    root,
  });
}

function writeEloBaseline(root) {
  const discoveryDir = path.join(root, 'worldcup', DATE, 'discovery');
  fs.mkdirSync(discoveryDir, { recursive: true });
  fs.writeFileSync(path.join(discoveryDir, 'elo_baseline.json'), `${JSON.stringify({
    ok: true,
    source_id: 'fixture_elo_baseline',
    retrieved_at: `${DATE}T10:00:00Z`,
    round: 'fixture',
    date: DATE,
    records: [
      { team_name: 'Ivory Coast', team_code: 'CIV', elo_rating: 1668, source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
      { team_name: 'Norway', team_code: 'NOR', elo_rating: 1701, source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
      { team_name: 'France', team_code: 'FRA', elo_rating: 1872, source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
      { team_name: 'Sweden', team_code: 'SWE', elo_rating: 1764, source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
      { team_name: 'Mexico', team_code: 'MEX', elo_rating: 1740, source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
      { team_name: 'Ecuador', team_code: 'ECU', elo_rating: 1712, source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
    ],
  }, null, 2)}\n`, 'utf8');
}

function buildFixture(match, stateRoot, eloBaseline) {
  const homeLedger = composeEvidenceLedgerForGame(mkSide(78), mkSide(61)).home;
  const awayLedger = composeEvidenceLedgerForGame(mkSide(78), mkSide(61)).away;
  const marketContext = parseMarketContract({
    title: `${match.home_team} to advance`,
    homeTeam: match.home_team,
    awayTeam: match.away_team,
  });
  const board = composeMultiLaneCeilingBoard({
    homeLedger,
    awayLedger,
    marketContexts: [marketContext],
    isKnockout: true,
    lineupConfirmed: false,
    match,
    bracket: { stage: match.stage, round: match.round, team_is_home: marketContext.side !== 'away', match_id: match.match_id, next_round: 'next round' },
    eloBaseline,
  });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: DATE, packet_stage: 'morning_board' } });
  const preview = buildPacketPreviewBlock({
    date: DATE,
    packet_family: 'sports',
    packet_type: 'worldcup-match',
    route: 'worldcup_match',
    submarket: 'match_preview',
    event_id: `KX-${match.match_id}`,
    model: {
      ...worldCupModelSummary(match, board),
    },
    root: stateRoot,
  });
  return { match, board, text, preview };
}

export function runAdvancesDryProof() {
  const root = createTempRoot();
  writeEloBaseline(root);
  for (const fixture of FIXTURES) writeFixtureBank(root, fixture, 'fixture_research');

  const baseline = loadCachedEloBaseline(root, DATE);
  const outputs = [];
  for (const fixture of FIXTURES) {
    const board = composeMultiLaneCeilingBoard({
      homeLedger: composeEvidenceLedgerForGame(mkSide(78), mkSide(61)).home,
      awayLedger: composeEvidenceLedgerForGame(mkSide(78), mkSide(61)).away,
      marketContexts: [parseMarketContract({ title: `${fixture.home_team} to advance`, homeTeam: fixture.home_team, awayTeam: fixture.away_team })],
      isKnockout: true,
      lineupConfirmed: false,
      match: fixture,
      bracket: { stage: fixture.stage, round: fixture.round, team_is_home: true, match_id: fixture.match_id, next_round: 'next round' },
      eloBaseline: baseline,
    });
    const lane = board.lanes.find((entry) => entry.lane === 'team_to_advance');
    const adv = lane?.advances ?? null;
    const preview = buildPacketPreviewBlock({
      date: DATE,
      packet_family: 'sports',
      packet_type: 'worldcup-match',
      route: 'worldcup_match',
      submarket: 'match_preview',
      event_id: `KX-${fixture.match_id}`,
      model: {
        ...worldCupModelSummary(fixture, board),
      },
      root,
    });
    const packetText = renderWorldCupPacket({ matches: [fixture], boards: [board], meta: { date: DATE, packet_stage: 'morning_board' } });
    const sportPreview = buildSportsPreview({
      sport: 'worldcup',
      packet_type: 'worldcup-match',
      id: fixture.match_id,
      model: worldCupModelSummary(fixture, board),
      research: preview.fallback ? null : { status: 'ok', source_titles: ['Fixture source'], unavailable_fields: [] },
      generatedAtUtc: `${DATE}T12:00:00Z`,
    });
    outputs.push([
      `Fixture: ${fixture.home_team} vs ${fixture.away_team}`,
      `  market_type: ${lane?.advances?.market_type ?? 'missing'}`,
      `  bracket present: ${Boolean(adv?.bracket).toString()}`,
      `  cached-Elo source: ${baseline.source_id ?? 'missing'}`,
      `  model_mode: ${adv?.model_mode ?? 'missing'}`,
      `  price excluded: ${!String(JSON.stringify(board)).includes('price') && !String(JSON.stringify(board)).includes('odds')}`,
      `  game/day consistent: ${packetText.includes('Advances')}`,
      `  preview consistent: ${sportPreview.text.includes('Market context') || sportPreview.text.includes('MARKET CONTEXT')}`,
      `  p_advance: ${adv?.p_advance ?? 'missing'}`,
    ].join('\n'));
  }
  const output = `Baseline source: ${baseline.source_id ?? 'missing'}\n${outputs.join('\n')}`;
  fs.rmSync(root, { recursive: true, force: true });
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${runAdvancesDryProof()}\n`);
}
