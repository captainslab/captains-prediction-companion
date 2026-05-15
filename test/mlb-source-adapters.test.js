import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchKalshiReadonly,
  fixtureKalshiBlockedEnvelope,
  fixtureKalshiSuccessEnvelope,
} from '../scripts/mlb/source-adapters/kalshi-readonly.mjs';
import { fixtureMlbScheduleEnvelope } from '../scripts/mlb/source-adapters/mlb-official-readonly.mjs';

function makeJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
  };
}

test('fixture Kalshi success envelope', () => {
  const envelope = fixtureKalshiSuccessEnvelope({
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'kalshi');
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.required, true);
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].markets[0].market_lane, 'moneyline');
  assert.equal(envelope.errors.length, 0);
});

test('fixture Kalshi blocked/challenge envelope', () => {
  const envelope = fixtureKalshiBlockedEnvelope({
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'kalshi');
  assert.equal(envelope.status, 'degraded');
  assert.equal(envelope.records.length, 0);
  assert.match(envelope.warnings.join(' '), /blocked|challenge/i);
  assert.match(envelope.errors.join(' '), /429|challenge/i);
});

test('fixture MLB schedule envelope', () => {
  const envelope = fixtureMlbScheduleEnvelope({
    runDate: '2026-05-15',
    checkedAtUtc: '2026-05-15T14:00:00.000Z',
    outputDir: 'state/mlb/2026-05-15/discovery',
  });

  assert.equal(envelope.source_id, 'mlb_official');
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].game_pk, 100001);
  assert.equal(envelope.records[0].away_team, 'Alpha City Aces');
  assert.equal(envelope.records[0].probable_pitchers.home, 'Placeholder Pitcher B');
});

