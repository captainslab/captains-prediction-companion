import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fetchNascarOfficialLive } from '../scripts/nascar/lib/source-adapters/nascar-official-live.mjs';

const DATE = '2026-07-12';
const NOW = new Date('2026-07-12T23:45:00.000Z');
const LIST_URL = 'https://cf.nascar.com/cacher/2026/race_list_basic.json';
const FEED_URL = 'https://cf.nascar.com/cacher/2026/1/901/weekend-feed.json';

function fixturePayload({
  grid = 'complete',
  raceDate = '2026-07-13T04:30:00Z',
  resultIds = 'present',
  actualLaps = 0,
  practice = false,
} = {}) {
  const names = ['Ryan Blaney', 'Joey Logano', 'Kyle Larson'];
  const results = names.map((driver_fullname, index) => ({
    result_id: 100 + index,
    race_id: 901,
    track_id: 44,
    driver_id: 4000 + index,
    driver_fullname,
    car_number: String(index + 1),
    team_name: `Team ${index + 1}`,
    car_make: index === 2 ? 'Chevrolet' : 'Ford',
    finishing_position: 0,
    starting_position: index + 1,
    laps_completed: index === 0 ? actualLaps : 0,
  }));
  if (resultIds === 'omitted') {
    for (const row of results) {
      delete row.race_id;
      delete row.track_id;
    }
  } else if (resultIds === 'conflicting-race') {
    results[0].race_id = 902;
  } else if (resultIds === 'conflicting-track') {
    results[0].track_id = 45;
  }
  if (grid === 'zero') results[1].starting_position = 0;
  if (grid === 'duplicate') results[2].starting_position = 2;
  const weekendRuns = [{
    race_id: 901,
    run_type: 2,
    run_date_utc: raceDate,
    results: names.map((driver_name, index) => ({
      run_id: 800 + index,
      driver_id: 4000 + index,
      driver_name,
      finishing_position: index + 1,
      best_lap_time: 30.8 + index / 10,
      best_lap_speed: 180 - index,
    })),
  }];
  if (practice) {
    weekendRuns.push({
      race_id: 901,
      run_type: 1,
      run_date_utc: raceDate,
      results: names.map((driver_name, index) => ({
        driver_id: 4000 + index,
        driver_name,
        finishing_position: index + 1,
        best_lap_time: 31.1 + index / 10,
        best_lap_speed: 176 - index,
      })),
    });
  }
  return {
    list: {
      series_1: [
        {
          race_id: 901,
          series_id: 1,
          race_season: 2026,
          race_name: 'Generic Summer 400',
          track_id: 44,
          track_name: 'Legacy Speedway Name',
          race_date: raceDate,
          schedule: [{ event_name: 'Race', run_type: 3, start_time_utc: raceDate }],
        },
      ],
    },
    feed: {
      weekend_race: [{
        race_id: 901,
        track_id: 44,
        race_name: 'Generic Summer 400',
        actual_laps: 260,
        results,
      }],
      weekend_runs: weekendRuns,
    },
  };
}

function response(payload, lastModified = 'Sun, 12 Jul 2026 23:30:00 GMT') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Last-Modified': lastModified }),
    async json() { return payload; },
  };
}

function fetchFor(payload, { listStatus = 200, feedStatus = 200, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    if (url === LIST_URL && listStatus !== 200) return { ok: false, status: listStatus, headers: new Headers(), async json() { return {}; } };
    if (url === FEED_URL && feedStatus !== 200) return { ok: false, status: feedStatus, headers: new Headers(), async json() { return {}; } };
    if (url === LIST_URL) return response(payload.list);
    if (url === FEED_URL) return response(payload.feed);
    throw new Error(`unexpected URL ${url}`);
  };
}

