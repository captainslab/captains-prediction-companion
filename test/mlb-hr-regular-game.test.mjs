import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  FEATURE_NAMES,
  REGULAR_GAME_MODEL_SCHEMA,
  buildHistoricalFeatureRows,
  buildGameHrProjections,
  buildRegularGamePrediction,
  evaluateProbabilities,
  loadRegularGameModel,
  materializeFeatureVector,
  matchBatterEvidence,
  splitChronologically,
} from '../scripts/mlb/hr-engine/regular-game-model.mjs';
import {
  ingestStatcastSeason,
  readCachedTerminalRows,
} from '../scripts/mlb/hr-engine/statcast-ingest.mjs';
import {
  buildRegularGamePacketArtifacts,
  renderRegularGamePacket,
} from '../scripts/mlb/hr-engine/regular-game-packet.mjs';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';
import { buildGameProjections, loadStatsRecords } from '../scripts/mlb/lib/projection-engine.mjs';
import { buildMarketFamilyCoverage } from '../scripts/mlb/lib/market-engine.mjs';
import { generateRegularGameArtifacts } from '../scripts/mlb/hr-engine/generate-regular-game.mjs';

function stats({ pa = 0, hr = 0, bip = 0, barrel = 0, hard_hit = 0, fly_ball = 0, pull_air = 0, ev = [] } = {}) {
  return {
    pa, hr, bip, barrel, hard_hit, fly_ball, pull_air,
    ev_count: ev.length,
    ev_sum: ev.reduce((sum, value) => sum + value, 0),
    ev_sum_sq: ev.reduce((sum, value) => sum + value * value, 0),
  };
}

function profile({ pa = 120, hr = 5 } = {}) {
  return {
    '7d': stats({ pa: 18, hr: 1, bip: 12, barrel: 2, hard_hit: 6, fly_ball: 5, pull_air: 3, ev: [88, 94, 101] }),
    '30d': stats({ pa: 70, hr: 3, bip: 45, barrel: 7, hard_hit: 22, fly_ball: 18, pull_air: 9, ev: [88, 90, 94, 98, 102] }),
    season: stats({ pa, hr, bip: Math.round(pa * 0.65), barrel: 12, hard_hit: 40, fly_ball: 32, pull_air: 18, ev: [88, 92, 96, 101] }),
  };
}

function fakeModel() {
  return {
    schema_version: REGULAR_GAME_MODEL_SCHEMA,
    generated_utc: '2026-07-13T00:00:00.000Z',
    data: { league_reference_hr_pa: 0.03089 },
    hyperparameters: { prior_strength: 64 },
    model: {
      feature_names: [...FEATURE_NAMES],
      intercept: Math.log(0.035 / 0.965),
      coefficients: FEATURE_NAMES.map(() => 0),
      standardization: { means: FEATURE_NAMES.map(() => 0), scales: FEATURE_NAMES.map(() => 1) },
      calibration: null,
    },
    opportunity_model: {
      by_lineup_slot: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1), {
        expected_pa: index < 3 ? 4.55 : 4.1,
        rounded_pa_for_simulation: index < 3 ? 5 : 4,
        batter_games: 100,
      }])),
    },
    evaluation: { calibration_claim_supported: false },
    profiles: { batters: {}, pitchers: {}, parks: {} },
  };
}

function readyInputs() {
  return {
    model: fakeModel(),
    player: { mlb_id: 101, player_name: 'Power Hitter', lineup_slot: 2, side: 'away' },
    candidates: [{
      batter_id: 101,
      player_name: 'Power Hitter',
      stand: 'L',
      lineup_slot: 2,
      latest_event_date: '2026-07-12',
      windows: profile(),
    }],
    pitcher: { mlb_id: 202, p_throws: 'R', latest_event_date: '2026-07-11', windows: profile({ pa: 300, hr: 8 }) },
    park: { id: 'BOS', windows: profile({ pa: 1000, hr: 35 }), roof: 'open' },
    weather: { temperature_f: 78, wind_out_mph: 6, directional_fit: 0.7 },
    lineup_status: 'confirmed',
    seed: 'regular-game-test',
    simulations: 2_000,
    as_of: '2026-07-13T00:00:00.000Z',
  };
}