test('CLI defaults to fixtures-only and writes discovery summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-source-cli-'));
  const outDir = join(dir, 'discovery');

  try {
    const stdout = execFileSync(
      process.execPath,
      ['scripts/mlb/source-adapter-dry-run.mjs', '--date', '2026-05-15', '--source', 'all', '--out', outDir],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const result = JSON.parse(stdout);

    assert.equal(result.mode, 'fixtures-only');
    assert.equal(result.kalshi_status, 'ok');
    assert.equal(result.mlb_status, 'ok');
    assert.equal(existsSync(join(outDir, 'kalshi_adapter.json')), true);
    assert.equal(existsSync(join(outDir, 'mlb_official_adapter.json')), true);
    assert.equal(existsSync(join(outDir, 'discovery_summary.md')), true);

    const summary = readFileSync(join(outDir, 'discovery_summary.md'), 'utf8');
    assert.match(summary, /No picks made\./);
    assert.match(summary, /No trades placed\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live-readonly flag does not call trade execution endpoints', async () => {
  const urls = [];
  const fetchImpl = async url => {
    const value = typeof url === 'string' ? url : url.toString();
    urls.push(value);
    if (value.includes('/calendar/')) {
      return makeJsonResponse('challenge', 429);
    }
    return makeJsonResponse({ events: [], cursor: null }, 200);
  };

  const envelope = await fetchKalshiReadonly({
    outputDir: 'state/mlb/2026-05-15/discovery',
    fixturesOnly: false,
    fetchImpl,
    now: new Date('2026-05-15T14:00:00.000Z'),
  });

  assert.equal(envelope.source_id, 'kalshi');
  assert.equal(envelope.status, 'degraded');
  assert.equal(urls.length > 0, true);
  for (const url of urls) {
    const pathname = new URL(url).pathname;
    assert.doesNotMatch(pathname, /orders|portfolio|balance|positions|fills/i);
  }
});

test('Kalshi live-readonly filters false positives and keeps only official same-day game matches', async () => {
  const fetchImpl = async url => {
    const value = typeof url === 'string' ? url : url.toString();
    if (value.includes('/calendar/')) {
      return makeJsonResponse('challenge', 429);
    }
    return makeJsonResponse(
      {
        events: [
          {
            event_ticker: 'KXDEPP-PIRATES',
            series_ticker: 'KXENTERTAINMENT',
            title: 'Will Johnny Depp be cast in the next Pirates of the Caribbean?',
            category: 'Entertainment',
            markets: [{ ticker: 'KXDEPP-PIRATES-YES', title: 'Johnny Depp Pirates movie casting' }],
          },
          {
            event_ticker: 'KXMLBDEBUT-HOLLIDAY',
            series_ticker: 'KXMLBDEBUT',
            title: 'Ethan Holliday: Debut Date',
            category: 'Sports',
            markets: [
              {
                ticker: 'KXMLBDEBUT-HOLLIDAY-2026',
                title: 'Will Ethan Holliday play in a game for any team in the MLB before June 1?',
              },
            ],
          },
          {
            event_ticker: 'KXMLB-PHI-PIT',
            series_ticker: 'KXMLB',
            title: 'Philadelphia Phillies at Pittsburgh Pirates',
            category: 'Sports',
            markets: [
              {
                ticker: 'KXMLB-PHI-PIT-WINNER',
                title: 'Will the Philadelphia Phillies beat the Pittsburgh Pirates?',
              },
            ],
          },
          {
            event_ticker: 'SENATENY-28',
            series_ticker: 'SENATENY',
            title: 'New York Senate winner? (2028)',
            category: 'Elections',
            markets: [{ ticker: 'SENATENY-28-D', title: 'Will Democrats win the Senate race in New York?' }],
          },
          {
            event_ticker: 'KXRELOCATIONCHI-28',
            series_ticker: 'KXRELOCATIONCHI',
            title: 'Chicago Pro Football Team: Relocation',
            category: 'Sports',
            markets: [
              {
                ticker: 'KXRELOCATIONCHI-28-IL',
                title: 'Will the Chicago Pro Football Team relocate before the 2028 season?',
              },
            ],
          },
        ],
        cursor: null,
      },
      200,
    );
  };

  const envelope = await fetchKalshiReadonly({
    outputDir: 'state/mlb/2026-05-15/discovery',
    fixturesOnly: false,
    fetchImpl,
    now: new Date('2026-05-15T14:00:00.000Z'),
    officialMlbGames: [
      {
        game_pk: 823384,
        away_team: 'Philadelphia Phillies',
        home_team: 'Pittsburgh Pirates',
      },
    ],
  });

  assert.equal(envelope.records.length, 1);
  assert.equal(envelope.records[0].event_ticker, 'KXMLB-PHI-PIT');
  assert.equal(envelope.records[0].matched_game_pk, 823384);
  assert.equal(envelope.records[0].markets[0].market_lane, 'moneyline');
  assert.equal(envelope.rejected_records.length, 2);
  assert.match(envelope.rejected_records.map(record => record.reason).join(' '), /entertainment|debut/i);
});

test('generated summary includes No picks made and No trades placed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-source-summary-'));
  const outDir = join(dir, 'discovery');

  try {
    execFileSync(
      process.execPath,
      [
        'scripts/mlb/source-adapter-dry-run.mjs',
        '--date',
        '2026-05-15',
        '--fixtures-only',
        '--source',
        'all',
        '--out',
        outDir,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    const summary = readFileSync(join(outDir, 'discovery_summary.md'), 'utf8');
    assert.match(summary, /This is discovery only\./);
    assert.match(summary, /No picks made\./);
    assert.match(summary, /No trades placed\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('single-source discover does not overwrite other adapter files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-single-source-'));
  const outDir = join(dir, 'discovery');

  try {
    execFileSync(
      process.execPath,
      [
        'scripts/mlb/source-adapter-dry-run.mjs',
        '--date',
        '2026-05-15',
        '--source',
        'kalshi',
        '--out',
        outDir,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    // kalshi was requested — its file should exist
    assert.equal(existsSync(join(outDir, 'kalshi_adapter.json')), true);
    // mlb was NOT requested and no pre-existing file — should not exist
    assert.equal(existsSync(join(outDir, 'mlb_official_adapter.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scoring blocks CLEAR_PICK when fixture mode detected', async () => {
  const { scoreMarkets } = await import('../scripts/mlb/scoring-core.mjs');
  const { fixtureKalshiSuccessEnvelope } = await import('../scripts/mlb/source-adapters/kalshi-readonly.mjs');
  const { fixtureMlbScheduleEnvelope } = await import('../scripts/mlb/source-adapters/mlb-official-readonly.mjs');
  const { fixtureWeatherEnvelope } = await import('../scripts/mlb/source-adapters/weather-readonly.mjs');
  const { fixtureLiquidityEnvelope } = await import('../scripts/mlb/source-adapters/liquidity-readonly.mjs');

  const outputDir = 'state/mlb/2026-05-15/discovery';
  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const runDate = '2026-05-15';

  const kalshi = fixtureKalshiSuccessEnvelope({ checkedAtUtc, outputDir });
  const mlb = fixtureMlbScheduleEnvelope({ runDate, checkedAtUtc, outputDir });
  const weather = fixtureWeatherEnvelope({ runDate, checkedAtUtc, outputDir });
  const liquidity = fixtureLiquidityEnvelope({ checkedAtUtc, outputDir });
  const baseballSavant = {
    source_id: 'baseball_savant',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [{ query_type: 'fixture' }],
    warnings: ['Fixture mode: placeholder'],
    errors: [],
    source_urls: [],
  };

  const result = scoreMarkets({ kalshi, mlb, baseballSavant, weather, liquidity });

  assert.equal(result.fixture_mode, true);
  assert.equal(result.counts.clear_pick, 0);
  for (const candidate of result.candidates) {
    assert.notEqual(candidate.classification, 'CLEAR_PICK');
  }
});

test('output writer reads optional liquidity adapter when present', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { composeMlbDailyOutputs } = await import('../scripts/mlb/output-writer-core.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'mlb-output-writer-'));
  const discoveryDir = join(dir, 'discovery');
  const outDir = join(dir, 'out');
  mkdirSync(discoveryDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const checkedAtUtc = '2026-05-15T14:00:00.000Z';
  const baseEnvelope = (sourceId) => ({
    source_id: sourceId,
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    records: [],
    warnings: [],
    errors: [],
    source_urls: [],
  });

  writeFileSync(join(discoveryDir, 'kalshi_adapter.json'), JSON.stringify(baseEnvelope('kalshi')));
  writeFileSync(join(discoveryDir, 'mlb_official_adapter.json'), JSON.stringify(baseEnvelope('mlb_official')));
  writeFileSync(
    join(discoveryDir, 'liquidity_adapter.json'),
    JSON.stringify({
      source_id: 'liquidity',
      status: 'ok',
      checked_at_utc: checkedAtUtc,
      records: [{ market_ticker: 'TEST-MKT' }],
      warnings: [],
      errors: [],
      source_urls: [],
    }),
  );

  try {
    composeMlbDailyOutputs({
      runDate: '2026-05-15',
      discoveryDir,
      outDir,
      now: new Date(checkedAtUtc),
    });

    const registry = JSON.parse(readFileSync(join(outDir, 'source_registry.json'), 'utf8'));
    const sourceIds = registry.sources.map(s => s.source_id);
    assert.ok(sourceIds.includes('liquidity'), `Expected 'liquidity' in source_ids, got: ${sourceIds.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