async function runFixture(options = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), 'nascar-official-adapter-'));
  try {
    const payload = fixturePayload(options);
    const calls = [];
    const result = await fetchNascarOfficialLive({
      date: DATE,
      outputDir,
      now: NOW,
      fetchImpl: fetchFor(payload, { ...options, calls }),
    });
    return { result, calls, outputDir };
  } catch (error) {
    rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

test('official adapter normalizes a complete generic feed and uses the Chicago date window', async () => {
  const { result, calls, outputDir } = await runFixture();
  try {
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [LIST_URL, FEED_URL]);
    for (const path of Object.values(result.paths)) assert.equal(existsSync(path), true);
    assert.equal(result.envelopes.official.status, 'ok');
    assert.equal(result.envelopes.activeField.status, 'ok');
    assert.equal(result.envelopes.practiceQualifying.status, 'ok');
    assert.equal(result.envelopes.activeField.records.length, 3);
    assert.equal(result.envelopes.practiceQualifying.records[0].effective_race_start, 1);
    assert.equal(result.envelopes.official.records[0].race_id, 901);
    assert.equal(result.envelopes.official.records[0].track, 'Legacy Speedway Name');
    assert.equal(result.envelopes.official.records[0].race_started, false);
    assert.equal(result.envelopes.official.records[0].actual_laps, 0);
    assert.equal(result.envelopes.official.records[0].inspection_complete, false);
    assert.equal(result.envelopes.official.records[0].infractions_count, 0);
    assert.equal(result.envelopes.official.records[0].practice_run_count, 0);
    assert.ok(result.envelopes.activeField.records.every((row) => row.race_id === 901 && row.track_id === 44));
    assert.ok(result.envelopes.practiceQualifying.records.every((row) => row.race_id === 901 && row.track_id === 44));
    assert.equal(result.envelopes.official.records[0].publication_at_utc, '2026-07-12T23:30:00.000Z');
    assert.equal(result.envelopes.official.records[0].fetched_at_utc, NOW.toISOString());
    const disk = JSON.parse(readFileSync(result.paths.official, 'utf8'));
    assert.equal(disk.records[0].race_name, 'Generic Summer 400');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('official adapter marks the selected race started when the weekend feed has completed a lap', async () => {
  const { result, outputDir } = await runFixture({ actualLaps: 1 });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.envelopes.official.records[0].race_started, true);
    assert.equal(result.envelopes.official.records[0].actual_laps, 1);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('official adapter joins real run_type 1 practice rows when the feed publishes them', async () => {
  const { result, outputDir } = await runFixture({ practice: true });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.envelopes.official.records[0].practice_run_count, 1);
    assert.equal(result.envelopes.practiceQualifying.records.length, 3);
    assert.equal(result.envelopes.practiceQualifying.records[0].practice_rank, 1);
    assert.equal(result.envelopes.practiceQualifying.records[0].practice_speed, 176);
    assert.equal(result.envelopes.practiceQualifying.records[0].practice_lap_time, 31.1);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('official adapter stamps selected race_id/track_id when production result rows omit them', async () => {
  const { result, outputDir } = await runFixture({ resultIds: 'omitted' });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.envelopes.activeField.records.length, 3);
    assert.equal(result.envelopes.practiceQualifying.records.length, 3);
    for (const row of result.envelopes.activeField.records) {
      assert.equal(row.race_id, 901);
      assert.equal(row.track_id, 44);
    }
    for (const row of result.envelopes.practiceQualifying.records) {
      assert.equal(row.race_id, 901);
      assert.equal(row.track_id, 44);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('official adapter rejects result row IDs that conflict with the selected race', async (t) => {
  for (const [resultIds, expected] of [
    ['conflicting-race', /race_id 902 conflicts with selected official race_id 901/],
    ['conflicting-track', /track_id 45 conflicts with selected official track_id 44/],
  ]) {
    await t.test(resultIds, async () => {
      const { result, outputDir } = await runFixture({ resultIds });
      try {
        assert.equal(result.ok, false);
        assert.equal(result.status, 'unavailable');
        assert.match(result.reason, expected);
        assert.deepEqual(result.envelopes.activeField.records, []);
        assert.deepEqual(result.envelopes.practiceQualifying.records, []);
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    });
  }
});

test('official adapter fails closed for HTTP errors and never fabricates rows', async () => {
  const { result, outputDir } = await runFixture({ listStatus: 503 });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    for (const envelope of Object.values(result.envelopes)) {
      assert.equal(envelope.status, 'unavailable');
      assert.deepEqual(envelope.records, []);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('official adapter fails closed for missing race, wrong date, and partial grids', async (t) => {
  await t.test('date-only race_date remains on the requested Chicago calendar date', async () => {
    const { result, outputDir } = await runFixture({ raceDate: '2026-07-12' });
    try {
      assert.equal(result.ok, true);
      assert.equal(result.envelopes.official.records[0].race_date, '2026-07-12');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await t.test('missing race', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'nascar-official-missing-race-'));
    try {
      const calls = [];
      const result = await fetchNascarOfficialLive({
        date: DATE,
        outputDir,
        now: NOW,
        fetchImpl: async (url) => {
          calls.push(url);
          return response({ series_1: [] });
        },
      });
      assert.equal(result.status, 'unavailable');
      assert.deepEqual(calls, [LIST_URL]);
      assert.deepEqual(result.envelopes.activeField.records, []);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  for (const grid of ['zero', 'duplicate']) {
    await t.test(`partial grid: ${grid}`, async () => {
      const { result, outputDir } = await runFixture({ grid });
      try {
        assert.equal(result.status, 'unavailable');
        assert.deepEqual(result.envelopes.official.records, []);
        assert.deepEqual(result.envelopes.practiceQualifying.records, []);
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    });
  }

  await t.test('wrong target date', async () => {
    const { result, outputDir } = await runFixture({ raceDate: '2026-07-14T04:30:00Z' });
    try {
      assert.equal(result.status, 'unavailable');
      assert.deepEqual(result.envelopes.official.records, []);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