test('day-chunk ingest keeps only shared-predicate terminal rows and resumes without refetching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cpc-hr-ingest-'));
  let fetches = 0;
  const csv = [
    '"game_date","game_type","game_pk","at_bat_number","batter","pitcher","player_name","events","stand","p_throws","home_team","away_team"',
    '"2025-04-01","R","1","1","101","201","Hitter, Test","","L","R","BOS","NYY"',
    '"2025-04-01","R","1","1","101","201","Hitter, Test","","L","R","BOS","NYY"',
    '"2025-04-01","R","1","1","101","201","Hitter, Test","home_run","L","R","BOS","NYY"',
  ].join('\n');
  const fetchImpl = async () => {
    fetches += 1;
    return { ok: true, status: 200, text: async () => csv };
  };
  try {
    const first = await ingestStatcastSeason({
      season: 2025, start: '2025-04-01', end: '2025-04-01', cacheDir: root,
      concurrency: 1, delayMs: 0, retries: 0, fetchImpl,
      now: () => '2026-07-13T00:00:00.000Z',
    });
    assert.equal(first.summary.terminal_pa, 1);
    assert.equal(first.summary.home_runs, 1);
    assert.equal(fetches, 1);
    await ingestStatcastSeason({
      season: 2025, start: '2025-04-01', end: '2025-04-01', cacheDir: root,
      concurrency: 1, delayMs: 0, retries: 0,
      fetchImpl: async () => { throw new Error('cached day must not refetch'); },
      now: () => '2026-07-13T00:00:00.000Z',
    });
    const cached = readCachedTerminalRows({ cacheDir: root, season: 2025, start: '2025-04-01', end: '2025-04-01' });
    assert.equal(cached.rows.length, 1);
    assert.equal(cached.rows[0].events, 'home_run');
    assert.equal(readFileSync(join(root, '2025', '2025-04-01.json'), 'utf8').includes('Hitter, Test'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empirical-Bayes shrinkage pulls a 1-for-12 batter toward league HR/PA', () => {
  const raw = {
    batter: { '7d': stats(), '30d': stats(), season: stats({ pa: 12, hr: 1 }) },
    pitcher: { season: stats({ pa: 100, hr: 3 }) },
    park: { season: stats({ pa: 1000, hr: 31 }) },
    league: { '30d': stats({ pa: 1000, hr: 31, bip: 700, barrel: 50, hard_hit: 250, fly_ball: 200, pull_air: 100 }), season: stats() },
    league_rate: 0.03089,
    stand: 'R', p_throws: 'R',
    context: { roof: null, altitude: null, temperature: null, wind_out: null, directional_fit: null },
  };
  const values = materializeFeatureVector(raw, { priorStrength: 64 });
  const shrunk = values[FEATURE_NAMES.indexOf('batter_hr_pa_season')];
  assert.ok(shrunk < 0.05, `expected strong shrinkage, got ${shrunk}`);
  assert.ok(shrunk > 0.03089);
  assert.notEqual(shrunk, 1 / 12);
});

test('chronological split keeps every test date later than train and validation', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    date: `2025-04-${String(index + 1).padStart(2, '0')}`,
    label: index % 9 === 0 ? 1 : 0,
  }));
  const split = splitChronologically(rows);
  assert.ok(split.train.at(-1).date < split.validation[0].date);
  assert.ok(split.validation.at(-1).date < split.test[0].date);
  assert.ok(split.test.every((row) => row.date > split.train.at(-1).date));
});

test('pregame feature windows do not absorb outcomes from the same slate date', () => {
  const rows = [
    { game_date: '2025-04-01', game_pk: 1, at_bat_number: 1, batter: 101, pitcher: 201, home_team: 'BOS', away_team: 'NYY', inning_topbot: 'Top', events: 'home_run', stand: 'L', p_throws: 'R' },
    { game_date: '2025-04-01', game_pk: 1, at_bat_number: 10, batter: 101, pitcher: 201, home_team: 'BOS', away_team: 'NYY', inning_topbot: 'Top', events: 'field_out', stand: 'L', p_throws: 'R' },
    { game_date: '2025-04-02', game_pk: 2, at_bat_number: 1, batter: 101, pitcher: 202, home_team: 'BOS', away_team: 'NYY', inning_topbot: 'Top', events: 'field_out', stand: 'L', p_throws: 'R' },
  ];
  const historical = buildHistoricalFeatureRows(rows);
  assert.equal(historical.featureRows[0].batter.season.pa, 0);
  assert.equal(historical.featureRows[1].batter.season.pa, 0);
  assert.equal(historical.featureRows[2].batter.season.pa, 2);
  assert.equal(historical.featureRows[2].batter.season.hr, 1);
});

