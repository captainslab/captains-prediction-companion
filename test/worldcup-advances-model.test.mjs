import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeEmptyCpcResearchArtifact } from '../scripts/shared/cpc-research-artifact-schema.mjs';
import { sanitizeResearchArtifact } from '../scripts/shared/preview-artifact-sanitizer.mjs';
import { writeResearchBankArtifacts } from '../scripts/shared/cpc-research-bank.mjs';
import { buildPacketPreviewBlock } from '../scripts/shared/cpc-preview-adapter.mjs';
import { buildSportsPreview } from '../scripts/shared/sports-preview-builder.mjs';
import { composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';
import { parseMarketContract } from '../scripts/worldcup/lib/market-parser.mjs';
import {
  eloToLambdas,
  poissonMatrix,
  regulationWDL,
  extraTimePoisson,
  penaltyWin,
  computeAdvance,
} from '../scripts/worldcup/lib/advances-model.mjs';
import {
  buildEloBaselineFetchPrompt,
  buildSoftLayerFetchPrompt,
} from '../scripts/worldcup/lib/advances-perplexity-prompts.mjs';
import { backtestAdvances } from '../scripts/worldcup/lib/advances-backtest.mjs';
import { loadCachedEloBaseline } from '../scripts/worldcup/lib/elo-baseline.mjs';
import { renderWorldCupPacket, worldCupModelSummary } from '../scripts/worldcup/lib/packet-renderer.mjs';
import { runAdvancesDryProof } from '../scripts/worldcup/lib/advances-dry-proof.mjs';

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

function buildBaselineRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-advances-test-'));
  const discovery = path.join(root, 'worldcup', DATE, 'discovery');
  fs.mkdirSync(discovery, { recursive: true });
  fs.writeFileSync(path.join(discovery, 'elo_baseline.json'), `${JSON.stringify({
    ok: true,
    source_id: 'fixture_elo_baseline',
    retrieved_at: `${DATE}T10:00:00Z`,
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
  return root;
}

function buildResearchBank(root, match) {
  const raw = makeEmptyCpcResearchArtifact({
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    match_id: match.match_id,
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
    headline_candidates: [`${match.home_team} vs ${match.away_team}`],
    risk_notes: [],
  });
  const sanitized = sanitizeResearchArtifact(raw);
  writeResearchBankArtifacts({
    date: DATE,
    packet_family: sanitized.packet_family,
    packet_type: sanitized.packet_type,
    event_id: `KX-${match.match_id}`,
    route: 'worldcup_match',
    submarket: 'match_preview',
    raw,
    normalized: raw,
    sanitized,
    builderInput: { sanitized_artifact: sanitized },
    previewText: 'banked',
    lineage: {
      generated_at: `${DATE}T12:00:00Z`,
      source_id: 'fixture_research',
      source_urls: raw.source_urls,
      source_titles: raw.source_titles,
      source_freshness: raw.source_freshness,
    },
    root,
  });
}

function buildBoard(match, eloBaseline, {
  lineupConfirmed = false,
  marketTitle = `${match.home_team} to advance`,
  teamIsHome = true,
  marketContextExtras = {},
} = {}) {
  const ledger = composeEvidenceLedgerForGame(mkSide(78), mkSide(61));
  const marketContext = {
    ...parseMarketContract({
      title: marketTitle,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
    }),
    ...marketContextExtras,
  };
  return composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [marketContext],
    isKnockout: true,
    lineupConfirmed,
    match,
    bracket: {
      stage: match.stage,
      round: match.round,
      next_round: 'next round',
      match_id: match.match_id,
      team_is_home: teamIsHome,
    },
    eloBaseline,
  });
}

function approxEqual(a, b, tol = 0.001) {
  return Math.abs(a - b) <= tol;
}

test('team advances market routes to worldcup_advances and settles including extra time and penalties', () => {
  const ctx = parseMarketContract({ title: 'France to advance', homeTeam: 'France', awayTeam: 'Sweden' });
  assert.equal(ctx.market_family, 'to_advance');
  assert.equal(ctx.market_type, 'team_to_advance');
  assert.equal(ctx.settlement.scope, 'includes_penalties');
  assert.equal(ctx.market_type, 'team_to_advance');
  assert.notEqual(ctx.market_type, 'match_winner');
});

test('computeAdvance uses Elo -> Poisson, counts ET and penalties, and matches the advance derivation', () => {
  const adv = computeAdvance({
    eloTeam: 1872,
    eloOpp: 1764,
    bracket: { stage: 'quarter_final', round: 5, team_is_home: true, match_id: 'fixture-1' },
    lineup: { confirmed: false },
    evidence: { source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
  });
  const mapped = eloToLambdas(1872, 1764);
  assert.equal(mapped.ok, true);
  const matrix = poissonMatrix(adv.lambdas.home, adv.lambdas.away);
  const reg = regulationWDL(matrix.matrix, true);
  const et = extraTimePoisson(adv.lambdas.team, adv.lambdas.opp);
  assert.equal(adv.status, 'READY');
  assert.equal(adv.lambdas.team, mapped.lambdaTeam);
  assert.ok(reg.pDraw > 0, 'regulation draw must be counted, not treated as failure');
  assert.ok(et.etDraw > 0, 'extra time draw must flow into penalties');
  const expected = reg.pWin + (reg.pDraw * (et.etWin + (et.etDraw * adv.pen.penWin)));
  assert.ok(approxEqual(adv.p_advance, expected), `p_advance ${adv.p_advance} should match ${expected}`);
  assert.equal(adv.model_mode, 'BASELINE_ELO_POISSON_NO_PLAYER_ADJUSTMENT');
  assert.ok(adv.limitations.some((line) => /No confirmed lineup/.test(line)));
});

test('computeAdvance blocks or researches missing Elo or missing bracket context', () => {
  const missingElo = computeAdvance({
    eloTeam: null,
    eloOpp: 1764,
    bracket: { stage: 'quarter_final', round: 5, team_is_home: true },
  });
  assert.equal(missingElo.status, 'BLOCKED');
  assert.deepEqual(missingElo.missing_inputs, ['eloTeam']);
  assert.equal(missingElo.p_advance, null);
  assert.equal(missingElo.lean, null);

  const missingBracket = computeAdvance({
    eloTeam: 1872,
    eloOpp: 1764,
  });
  assert.equal(missingBracket.status, 'RESEARCH_ONLY');
  assert.deepEqual(missingBracket.missing_inputs, ['bracket_context']);
  assert.equal(missingBracket.p_advance, null);
  assert.equal(missingBracket.lean, null);
});

test('penaltyWin clamps by default and widens only with cited strong keeper/taker evidence', () => {
  assert.equal(penaltyWin({}).penWin, 0.5);
  assert.equal(penaltyWin({ evidence: { penaltyWin: 0.57 } }).penWin, 0.53);
  assert.equal(penaltyWin({ evidence: { penaltyWin: 0.43 } }).penWin, 0.47);
  assert.equal(
    penaltyWin({ evidence: { penaltyWin: 0.56, strongKeeperTakerEvidence: { source: 'FIFA technical report' } } }).penWin,
    0.55,
  );
  assert.equal(
    penaltyWin({ evidence: { penaltyWin: 0.44, strongKeeperTakerEvidence: { source: 'FIFA technical report' } } }).penWin,
    0.45,
  );
});

test('prompt builders are JSON-only, null-on-unknown, and forbid authoring ratings or probabilities', () => {
  const eloPrompt = buildEloBaselineFetchPrompt({
    teams: [
      { team_name: 'France', team_code: 'FRA' },
      { team_name: 'Sweden', team_code: 'SWE' },
    ],
  });
  assert.match(eloPrompt.system, /JSON object only/);
  assert.match(eloPrompt.user, /null on unknown/i);
  assert.match(eloPrompt.user, /Do not estimate, infer, or synthesize Elo values/i);
  assert.match(JSON.stringify(eloPrompt.output_schema), /published_elo/);
  assert.match(JSON.stringify(eloPrompt.output_schema), /source/);
  assert.match(JSON.stringify(eloPrompt.output_schema), /retrieved_at/);
  assert.doesNotMatch(eloPrompt.user, /\bprobabilities?\b/i);
  assert.doesNotMatch(eloPrompt.user, /\bodds?\b/i);

  const softPrompt = buildSoftLayerFetchPrompt({
    match: { match_id: 'fixture-1', home_team: 'France', away_team: 'Sweden', kickoff_utc: `${DATE}T19:00:00Z`, stage: 'quarter_final' },
  });
  assert.match(softPrompt.system, /CONFIRMED, PROJECTED, STALE, or UNKNOWN/);
  assert.match(softPrompt.user, /Null on unknown/i);
  assert.match(JSON.stringify(softPrompt.output_schema), /tag/);
  assert.doesNotMatch(softPrompt.user, /\bprice\b/i);
  assert.doesNotMatch(softPrompt.user, /\bodds?\b/i);
});

test('price, odds, and volume-shaped inputs cannot move the advances model or board routing', () => {
  const clean = computeAdvance({
    eloTeam: 1872,
    eloOpp: 1764,
    bracket: { stage: 'quarter_final', round: 5, team_is_home: true, match_id: 'fixture-1' },
    lineup: { confirmed: false },
    evidence: { source: 'fixture_elo_baseline', retrieved_at: `${DATE}T10:00:00Z` },
  });
  const dirty = computeAdvance({
    eloTeam: 1872,
    eloOpp: 1764,
    bracket: { stage: 'quarter_final', round: 5, team_is_home: true, match_id: 'fixture-1' },
    lineup: { confirmed: false },
    evidence: {
      source: 'fixture_elo_baseline',
      retrieved_at: `${DATE}T10:00:00Z`,
      price: 0.88,
      odds: -120,
      volume: 12000,
      open_interest: 3200,
      movement: 'up',
    },
  });
  assert.equal(dirty.p_advance, clean.p_advance);
  assert.equal(dirty.status, clean.status);
  assert.deepEqual(dirty.reg, clean.reg);

  const root = buildBaselineRoot();
  const eloBaseline = loadCachedEloBaseline(root, DATE);
  const match = FIXTURES[1];
  const cleanBoard = buildBoard(match, eloBaseline, { lineupConfirmed: false, marketTitle: 'France to advance', teamIsHome: true });
  const dirtyBoard = buildBoard(match, eloBaseline, {
    lineupConfirmed: false,
    marketTitle: 'France to advance',
    teamIsHome: true,
    marketContextExtras: {
      price: 0.88,
      odds: -120,
      volume: 12000,
      open_interest: 3200,
      movement: 'up',
    },
  });
  assert.equal(cleanBoard.advances.p_advance, dirtyBoard.advances.p_advance);
  assert.equal(cleanBoard.lanes.find((lane) => lane.lane === 'team_to_advance').recommendation, dirtyBoard.lanes.find((lane) => lane.lane === 'team_to_advance').recommendation);
  fs.rmSync(root, { recursive: true, force: true });
});

test('game pack, day pack, and daily preview all read the same board advances artifact', () => {
  const root = buildBaselineRoot();
  for (const match of FIXTURES) buildResearchBank(root, match);
  const eloBaseline = loadCachedEloBaseline(root, DATE);
  const match = FIXTURES[1];
  const board = buildBoard(match, eloBaseline, { lineupConfirmed: false, marketTitle: 'France to advance', teamIsHome: true });
  const summary = worldCupModelSummary(match, board);
  const packetText = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: DATE, packet_stage: 'morning_board' },
  });
  const preview = buildSportsPreview({
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    id: match.match_id,
    model: summary,
    research: { status: 'ok', source_titles: ['Fixture source'], unavailable_fields: [] },
    generatedAtUtc: `${DATE}T12:00:00Z`,
  });
  const bankPreview = buildPacketPreviewBlock({
    date: DATE,
    packet_family: 'sports',
    packet_type: 'worldcup-match',
    route: 'worldcup_match',
    submarket: 'match_preview',
    event_id: `KX-${match.match_id}`,
    model: summary,
    root,
  });

  const shared = board.advances.p_advance;
  assert.ok(shared > 0);
  assert.match(packetText, new RegExp(`Advances forecast: .*${Math.round(shared * 100)}%`));
  assert.match(preview.text, /Advances:/);
  assert.match(preview.text, /MARKET CONTEXT — DISPLAY ONLY \/ NOT IN SCORE/);
  assert.match(bankPreview.text, /MARKET CONTEXT — DISPLAY ONLY \/ NOT IN SCORE/);
  assert.match(bankPreview.text, /Advances:/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('backtest helper returns a provisional calibration summary', () => {
  const backtest = backtestAdvances([
    {
      match_id: 'fixture-1',
      team_name: 'France',
      opp_name: 'Sweden',
      eloTeam: 1872,
      eloOpp: 1764,
      bracket: { stage: 'quarter_final', round: 5, team_is_home: true, match_id: 'fixture-1' },
      advanced: true,
    },
    {
      match_id: 'fixture-2',
      team_name: 'Mexico',
      opp_name: 'Ecuador',
      eloTeam: 1740,
      eloOpp: 1712,
      bracket: { stage: 'semi_final', round: 6, team_is_home: true, match_id: 'fixture-2' },
      advanced: false,
    },
  ]);
  assert.equal(backtest.calibration_status, 'V1_PROVISIONAL');
  assert.equal(backtest.sample_size, 2);
  assert.ok(backtest.brier_score >= 0);
  assert.ok(backtest.buckets.length > 0);
});

test('dry proof prints the three fixture matchups and the shared advances fields', () => {
  const out = runAdvancesDryProof();
  assert.match(out, /Baseline source: fixture_elo_baseline/);
  for (const fixture of FIXTURES) {
    assert.match(out, new RegExp(`Fixture: ${fixture.home_team} vs ${fixture.away_team}`));
  }
  assert.match(out, /market_type: worldcup_advances/);
  assert.match(out, /model_mode: BASELINE_ELO_POISSON_NO_PLAYER_ADJUSTMENT/);
  assert.match(out, /price excluded: true/);
});
