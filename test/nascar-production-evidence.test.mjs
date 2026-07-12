import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildNascarProductionEvidence,
  persistNascarProductionArtifacts,
} from '../scripts/nascar/lib/production-evidence.mjs';
import { buildNascarRows } from '../scripts/packets/generate-nascar-sunday.mjs';
import { normalizeNascarDriverName } from '../scripts/nascar/lib/driver-name.mjs';

const DATE = '2026-07-12';
const CHECKED = '2026-07-12T20:37:32.139Z';
const DRIVERS = [
  'Ryan Blaney', 'Joey Logano', 'Kyle Larson', 'Austin Dillon', 'Daniel Suarez',
  'Alex Bowman', 'Chase Elliott', 'Austin Cindric', 'Ross Chastain', 'Brad Keselowski',
  'Erik Jones', 'Shane Van Gisbergen', 'Chris Buescher', 'Carson Hocevar', 'Ricky Stenhouse Jr',
  'Ty Dillon', 'Josh Berry', 'Michael McDowell', 'Ryan Preece', 'Chase Briscoe',
  'Todd Gilliland', 'Bubba Wallace', 'Ty Gibbs', 'John H. Nemechek', 'Connor Zilisch',
  'William Byron', 'AJ Allmendinger', 'Denny Hamlin', 'Riley Herbst', 'Austin Hill',
  'Tyler Reddick', 'Christopher Bell', 'Cole Custer', 'Zane Smith', 'Cody Ware',
  'Noah Gragson', 'BJ McLeod', 'Chad Finchum',
];

function inputs(priceSeed = 0) {
  const sourceUrls = [
    'https://cf.nascar.com/cacher/2026/race_list_basic.json',
    'https://cf.nascar.com/cacher/2026/1/5615/weekend-feed.json',
  ];
  const officialEnvelope = {
    source_id: 'nascar_official', status: 'ok', checked_at_utc: CHECKED, source_urls: sourceUrls,
    records: [{
      race_id: 5615, track_id: 111, series_id: 1,
      race_name: 'Quaker State 400 Available at Walmart',
      track: 'Atlanta Motor Speedway',
      scheduled_start_utc: '2026-07-12T23:00:00.000Z',
      race_started: false, actual_laps: 0, inspection_complete: false,
      infractions_count: 0, practice_run_count: 0, source_urls: sourceUrls,
    }],
  };
  const activeFieldEnvelope = {
    source_id: 'active_field_pool', status: 'ok', checked_at_utc: CHECKED,
    records: DRIVERS.map((driver_name, index) => ({
      driver_name, driver_id: 1000 + index, car_number: String(index + 1),
      team: `Team ${index + 1}`, manufacturer: ['Chevrolet', 'Ford', 'Toyota'][index % 3],
      starting_grid_position: index + 1, race_id: 5615, track_id: 111,
    })),
  };
  const practiceEnvelope = {
    source_id: 'practice_qualifying', status: 'ok', checked_at_utc: CHECKED,
    records: DRIVERS.map((driver_name, index) => ({
      driver_name, race_id: 5615, track_id: 111,
      effective_race_start: index + 1, starting_position: index + 1,
      qualifying_speed: 180 - index / 10,
    })),
  };
  const event = {
    event_ticker: 'KXNASCARRACE-QUAS4AA26',
    title: 'Quaker State 400 Available at Walmart Winner',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: DRIVERS.map((driver, index) => ({
      ticker: `KXNASCARRACE-QUAS4AA26-${index}`,
      yes_sub_title: driver,
      yes_bid_dollars: priceSeed + index / 100,
      yes_ask_dollars: priceSeed + index / 100 + 0.01,
      last_price_dollars: priceSeed + index / 100 + 0.005,
      implied_probability: priceSeed,
      volume_fp: 1000 + priceSeed,
      open_interest_fp: 2000 + priceSeed,
    })),
  };
  const liveResearch = {
    generated_utc: CHECKED,
    event_ticker: event.event_ticker,
    source_urls: [],
    layers: {
      practice_speed: { status: 'missing', notes: 'No practice session published.', sources: [], fetched_utc: CHECKED },
      penalties_inspection_news: { status: 'missing', notes: 'Inspection incomplete.', sources: [], fetched_utc: CHECKED },
      weather_track_condition: { status: 'missing', notes: 'No verified weather returned.', sources: [], fetched_utc: CHECKED },
    },
  };
  return { date: DATE, event, officialEnvelope, activeFieldEnvelope, practiceEnvelope, liveResearch, checkedAtUtc: CHECKED };
}

test('production evidence builds 38 numeric model-only candidates and nine honest evidence layers', () => {
  const built = buildNascarProductionEvidence(inputs(0.01));
  assert.equal(built.ceiling.mode, 'production');
  assert.equal(built.ceiling.candidate_count, 38);
  assert.equal(built.ceiling.candidates.length, 38);
  assert.ok(built.ceiling.candidates.every((candidate) => Number.isFinite(candidate.composite_score)));
  assert.ok(built.ceiling.candidates.every((candidate) => candidate.lanes?.win?.status));
  assert.equal(Object.keys(built.evidenceArtifact.layers).length, 9);
  for (const layer of Object.values(built.evidenceArtifact.layers)) {
    assert.ok(['ok', 'source_unavailable'].includes(layer.status));
    assert.ok(layer.source_id);
    assert.equal(layer.fetched_utc, CHECKED);
  }
  assert.equal(built.evidenceArtifact.layers.practice_speed.status, 'source_unavailable');
  assert.equal(built.evidenceArtifact.layers.recent_driver_form.status, 'source_unavailable');
  assert.equal(built.evidenceArtifact.layers.recent_driver_form.data_as_of_utc, '2026-06-01T02:01:09.258Z');
  assert.equal(built.evidenceArtifact.layers.penalties_inspection_news.status, 'source_unavailable');
  assert.equal(built.evidenceArtifact.layers.weather_track_condition.status, 'source_unavailable');
  assert.equal(built.discovery.track_profile.track_type, 'superspeedway');
  assert.ok(built.ceiling.candidates.every((candidate) =>
    candidate.layer_breakdown.find((layer) => layer.layer === 'recent_form_weighted_by_track_type')?.value === null));
  const serialized = JSON.stringify(built.ceiling);
  assert.doesNotMatch(serialized, /yes_bid|yes_ask|last_price|implied_probability|volume_fp|open_interest_fp|edge/i);
});