test('missing context is represented by explicit indicators and zero sentinels', () => {
  const raw = {
    batter: { '7d': stats(), '30d': stats(), season: stats() },
    pitcher: { season: stats() }, park: { season: stats() },
    league: { '30d': stats(), season: stats() }, league_rate: 0.03089,
    stand: null, p_throws: null,
    context: { roof: null, altitude: null, temperature: null, wind_out: null, directional_fit: null },
  };
  const values = materializeFeatureVector(raw, { priorStrength: 64 });
  for (const name of ['roof_missing', 'altitude_missing', 'temperature_missing', 'wind_missing', 'directional_fit_missing', 'handedness_missing']) {
    assert.equal(values[FEATURE_NAMES.indexOf(name)], 1, name);
  }
  assert.equal(values[FEATURE_NAMES.indexOf('temperature_f')], 0);
});

test('identity is MLB-ID-first and ambiguous name fallback fails closed', () => {
  const candidates = [
    { batter_id: 1, player_name: 'José Ramírez' },
    { batter_id: 2, player_name: 'Jose Ramirez' },
  ];
  assert.equal(matchBatterEvidence({ mlb_id: 2, player_name: 'Wrong Name' }, candidates).candidate.batter_id, 2);
  const ambiguous = matchBatterEvidence({ player_name: 'Jose Ramirez' }, candidates);
  assert.equal(ambiguous.status, 'blocked');
  assert.equal(ambiguous.reason, 'AMBIGUOUS_NAME_MATCH');
});

