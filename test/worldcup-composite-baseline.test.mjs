import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findLatestPriorBaseline } from '../scripts/worldcup/lib/composite-baseline.mjs';
import { fetchTeamBaseline } from '../scripts/worldcup/source-adapters/team-baseline.mjs';
import { runDailySync } from '../scripts/worldcup/cron/daily-sync.mjs';
import { generateMatchdayPacket } from '../scripts/worldcup/generate-matchday-packet.mjs';

const DATE = '2026-06-29';
const MATCH = {
  match_id: '400099001',
  home_team: 'France',
  away_team: 'Japan',
  group: 'H',
  stage: 'group',
  round: 1,
  kickoff_utc: '2026-06-29T19:00:00.000Z',
  venue: 'Toronto Stadium',
};

function baselineFixture(teams = [MATCH.home_team, MATCH.away_team]) {
  return {
    ok: true,
    source_id: 'fixture-prior',
    fetched_at: '2026-06-17T00:00:00.000Z',
    confidence: 'medium',
    team_count: teams.length,
    teams: teams.map((team_name, index) => ({
      team_name,
      team_code: index === 0 ? 'FRA' : 'JPN',
      fifa_rank: null,
      fifa_points: null,
      elo_rating: index === 0 ? 2123 : 1888,
      confederation: index === 0 ? 'UEFA' : 'AFC',
      quality_score_0_100: index === 0 ? 88 : 69,
      attack_rating: index === 0 ? 87 : 68,
      defense_rating: index === 0 ? 85 : 67,
      style: index === 0 ? 52 : 50,
      set_piece_rating: index === 0 ? 84 : 65,
      set_piece_defense: index === 0 ? 83 : 64,
      goalkeeper_rating: index === 0 ? 86 : 68,
      chance_quality: index === 0 ? 85 : 67,
      derivation: 'fixture-prior',
      source_quality: 'medium',
    })),
  };
}

function writeStructure(stateRoot, date = DATE, match = MATCH) {
  const discoveryDir = join(stateRoot, 'worldcup', date, 'discovery');
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(
    join(discoveryDir, 'static_structure.json'),
    `${JSON.stringify({ ok: true, source_id: 'fixture', match_count: 1, matches: [match] }, null, 2)}\n`,
    'utf8',
  );
}

function writePriorBaseline(stateRoot, sourceDate = '2026-06-17') {
  const discoveryDir = join(stateRoot, 'worldcup', sourceDate, 'discovery');
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(
    join(discoveryDir, 'team_baseline.json'),
    `${JSON.stringify(baselineFixture(), null, 2)}\n`,
    'utf8',
  );
}

async function withFixtureServer({ failElo = false } = {}) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sendJson = (payload, status = 200) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/fifa/calendar.json') {
      sendJson({
        Results: [{
          IdMatch: MATCH.match_id,
          Date: MATCH.kickoff_utc,
          LocalDate: MATCH.kickoff_utc,
          GroupName: [{ Locale: 'en-GB', Description: MATCH.group }],
          RoundNumber: MATCH.round,
          MatchStatus: { Name: [{ Locale: 'en-GB', Description: 'SCHEDULED' }] },
          Stadium: {
            Name: [{ Locale: 'en-GB', Description: MATCH.venue }],
            CityName: [{ Locale: 'en-GB', Description: 'Toronto' }],
          },
          Home: {
            TeamName: [{ Locale: 'en-GB', Description: MATCH.home_team }],
            Abbreviation: 'FRA',
            Score: null,
          },
          Away: {
            TeamName: [{ Locale: 'en-GB', Description: MATCH.away_team }],
            Abbreviation: 'JPN',
            Score: null,
          },
        }],
      });
      return;
    }

    if (url.pathname === '/espn/teams.json') {
      sendJson({
        sports: [{
          leagues: [{
            teams: [
              { team: { displayName: 'France', abbreviation: 'FRA' } },
              { team: { displayName: 'Japan', abbreviation: 'JPN' } },
            ],
          }],
        }],
      });
      return;
    }

    if (url.pathname === '/fifa/ranking.html') {
      res.writeHead(200, {
        'content-type': 'text/html',
        connection: 'close',
      });
      res.end('<html><body><script>window.__NO_TABLE__ = true;</script></body></html>');
      return;
    }

    if (url.pathname === '/elo/World.tsv') {
      if (failElo) {
        res.writeHead(503, {
          'content-type': 'text/plain',
          connection: 'close',
        });
        res.end('upstream down');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain',
        connection: 'close',
      });
      res.end([
        '3\t3\tFR\t2123',
        '15\t15\tJP\t1888',
      ].join('\n'));
      return;
    }

    if (url.pathname === '/elo/en.teams.tsv') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        connection: 'close',
      });
      res.end([
        'FR\tFrance',
        'JP\tJapan',
      ].join('\n'));
      return;
    }

    res.writeHead(404, {
      'content-type': 'text/plain',
      connection: 'close',
    });
    res.end('not found');
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.unref();
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

