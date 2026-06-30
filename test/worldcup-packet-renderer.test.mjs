import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { renderWorldCupPacket } from '../scripts/worldcup/lib/packet-renderer.mjs';
import { composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';
import { runWorldCupPerplexityResearch } from '../scripts/worldcup/source-adapters/perplexity-research.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATOR = resolve(__dirname, '..', 'scripts/worldcup/generate-matchday-packet.mjs');

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

function writeGeneratorFixture(stateRoot, {
  date = '2026-06-29',
  match = {
    match_id: '400099001',
    home_team: 'France',
    away_team: 'Japan',
    group: 'H',
    stage: 'group',
    round: 1,
    kickoff_utc: '2026-06-29T19:00:00.000Z',
    venue: 'Toronto Stadium',
  },
} = {}) {
  const discoveryDir = join(stateRoot, 'worldcup', date, 'discovery');
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(join(discoveryDir, 'static_structure.json'), `${JSON.stringify({
    ok: true,
    source_id: 'test',
    match_count: 1,
    matches: [match],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(discoveryDir, 'team_baseline.json'), `${JSON.stringify({
    ok: true,
    source_id: 'test',
    team_count: 2,
    teams: [
      {
        team_name: match.home_team,
        quality_score_0_100: 82,
        attack_rating: 81,
        defense_rating: 75,
        style: 66,
        set_piece_rating: 63,
        set_piece_defense: 59,
        goalkeeper_rating: 77,
        chance_quality: 68,
      },
      {
        team_name: match.away_team,
        quality_score_0_100: 68,
        attack_rating: 67,
        defense_rating: 64,
        style: 61,
        set_piece_rating: 58,
        set_piece_defense: 55,
        goalkeeper_rating: 69,
        chance_quality: 60,
      },
    ],
  }, null, 2)}\n`, 'utf8');
}

function runFixtureGeneration({ date = '2026-06-29', matchId = '400099001' } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-gen-'));
  const homeRoot = join(stateRoot, 'home');
  mkdirSync(homeRoot, { recursive: true });
  writeGeneratorFixture(stateRoot, { date, match: {
    match_id: matchId,
    home_team: 'France',
    away_team: 'Japan',
    group: 'H',
    stage: 'group',
    round: 1,
    kickoff_utc: '2026-06-29T19:00:00.000Z',
    venue: 'Toronto Stadium',
  } });
  const result = spawnSync(process.execPath, [
    GENERATOR,
    '--date', date,
    '--match-id', matchId,
    '--packet-stage', 'morning_board',
    '--state-root', stateRoot,
  ], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      HOME: homeRoot,
      PERPLEXITY_API_KEY: '',
      PPLX_API_KEY: '',
    },
    encoding: 'utf8',
  });
  const packetDir = join(stateRoot, 'packets', date, 'worldcup-matchday');
  const packetBase = `worldcup-${date}-morning_board-france-japan`;
  return {
    stateRoot,
    result,
    packetDir,
    packetBase,
    snapshotPath: join(packetDir, `${packetBase}.research.perplexity.json`),
    metaPath: join(packetDir, `${packetBase}.meta.json`),
    sharedResearchPath: join(stateRoot, 'worldcup', date, 'research', 'perplexity_research.json'),
  };
}

test('stale prior baseline blocks customer-ready forecast output globally', () => {
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
      packet_gate: {
        blocked: true,
        reasons: [{
          code: 'CURRENT_TEAM_BASELINE_REQUIRED',
          scope: 'packet',
          detail: 'same-date team baseline for 2026-06-22 is missing; prior baseline from 2026-06-17 is diagnostic only',
          next_artifact: 'state/worldcup/2026-06-22/discovery/team_baseline.json',
        }],
      },
      research: {
        status: 'ok',
        outPath: 'state/worldcup/2026-06-22/research/perplexity_research.json',
        attached_count: 1,
      },
    },
  });

  assert.match(text, /Packet status: BLOCKED — no customer-ready forecast emitted\./);
  assert.match(text, /\[CURRENT_TEAM_BASELINE_REQUIRED\] packet: same-date team baseline for 2026-06-22 is missing; prior baseline from 2026-06-17 is diagnostic only/);
  assert.match(text, /Status: BLOCKED — forecast withheld/);
  assert.match(text, /Packet-local Perplexity snapshot: state\/worldcup\/2026-06-22\/research\/perplexity_research\.json/);
  assert.match(text, /Kickoff: .*C(?:DT|ST).*\/ .*E(?:DT|ST)/);
  assert.match(text, /live context: gathered — Perplexity research/);
  assert.doesNotMatch(text, /Match forecast:/);
  assert.doesNotMatch(text, /Goal forecast:/);
  assert.doesNotMatch(text, /1\. Matchday Forecast/);
  assert.doesNotMatch(text, /\b(?:PICK|LEAN|WATCH|FADE|winner_lean|projection-only|actionable|monitor|top edge candidates|trigger board|overpriced)\b/i);
  assert.doesNotMatch(text, /\blineup_status\b/i);
  assert.doesNotMatch(text, /\boverall_confidence\b/i);
  assert.doesNotMatch(text, /\[null\]/i);
  assert.doesNotMatch(text, /2026-06-22T17:00:00\.000Z/);
});

test('renderWorldCupPacket prefers knockout stage labels over stale group labels', () => {
  const match = {
    match_id: '400021522',
    home_team: 'Netherlands',
    away_team: 'Morocco',
    group: 'Group stage',
    stage: 'round_of_32',
    kickoff_utc: '2026-06-30T01:00:00.000Z',
    venue: 'Monterrey Stadium',
    lineup_status: 'lineup_pending',
  };
  const board = buildBoard(58, 56);
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-29', packet_stage: 'morning_board' },
  });

  assert.match(text, /Match context: Netherlands vs Morocco \[Round of 32\]/);
  assert.match(text, /▶ Netherlands vs Morocco  \[Round of 32\]/);
  assert.doesNotMatch(text, /Netherlands vs Morocco \[Group stage\]/);
});

test('renderWorldCupPacket falls back to sourced live context for missing stage labels', () => {
  const match = {
    match_id: '400021522',
    home_team: 'Netherlands',
    away_team: 'Morocco',
    group: null,
    stage: null,
    kickoff_utc: '2026-06-30T01:00:00.000Z',
    venue: 'Monterrey Stadium',
    lineup_status: 'lineup_pending',
    live_context: {
      status: 'gathered',
      source_id: 'perplexity',
      source_label: 'Perplexity research',
      summary: 'Netherlands face Morocco in the Round of 32 at Monterrey Stadium.',
      citations: ['[1]'],
    },
  };
  const board = buildBoard(58, 56);
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-29', packet_stage: 'morning_board', research: { status: 'ok', attached_count: 1 } },
  });

  assert.match(text, /Match context: Netherlands vs Morocco \[Round of 32\]/);
  assert.match(text, /▶ Netherlands vs Morocco  \[Round of 32\]/);
  assert.doesNotMatch(text, /\[Stage unavailable\]/);
});

test('renderWorldCupPacket uses Stage unavailable when structure stage is missing and no sourced knockout label exists', () => {
  const match = {
    match_id: '400021523',
    home_team: 'France',
    away_team: 'Japan',
    group: null,
    stage: null,
    round: null,
    kickoff_utc: '2026-06-30T01:00:00.000Z',
    venue: 'Toronto Stadium',
    lineup_status: 'lineup_pending',
  };
  const board = buildBoard(58, 56);
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-29', packet_stage: 'morning_board' },
  });

  assert.match(text, /Match context: France vs Japan \[Stage unavailable\]/);
  assert.match(text, /▶ France vs Japan  \[Stage unavailable\]/);
  assert.doesNotMatch(text, /\[Group stage\]/);
});

test('world cup perplexity prompt names knockout stage instead of stale group stage', async () => {
  let capturedPrompt = '';
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-pplx-'));
  try {
    const result = await runWorldCupPerplexityResearch({
      date: '2026-06-29',
      matches: [{
        match_id: '400021522',
        home_team: 'Netherlands',
        away_team: 'Morocco',
        group: 'Group stage',
        stage: 'round_of_32',
        kickoff_utc: '2026-06-30T01:00:00.000Z',
        venue: 'Monterrey Stadium',
      }],
      stateRoot,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      perplexityImpl: ({ messages }) => {
        capturedPrompt = messages.find((message) => message.role === 'user')?.content ?? '';
        return {
          content: '[]',
          citations: [],
        };
      },
    });

    assert.equal(result.ok, true);
    assert.match(capturedPrompt, /stage Round of 32/);
    assert.doesNotMatch(capturedPrompt, /\| group Group stage/);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('world cup perplexity prompt does not invent group stage when structure stage is missing', async () => {
  let capturedPrompt = '';
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-pplx-'));
  try {
    const result = await runWorldCupPerplexityResearch({
      date: '2026-06-29',
      matches: [{
        match_id: '400021522',
        home_team: 'Netherlands',
        away_team: 'Morocco',
        group: null,
        stage: null,
        kickoff_utc: '2026-06-30T01:00:00.000Z',
        venue: 'Monterrey Stadium',
      }],
      stateRoot,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      perplexityImpl: ({ messages }) => {
        capturedPrompt = messages.find((message) => message.role === 'user')?.content ?? '';
        return {
          content: '[]',
          citations: [],
        };
      },
    });

    assert.equal(result.ok, true);
    assert.match(capturedPrompt, /stage unknown/);
    assert.doesNotMatch(capturedPrompt, /stage Group stage/);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('packet-local Perplexity snapshot is written and referenced in meta', () => {
  const run = runFixtureGeneration();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const meta = JSON.parse(readFileSync(run.metaPath, 'utf8'));
    const snapshot = JSON.parse(readFileSync(run.snapshotPath, 'utf8'));
    assert.equal(meta.research.outPath, run.snapshotPath);
    assert.equal(meta.research.sourceOutPath, run.sharedResearchPath);
    assert.equal(snapshot.schema, 'worldcup_perplexity_research_v1');
    assert.equal(snapshot.status, 'PERPLEXITY_UNAVAILABLE');
  } finally {
    rmSync(run.stateRoot, { recursive: true, force: true });
  }
});

test('shared Perplexity file overwrite cannot invalidate packet-local proof', () => {
  const run = runFixtureGeneration();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const originalSnapshot = readFileSync(run.snapshotPath, 'utf8');
    writeFileSync(run.sharedResearchPath, `${JSON.stringify({
      schema: 'worldcup_perplexity_research_v1',
      status: 'ok',
      records: [{ match_id: 'overwritten', summary: 'different artifact' }],
    }, null, 2)}\n`, 'utf8');
    assert.equal(readFileSync(run.snapshotPath, 'utf8'), originalSnapshot);
  } finally {
    rmSync(run.stateRoot, { recursive: true, force: true });
  }
});