test('fixed seed is deterministic and market mutations are byte-neutral', () => {
  const clean = buildRegularGamePrediction(readyInputs());
  const pollutedInput = structuredClone(readyInputs());
  pollutedInput.yes_ask = 88;
  pollutedInput.player.implied_probability = 0.88;
  pollutedInput.candidates[0].moneyline_odds = -150;
  pollutedInput.pitcher.open_interest = 999;
  pollutedInput.park.volume = 5000;
  pollutedInput.weather.bid = 42;
  const polluted = buildRegularGamePrediction(pollutedInput);
  assert.equal(JSON.stringify(polluted), JSON.stringify(clean));
  assert.equal(clean.status, 'ready');
  assert.equal(clean.outputs.expected_pa, 4.55);
  assert.equal(clean.outputs.simulation_plate_appearances, 5);
  assert.ok(Math.abs(clean.outputs.probability_at_least_one_hr - (1 - (1 - clean.outputs.per_pa_probability) ** 4.55)) < 1e-12);
  assert.ok(Math.abs(clean.outputs.expected_home_runs - clean.outputs.per_pa_probability * 4.55) < 1e-12);
  const sum = Object.values(clean.outputs.home_run_distribution).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

test('missing and ambiguous players remain MODEL_INSUFFICIENT', () => {
  const input = readyInputs();
  input.player = { player_name: 'Duplicate Name', lineup_slot: 1 };
  input.candidates = [
    { batter_id: 1, player_name: 'Duplicate Name', windows: profile() },
    { batter_id: 2, player_name: 'Duplicate Name', windows: profile() },
  ];
  const projection = buildRegularGamePrediction(input);
  assert.equal(projection.status, 'blocked');
  assert.equal(projection.model_status, 'MODEL_INSUFFICIENT');
  assert.ok(projection.blocked_reasons.includes('AMBIGUOUS_NAME_MATCH'));
});

test('malformed model artifacts and stale batter profiles fail closed', () => {
  const malformed = readyInputs();
  malformed.model = { schema_version: REGULAR_GAME_MODEL_SCHEMA };
  const invalidProjection = buildRegularGamePrediction(malformed);
  assert.equal(invalidProjection.status, 'blocked');
  assert.deepEqual(invalidProjection.blocked_reasons, ['MODEL_ARTIFACT_MISSING_OR_INVALID']);

  const stale = readyInputs();
  stale.candidates[0].latest_event_date = '2025-09-28';
  const staleProjection = buildRegularGamePrediction(stale);
  assert.equal(staleProjection.status, 'blocked');
  assert.ok(staleProjection.blocked_reasons.includes('BATTER_PROFILE_STALE'));

  const stalePitcher = readyInputs();
  stalePitcher.pitcher.latest_event_date = '2025-09-28';
  const stalePitcherProjection = buildRegularGamePrediction(stalePitcher);
  assert.equal(stalePitcherProjection.status, 'blocked');
  assert.ok(stalePitcherProjection.blocked_reasons.includes('STARTING_PITCHER_PROFILE_STALE'));
});

test('missing team side blocks instead of guessing the opposing pitcher', () => {
  const input = readyInputs();
  delete input.player.side;
  const projection = buildGameHrProjections({
    model: input.model,
    batters: [input.player],
    evidence: input.candidates,
    opposing_pitchers: { home: input.pitcher, away: input.pitcher },
    park: input.park,
    weather: input.weather,
    lineup_status: input.lineup_status,
    as_of: input.as_of,
  });
  assert.equal(projection.status, 'blocked');
  assert.ok(projection.blocked_reasons.includes('TEAM_SIDE_MISSING'));
});

test('regular-game packet validates, rerenders from JSON exactly, and carries audit artifacts', () => {
  const input = readyInputs();
  const gameProjection = buildGameHrProjections({
    model: input.model,
    batters: [input.player],
    evidence: input.candidates,
    opposing_pitchers: { home: input.pitcher, away: input.pitcher },
    park: input.park,
    weather: input.weather,
    lineup_status: 'confirmed',
    seed: 'packet-seed',
    simulations: 2_000,
  });
  const game = { game_id: 'NYYBOS-20260713', date: '2026-07-13', away_team: 'NYY', home_team: 'BOS' };
  const generatedUtc = '2026-07-13T00:00:00.000Z';
  const artifacts = buildRegularGamePacketArtifacts({ game, projection: gameProjection, generatedUtc });
  assert.equal(validateCpcCustomerPacket(artifacts.packetText).valid, true);
  assert.equal(renderRegularGamePacket({ game, projection: JSON.parse(JSON.stringify(gameProjection)), generatedUtc }), artifacts.packetText);
  assert.equal(artifacts.audit.json_txt_parity, 'packet text is rendered exclusively from the projection object');
  assert.equal(artifacts.assumptionsLedger.items.length, 1);
  assert.match(artifacts.inventoryText, /any_hr=/);
});

test('buildGameProjections replaces hr=null while leaving missing batter evidence fail-closed', () => {
  const record = {
    game_pk: 1, game_date: '2026-07-13', away_team: 'NYY', home_team: 'BOS',
    away_team_abbrev: 'NYY', home_team_abbrev: 'BOS', venue: 'Fenway Park',
    away_team_stats: { runs_scored: 400, runs_allowed: 380, gamesPlayed: 90 },
    home_team_stats: { runs_scored: 420, runs_allowed: 390, gamesPlayed: 90 },
    away_pitcher: { mlb_id: 201, era: 3.5, k_pct: 0.24, games_started: 18, batters_faced: 430 },
    home_pitcher: { mlb_id: 202, era: 3.8, k_pct: 0.22, games_started: 18, batters_faced: 420 },
    away_bullpen: { era: 4.1 }, home_bullpen: { era: 4.0 },
  };
  const missing = buildGameProjections({ record, leagueRPG: 4.4, lineup_status: 'confirmed', hr_model: fakeModel() });
  assert.notEqual(missing.hr, null);
  assert.equal(missing.hr.model_status, 'MODEL_INSUFFICIENT');
  const ready = readyInputs();
  const modeled = buildGameProjections({
    record: { ...record, home_pitcher: ready.pitcher, hr_park: ready.park, hr_batters: [ready.player], hr_evidence: ready.candidates },
    leagueRPG: 4.4,
    lineup_status: 'confirmed',
    hr_model: ready.model,
    hr_seed: 'projection-engine-test',
    hr_simulations: 2_000,
  });
  assert.equal(modeled.hr.status, 'ready');
  assert.equal(modeled.hr.outputs[0].status, 'ready');
});

test('stats loader joins confirmed MLB-ID batting orders from the context adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'cpc-hr-context-'));
  const discovery = join(root, 'mlb', '2026-07-13', 'discovery');
  mkdirSync(discovery, { recursive: true });
  try {
    writeFileSync(join(discovery, 'stats_adapter.json'), JSON.stringify({ records: [{
      game_pk: 77, away_team: 'New York Yankees', home_team: 'Boston Red Sox',
      away_team_abbrev: 'NYY', home_team_abbrev: 'BOS',
    }] }));
    writeFileSync(join(discovery, 'context_adapter.json'), JSON.stringify({ records: [{
      game_pk: 77, source_id: 'lineup_injury_bullpen', lineup_status: 'confirmed_or_boxscore_available',
      away_batting_order: ['1', '2', '3'], home_batting_order: ['10', '11', '12'],
    }] }));
    const [record] = loadStatsRecords(root, '2026-07-13');
    assert.equal(record.lineup_status, 'confirmed');
    assert.deepEqual(record.hr_batters.map((player) => [player.mlb_id, player.lineup_slot, player.side]), [
      ['1', 1, 'away'], ['2', 2, 'away'], ['3', 3, 'away'],
      ['10', 1, 'home'], ['11', 2, 'home'], ['12', 3, 'home'],
    ]);
    assert.deepEqual(record.hr_evidence, record.hr_batters);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ready HR projection promotes the HR family without reading the board', () => {
  const input = readyInputs();
  const hr = buildGameHrProjections({
    model: input.model,
    batters: [input.player],
    evidence: input.candidates,
    opposing_pitchers: { home: input.pitcher, away: input.pitcher },
    park: input.park,
    weather: input.weather,
    lineup_status: 'confirmed',
    seed: 'family-coverage',
    simulations: 1_000,
  });
  const game = {
    series: {
      ml: { markets: [] }, spread: { markets: [] }, total: { markets: [] },
      rfi: { markets: [] }, ks: { markets: [] },
      hr: { markets: [{ yes_ask: 99, volume: 999_999 }] },
    },
  };
  const coverage = buildMarketFamilyCoverage(game, { final: { projections: { hr } } });
  assert.equal(coverage.families.hr.modeled, true);
  assert.equal(coverage.families.hr.board_only, false);
  assert.match(coverage.families.hr.detail, /fitted per-PA model/);
  assert.doesNotMatch(coverage.families.hr.detail, /99|999999/);
});

test('repeated regular-game artifact generation is byte-identical', () => {
  const root = mkdtempSync(join(tmpdir(), 'cpc-hr-generate-'));
  const modelPath = join(root, 'model.json');
  const first = join(root, 'first');
  const second = join(root, 'second');
  const base = readyInputs();
  const input = {
    game: { game_id: '1', date: '2026-07-13', away_team: 'NYY', home_team: 'BOS' },
    batters: [base.player], evidence: base.candidates,
    opposing_pitchers: { home: base.pitcher, away: base.pitcher },
    park: base.park, weather: base.weather, lineup_status: 'confirmed',
  };
  try {
    writeFileSync(modelPath, JSON.stringify(base.model));
    const args = {
      modelPath, input, generatedUtc: '2026-07-13T00:00:00.000Z',
      seed: 'byte-identical', simulations: 1_000,
    };
    generateRegularGameArtifacts({ ...args, outputDir: first });
    generateRegularGameArtifacts({ ...args, outputDir: second });
    assert.deepEqual(readdirSync(first).sort(), readdirSync(second).sort());
    for (const name of readdirSync(first)) {
      assert.equal(readFileSync(join(first, name), 'utf8'), readFileSync(join(second, name), 'utf8'), name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('constant baseline calibration keeps tied probabilities in one honest bucket', () => {
  const metrics = evaluateProbabilities([0.03, 0.03, 0.03, 0.03], [0, 1, 0, 0]);
  assert.equal(metrics.calibration.length, 1);
  assert.equal(metrics.calibration[0].observed_hr_rate, 0.25);
  assert.equal(metrics.expected_calibration_error, 0.22);
});

test('committed held-out artifact beats baseline and supports its calibration wording', () => {
  const model = loadRegularGameModel(join(process.cwd(), 'scripts/mlb/hr-engine/artifacts/regular-game-model-2025.json'));
  assert.equal(model.data.terminal_pa, 183245);
  assert.equal(model.data.home_runs, 5650);
  assert.equal(model.data.official_reference.terminal_row_delta, 319);
  assert.ok(model.data.chronological_split.train.end < model.data.chronological_split.validation.start);
  assert.ok(model.data.chronological_split.validation.end < model.data.chronological_split.test.start);
  assert.equal(model.evaluation.beats_baseline_brier_and_log_loss, true);
  assert.equal(model.evaluation.calibration_claim_supported, true);
  assert.ok(model.evaluation.model.brier_score < model.evaluation.league_base_rate_baseline.brier_score);
  assert.ok(model.evaluation.model.log_loss < model.evaluation.league_base_rate_baseline.log_loss);
  assert.equal(model.evaluation.league_base_rate_baseline.probability, 0.03089);
  assert.ok(model.evaluation.model.mean_prediction > 0.02 && model.evaluation.model.mean_prediction < 0.05);
  assert.ok(model.model.coefficients.some((coefficient) => coefficient !== 0));
  assert.equal(model.evaluation.league_base_rate_baseline.calibration.length, 1);
});