test('production ranking, posture, ceiling, and section inputs are invariant to all market-price fields', () => {
  const cheap = buildNascarProductionEvidence(inputs(0.01));
  const expensive = buildNascarProductionEvidence(inputs(0.91));
  const project = (built) => built.ceiling.candidates.map((candidate) => ({
    driver_name: candidate.driver_name,
    composite_score: candidate.composite_score,
    ranking_score: candidate.ranking_score,
    posture: candidate.lanes.win.status,
  }));
  assert.deepEqual(project(expensive), project(cheap));
});

test('customer rows use the scorer fair probabilities exactly across the full field', () => {
  const provided = inputs();
  const production = buildNascarProductionEvidence(provided);
  const rows = buildNascarRows({ event: provided.event, ceiling: production.ceiling });
  assert.equal(rows.rows.length, 38);
  const candidateByName = new Map(production.ceiling.candidates.map((candidate) => [normalizeNascarDriverName(candidate.driver_name), candidate]));
  for (const row of rows.rows) {
    const driver = row.side_target.replace(/\s+—\s+WIN$/, '');
    const candidate = candidateByName.get(normalizeNascarDriverName(driver));
    assert.ok(candidate, driver);
    assert.equal(row.fair_probability_or_range, `${Math.round(candidate.fair_win_probability * 100)}%`);
  }
  const sum = production.ceiling.candidates.reduce((total, candidate) => total + candidate.fair_win_probability, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `fair probability sum=${sum}`);
});

test('production evidence joins official practice when available without fabricating long-run speed', () => {
  const provided = inputs();
  provided.officialEnvelope.records[0].practice_run_count = 1;
  provided.practiceEnvelope.records.forEach((record, index) => {
    record.practice_rank = index + 1;
    record.practice_speed = 176 - index / 10;
    record.practice_lap_time = 31 + index / 100;
  });
  const built = buildNascarProductionEvidence(provided);
  assert.equal(built.evidenceArtifact.layers.practice_speed.status, 'ok');
  assert.match(built.evidenceArtifact.layers.practice_speed.notes, /38\/38/);
  assert.ok(built.ceiling.candidates.every((candidate) => candidate.practice_context.evidence === 'OK'));
  assert.ok(built.ceiling.candidates.every((candidate) => candidate.practice_context.long_run === null));
});

test('optional narrative adapter failure degrades explicitly while official/model evidence remains complete', () => {
  const provided = inputs();
  provided.liveResearch = {
    generated_utc: CHECKED,
    event_ticker: provided.event.event_ticker,
    source_urls: [],
    layers: {
      practice_speed: { status: 'ok', source_id: 'perplexity_live_research', notes: 'Unsupported note-only practice claim.', sources: [], fetched_utc: CHECKED },
      weather_track_condition: { status: 'ok', source_id: 'perplexity_live_research', notes: 'Unsupported note-only weather claim.', sources: [], fetched_utc: CHECKED },
    },
    _adapter_status: 'source_unavailable',
  };
  const built = buildNascarProductionEvidence(provided);
  assert.equal(built.ceiling.candidate_count, 38);
  assert.equal(built.sourceRegistry.sources.current_event_research.status, 'source_unavailable');
  assert.equal(built.evidenceArtifact.layers.race_event_identity.status, 'ok');
  assert.equal(built.evidenceArtifact.layers.practice_speed.status, 'source_unavailable');
  assert.equal(built.evidenceArtifact.layers.practice_speed.source_id, 'nascar_official');
  assert.equal(built.evidenceArtifact.layers.practice_speed.sources.length, 2);
  assert.equal(built.evidenceArtifact.layers.weather_track_condition.status, 'source_unavailable');
});

test('production persistence replaces stale fixture/Daytona discovery, registry, manifest, ceiling, and evidence', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nascar-production-state-'));
  const root = join(stateRoot, 'nascar', DATE);
  mkdirSync(root, { recursive: true });
  try {
    for (const file of ['discovery.json', 'source_registry.json', 'race_manifest.json', 'ceiling_board.json', 'live-research.json']) {
      writeFileSync(join(root, file), `${JSON.stringify({ mode: 'fixtures-only', race_name: 'Daytona 500' })}\n`);
    }
    const built = buildNascarProductionEvidence(inputs());
    const paths = persistNascarProductionArtifacts({ stateRoot, date: DATE, built });
    assert.equal(Object.keys(paths).length, 5);
    for (const file of ['discovery.json', 'source_registry.json', 'race_manifest.json', 'ceiling_board.json', 'live-research.json']) {
      const text = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(text, /Daytona|fixtures-only/i);
      assert.equal(JSON.parse(text).mode, 'production');
    }
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