function baselineEnv(baseUrl, homeRoot) {
  return {
    ...process.env,
    HOME: homeRoot,
    PERPLEXITY_API_KEY: '',
    PPLX_API_KEY: '',
    WORLDCUP_STATIC_STRUCTURE_FIFA_URL: `${baseUrl}/fifa/calendar.json`,
    WORLDCUP_TEAM_BASELINE_FIFA_CALENDAR_URL: `${baseUrl}/fifa/calendar.json`,
    WORLDCUP_TEAM_BASELINE_FIFA_RANKING_URL: `${baseUrl}/fifa/ranking.html`,
    WORLDCUP_TEAM_BASELINE_ELO_WORLD_URL: `${baseUrl}/elo/World.tsv`,
    WORLDCUP_TEAM_BASELINE_ELO_TEAMS_URL: `${baseUrl}/elo/en.teams.tsv`,
    WORLDCUP_TEAM_BASELINE_ESPN_TEAMS_URL: `${baseUrl}/espn/teams.json`,
  };
}

function testFetch(url, { headers = {} } = {}) {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(target, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
          status: res.statusCode ?? 500,
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function packetPaths(stateRoot, date = DATE) {
  const packetDir = join(stateRoot, 'packets', date, 'worldcup-matchday');
  const base = `worldcup-${date}-morning_board-france-japan`;
  return {
    packetTextPath: join(packetDir, `${base}.txt`),
    packetMetaPath: join(packetDir, `${base}.meta.json`),
  };
}

async function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('findLatestPriorBaseline picks the most recent baseline before the target date', () => {
  const found = findLatestPriorBaseline('state', '2026-06-22');
  assert.ok(found, 'a prior baseline should be found for 2026-06-22');
  assert.equal(found.sourceDate, '2026-06-17', 'latest prior baseline is 2026-06-17');
  const arg = (found.baseline.teams || []).find((team) => team.team_name === 'Argentina');
  assert.ok(arg && (arg.quality_score_0_100 ?? arg.attack_rating) != null, 'baseline carries Argentina composite');
});

test('findLatestPriorBaseline returns null when no prior baseline exists', () => {
  assert.equal(findLatestPriorBaseline('state', '2026-01-01'), null);
});

test('fetchTeamBaseline returns the rich packet schema from live source inputs', async () => {
  const fixture = await withFixtureServer();
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-baseline-'));
  try {
    const result = await fetchTeamBaseline({
      stateRoot,
      date: DATE,
      structure: { ok: true, match_count: 1, matches: [MATCH] },
      fetchImpl: testFetch,
      fifaCalendarUrl: `${fixture.baseUrl}/fifa/calendar.json`,
      fifaRankingUrl: `${fixture.baseUrl}/fifa/ranking.html`,
      eloWorldUrl: `${fixture.baseUrl}/elo/World.tsv`,
      eloTeamsUrl: `${fixture.baseUrl}/elo/en.teams.tsv`,
      espnTeamsUrl: `${fixture.baseUrl}/espn/teams.json`,
    });

    assert.equal(result.ok, true);
    assert.equal(result.team_count, 2);
    const france = result.teams.find((team) => team.team_name === 'France');
    assert.ok(france, 'France baseline must exist');
    for (const field of [
      'team_name',
      'team_code',
      'fifa_rank',
      'fifa_points',
      'elo_rating',
      'confederation',
      'quality_score_0_100',
      'attack_rating',
      'defense_rating',
      'style',
      'set_piece_rating',
      'set_piece_defense',
      'goalkeeper_rating',
      'chance_quality',
      'derivation',
      'source_quality',
    ]) {
      assert.ok(Object.hasOwn(france, field), `missing field ${field}`);
    }
    assert.equal(france.team_code, 'FRA');
    assert.equal(france.elo_rating, 2123);
    assert.equal(france.confederation, 'UEFA');
    assert.equal(france.fifa_rank, null, 'fifa rank must stay null when live ranking data is unavailable');
    assert.equal(france.fifa_points, null, 'fifa points must stay null when live ranking data is unavailable');
    assert.equal(typeof france.quality_score_0_100, 'number');
    assert.equal(typeof france.attack_rating, 'number');
    assert.equal(france.source_quality, 'medium');
    assert.match(france.derivation, /heuristics/);
  } finally {
    fixture.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('daily-sync writes state/worldcup/<date>/discovery/team_baseline.json when baseline sources succeed', async () => {
  const fixture = await withFixtureServer();
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-daily-sync-'));
  try {
    await runDailySync({
      date: DATE,
      stateRoot,
      fetchStaticStructureImpl: async () => ({
        ok: true,
        source_id: 'fixture-structure',
        match_count: 1,
        matches: [MATCH],
      }),
      fetchTeamBaselineImpl: async ({ stateRoot: baselineStateRoot, date, structure }) => fetchTeamBaseline({
        stateRoot: baselineStateRoot,
        date,
        structure,
        fetchImpl: testFetch,
        fifaCalendarUrl: `${fixture.baseUrl}/fifa/calendar.json`,
        fifaRankingUrl: `${fixture.baseUrl}/fifa/ranking.html`,
        eloWorldUrl: `${fixture.baseUrl}/elo/World.tsv`,
        eloTeamsUrl: `${fixture.baseUrl}/elo/en.teams.tsv`,
        espnTeamsUrl: `${fixture.baseUrl}/espn/teams.json`,
      }),
      log: { log() {}, error() {} },
    });
    const outPath = join(stateRoot, 'worldcup', DATE, 'discovery', 'team_baseline.json');
    assert.equal(existsSync(outPath), true, 'daily-sync must write the same-date baseline');
    const baseline = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(baseline.ok, true);
    assert.equal(baseline.team_count, 2);
    assert.equal(baseline.teams[0].quality_score_0_100 != null, true);
  } finally {
    fixture.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('packet generation refreshes a missing same-date baseline before render and uses it as current provenance', async () => {
  const fixture = await withFixtureServer();
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-generator-'));
  const homeRoot = join(stateRoot, 'home');
  mkdirSync(homeRoot, { recursive: true });
  writeStructure(stateRoot);

  try {
    await withEnv(baselineEnv(fixture.baseUrl, homeRoot), async () => {
      await generateMatchdayPacket({
        date: DATE,
        matchId: MATCH.match_id,
        packetStage: 'morning_board',
        stateRoot,
        dryRun: false,
        help: false,
        refreshLineups: false,
      });
    });
    const baselinePath = join(stateRoot, 'worldcup', DATE, 'discovery', 'team_baseline.json');
    assert.equal(existsSync(baselinePath), true, 'generator must materialize a same-date baseline');

    const { packetTextPath, packetMetaPath } = packetPaths(stateRoot);
    const packetText = readFileSync(packetTextPath, 'utf8');
    const packetMeta = JSON.parse(readFileSync(packetMetaPath, 'utf8'));

    assert.equal(packetMeta.composite_provenance.source_date, DATE);
    assert.equal(packetMeta.composite_provenance.provisional, false);
    assert.doesNotMatch(packetText, /CURRENT_TEAM_BASELINE_REQUIRED/);
    assert.match(packetText, /Model basis: same-date team baseline/);
  } finally {
    fixture.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('if live baseline generation fails, packet blocks safely and prior baseline stays diagnostic only', async () => {
  const fixture = await withFixtureServer({ failElo: true });
  const stateRoot = mkdtempSync(join(tmpdir(), 'wc-generator-blocked-'));
  const homeRoot = join(stateRoot, 'home');
  mkdirSync(homeRoot, { recursive: true });
  writeStructure(stateRoot);
  writePriorBaseline(stateRoot);

  try {
    await withEnv(baselineEnv(fixture.baseUrl, homeRoot), async () => {
      await generateMatchdayPacket({
        date: DATE,
        matchId: MATCH.match_id,
        packetStage: 'morning_board',
        stateRoot,
        dryRun: false,
        help: false,
        refreshLineups: false,
      });
    });
    const sameDateBaseline = join(stateRoot, 'worldcup', DATE, 'discovery', 'team_baseline.json');
    assert.equal(existsSync(sameDateBaseline), false, 'failed live generation must not fake a current baseline');

    const { packetTextPath, packetMetaPath } = packetPaths(stateRoot);
    const packetText = readFileSync(packetTextPath, 'utf8');
    const packetMeta = JSON.parse(readFileSync(packetMetaPath, 'utf8'));

    assert.equal(packetMeta.composite_provenance.provisional, true);
    assert.equal(packetMeta.composite_provenance.source_date, '2026-06-17');
    assert.equal(packetMeta.packet_gate.blocked, true);
    assert.match(packetText, /CURRENT_TEAM_BASELINE_REQUIRED/);
    assert.match(packetText, /prior baseline from 2026-06-17 is diagnostic only/);
  } finally {
    fixture.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
