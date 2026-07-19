import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildKalshiGamePacket,
  buildMlbSlatePacket,
  buildGamePreviewStory,
} from '../scripts/packets/generate-mlb-daily.mjs';
import { buildGameProjections, poissonDistribution } from '../scripts/mlb/lib/projection-engine.mjs';

const statsRecord = {
  ...JSON.parse(readFileSync(
    join(import.meta.dirname, 'fixtures', 'mlb-stats-adapter.json'),
    'utf8',
  )).records[0],
  lineup_status: 'confirmed',
  weather_status: 'complete',
};

const pick = {
  market_ticker: 'KXMLBGAME-26JUN211605LAAATH-LAA',
  game: 'Los Angeles Angels at Athletics',
  contract_title: 'Los Angeles Angels',
  classification: 'PRE_LINEUP_PICK',
  market_lane: 'moneyline',
  matched_game_pk: 824987,
  fair_value: 0.62,
  kalshi_ask: 0.4,
  edge_pp: 22,
  gates_passed: ['starter confirmed', 'lineup confirmed', 'weather updated'],
  missing_confirmations: [],
};

const baseProjection = buildGameProjections({
  record: statsRecord,
  leagueRPG: 4.36,
  as_of: '2026-06-21T00:00:00Z',
  lineup_status: 'confirmed',
  weather_status: 'complete',
});

function syntheticProjection({ awayRuns = 4.1, homeRuns = 4.1, homeProbability = 0.5 } = {}) {
  return {
    ...baseProjection,
    means: { lambdaAway: awayRuns, lambdaHome: homeRuns },
    score: {
      ...baseProjection.score,
      status: 'official',
      lineup_status: 'confirmed',
      weather_status: 'complete',
      outputs: {
        ...baseProjection.score.outputs,
        moneyline_home: homeProbability,
        team_runs_distribution: {
          away: poissonDistribution(awayRuns, 12),
          home: poissonDistribution(homeRuns, 12),
        },
        total_runs_distribution: poissonDistribution(awayRuns + homeRuns, 20),
      },
    },
  };
}

function buildSyntheticMorningPacket({ projection, pickOverrides = {} } = {}) {
  return buildMlbSlatePacket({
    date: '2026-06-21',
    scoring: {
      picks: [{
        ...pick,
        classification: 'PASS',
        primary_pick: true,
        kalshi_ask: null,
        ...pickOverrides,
      }],
      summaryCounts: { pass: 1 },
    },
    slateGames: [{
      officialRecord: {
        game_pk: 824987,
        event_ticker: 'KXMLBGAME-26JUN211605LAAATH',
        status: 'Scheduled',
        start_time_utc: '2026-06-21T19:05:00Z',
      },
      statsRecord,
      projection,
    }],
    leagueRPG: 4.36,
  });
}

function assertPacketLinesUnder80(label, text) {
  const offenders = text.split(/\r?\n/)
    .map((line, index) => ({ line, length: line.length, number: index + 1 }))
    .filter(({ length }) => length > 80);
  assert.deepEqual(offenders, [], `${label} has lines over 80 characters`);

  const tableRows = text.split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /^\s*\|.*\|\s*$/.test(line));
  assert.deepEqual(tableRows, [], `${label} contains a literal pipe-delimited table row`);

  const paragraphLine = (line) => {
    const trimmed = line.trim();
    return Boolean(trimmed)
      && !line.startsWith(' ')
      && !trimmed.includes(':')
      && !/^[A-Z0-9 /_-]+$/.test(trimmed);
  };
  let paragraphRun = 0;
  let maxParagraphRun = 0;
  for (const line of text.split(/\r?\n/)) {
    if (paragraphLine(line)) {
      paragraphRun += 1;
      maxParagraphRun = Math.max(maxParagraphRun, paragraphRun);
    } else {
      paragraphRun = 0;
    }
  }
  assert.ok(maxParagraphRun <= 3, `${label} has a paragraph block over 3 non-blank lines`);

  const majorHeaders = [
    'IMPORTANT', 'MARKET CONTEXT', 'FAST READ', 'OPERATIONS WATCH',
    'FULL SLATE BOARD', 'MODEL AVAILABILITY', 'GAME MODEL', 'PLAYER PROPS',
    'ANYTIME HOME RUN', 'MODEL LIMITATIONS', 'MARKET COMPARISON',
    'SOURCE STATUS', 'DELIVERY AND AUDIT',
  ];
  const lines = text.split(/\r?\n/);
  for (const header of majorHeaders) {
    lines.forEach((line, index) => {
      if (line.trim() !== header || index === 0) return;
      assert.equal(lines[index - 1].trim(), '', `${label}: ${header} needs a blank line before it`);
    });
  }
}

test('morning_proxy packet keeps FAST READ and full-slate lines <= 80 chars', () => {
  const slate = buildMlbSlatePacket({
    date: '2026-06-21',
    scoring: { picks: [{ ...pick, kalshi_ask: null }], summaryCounts: { pre_lineup_pick: 1 } },
    slateGames: [{
      officialRecord: {
        game_pk: 824987,
        status: 'Scheduled',
        start_time_utc: '2026-06-21T19:05:00Z',
      },
      statsRecord,
    }],
    leagueRPG: 4.36,
  });

  assert.ok(slate, 'morning_proxy packet should render');
  assertPacketLinesUnder80('morning_proxy', slate.text);
  assert.match(slate.text, /TOP SIDE POSTURES\n  1\. Los Angeles Angels AT Athletics/);
  assert.match(slate.text, /Model posture:/);
  assert.match(slate.text, /Projected score:/);
  assert.match(slate.text, /CPC projected spread/);
  assert.match(slate.text, /Projected win probability/);
  assert.match(slate.text, /MARKET COMPARISON[\s\S]*The CPC projection remains visible/);
});

test('confirmed_lineup packet keeps GAME MODEL lines <= 80 chars', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cpc-mlb-line-width-'));
  try {
    const packet = buildKalshiGamePacket({
      date: '2026-06-21',
      stateRoot,
      event: {
        event_ticker: 'KXMLBGAME-26JUN211605LAAATH',
        title: 'Los Angeles Angels at Athletics',
        away_full: 'Los Angeles Angels',
        home_full: 'Athletics',
        venue: 'Synthetic Park',
        start_utc: '2026-06-21T19:05:00Z',
      },
      artifacts: [],
      primeAttempts: [],
      kalshiSummary: { ok: true, total: 1, matched: 1, error: null },
      sourcePath: 'synthetic://mlb/event',
      sourceRefs: {
        event: 'synthetic://mlb/official',
        stats: 'synthetic://mlb/stats',
        weather: 'synthetic://mlb/weather',
        context: 'synthetic://mlb/context',
      },
      gamePicks: [{ ...pick, classification: 'PASS' }],
      statsRecord,
      leagueRPG: 4.36,
      scope: 'GAME_PACKET',
    });

    assertPacketLinesUnder80('confirmed_lineup', packet.text);
    assert.match(packet.text, /GAME MODEL/);
    assert.match(packet.text, /CPC projected total/);
    assert.match(packet.text, /Projected win probability/);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('renderers use score-derived spread, honest market fallback, and safe audit text', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cpc-mlb-template-'));
  try {
    const packet = buildKalshiGamePacket({
      date: '2026-06-21',
      stateRoot,
      event: {
        event_ticker: 'KXMLBGAME-26JUN211605LAAATH',
        title: 'Los Angeles Angels at Athletics',
        away_full: 'Los Angeles Angels',
        home_full: 'Athletics',
        venue: 'Synthetic Park',
        start_utc: '2026-06-21T19:05:00Z',
      },
      gamePicks: [{ ...pick, classification: 'PASS', kalshi_ask: null }],
      statsRecord,
      leagueRPG: 4.36,
      scope: 'GAME_PACKET',
      sourceRefs: {
        event: '/home/jordan/private/state/mlb/official.json',
        stats: '/home/jordan/private/state/mlb/stats.json',
        weather: '/home/jordan/private/state/mlb/weather.json',
        context: '/home/jordan/private/state/mlb/context.json',
      },
      audit: {
        game_pk: 824987,
        run_id: 'run-1',
        input_hash: 'a'.repeat(64),
        output_hash: 'b'.repeat(64),
        canonical_state_reference: '/home/jordan/private/state/mlb/run.json',
        artifact_name: '/home/jordan/private/packet.txt',
      },
    });

    assert.match(packet.text, /CALCULATION\n\s+[0-9]+\.[0-9]\n\s+minus\n\s+[0-9]+\.[0-9]\n\s+equals\n\s+[0-9]+\.[0-9]/);
    const projectedScore = packet.text.match(/Los Angeles Angels: ([0-9]+\.[0-9])[\s\S]*Athletics: ([0-9]+\.[0-9])/);
    const projectedSpread = packet.text.match(/CPC projected spread — Los Angeles Angels -([0-9]+\.[0-9])/);
    assert.ok(projectedScore && projectedSpread, 'projected score and spread should render');
    assert.equal(Number(projectedSpread[1]), Number((Number(projectedScore[1]) - Number(projectedScore[2])).toFixed(1)));
    assert.doesNotMatch(packet.text, /market run-line/i);
    assert.match(packet.text, /MARKET COMPARISON[\s\S]*STATUS[\s\S]*Unavailable[\s\S]*The CPC projection remains visible/);
    assert.match(packet.text, /PROJECTED SCORE/);
    assert.match(packet.text, /PLAYER PROPS/);
    assert.match(packet.text, /ANYTIME HOME RUN/);
    assert.doesNotMatch(packet.text, /PRE_LINEUP_PICK/);
    assert.doesNotMatch(packet.text, /a{64}|b{64}|\/home\/jordan\/|state\/mlb\//);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('tied projected score renders pick\'em and an even-margin narrative', () => {
  const packet = buildSyntheticMorningPacket({
    projection: syntheticProjection({ awayRuns: 4.1, homeRuns: 4.1, homeProbability: 0.51 }),
  });

  assert.match(packet.text, /CPC projected spread — pick'em \(4\.1 \/ 4\.1\)/);
  assert.match(packet.text, /projected scoring margin is even/i);
  assert.match(packet.text, /score-distribution shape, not the expected-run difference/i);
  assert.doesNotMatch(packet.text, /projected run split favors/i);
});

test('projection-only posture survives absent market data and keeps model families visible', () => {
  const packet = buildSyntheticMorningPacket({
    projection: syntheticProjection({ awayRuns: 5.2, homeRuns: 3.4, homeProbability: 0.86 }),
    pickOverrides: {
      classification: 'PASS',
      primary_pick: false,
      fair_value: null,
      kalshi_ask: null,
      edge_pp: null,
    },
  });

  assert.match(packet.text, /MODEL POSTURE: STRONG LEAN/);
  assert.match(packet.text, /PROJECTED SCORE:/);
  assert.match(packet.text, /CPC projected spread/);
  assert.match(packet.text, /CPC projected total/);
  assert.match(packet.text, /Projected win probability/);
  assert.match(packet.text, /YRFI\/NRFI/);
  assert.match(packet.text, /Reid Detmers .*STRIKEOUTS/);
  assert.match(packet.text, /Jack Perkins .*STRIKEOUTS/);
  assert.doesNotMatch(packet.text, /NO CLEAR PICK/);
  assert.doesNotMatch(packet.text, /BLOCKED_SOURCE_GAP/);
});

test('run and win favorites are independently named in WHY and storyline', () => {
  const projection = syntheticProjection({ awayRuns: 5.2, homeRuns: 3.4, homeProbability: 0.86 });
  const packet = buildSyntheticMorningPacket({ projection });
  const story = buildGamePreviewStory({
    event: { away_full: 'Los Angeles Angels', home_full: 'Athletics' },
    statsRecord,
    read: { call: 'NO CLEAR PICK', reason: 'single modeled family only' },
    projections: projection,
    posture: 'STRONG LEAN',
  }).join('\n');

  assert.match(packet.text, /Athletics carries the stronger model win probability\s+at 86\.0%/);
  assert.doesNotMatch(packet.text, /Los Angeles Angels carries the stronger model win probability\s+at 14\.0%/);
  assert.match(story, /projected run split favors Los Angeles Angels 5\.2 to 3\.4/);
  assert.match(story, /Athletics has the stronger model win probability at 86\.0%/);
  assert.doesNotMatch(story, /Los Angeles Angels has the stronger model win probability at 14\.0%/);
});

test('confirmed_lineup rejects stale PRE_LINEUP_PICK state instead of renaming it', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cpc-mlb-confirmed-contract-'));
  try {
    assert.throws(() => buildKalshiGamePacket({
      date: '2026-06-21',
      stateRoot,
      event: {
        event_ticker: 'KXMLBGAME-26JUN211605LAAATH',
        title: 'Los Angeles Angels at Athletics',
        away_full: 'Los Angeles Angels',
        home_full: 'Athletics',
        venue: 'Synthetic Park',
        start_utc: '2026-06-21T19:05:00Z',
      },
      gamePicks: [{ ...pick, classification: 'PRE_LINEUP_PICK' }],
      statsRecord,
      leagueRPG: 4.36,
      scope: 'GAME_PACKET',
    }), /CONFIRMED_LINEUP_CONTRACT_VIOLATION.*PRE_LINEUP_PICK/);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('displayed CPC model probability is projection-derived, not ask/fair_value-derived', () => {
  const projection = syntheticProjection({ awayRuns: 4.0, homeRuns: 4.6, homeProbability: 0.64 });
  const lowAsk = buildSyntheticMorningPacket({
    projection,
    pickOverrides: { team_side: 'home', fair_value: 0.02, kalshi_ask: 0.25, edge_pp: 39 },
  });
  const highAsk = buildSyntheticMorningPacket({
    projection,
    pickOverrides: { team_side: 'home', fair_value: 0.98, kalshi_ask: 0.75, edge_pp: -11 },
  });
  const modelProbability = (text) => text.match(/CPC model probability\n\s+([0-9.]+%)/)?.[1];

  assert.equal(modelProbability(lowAsk.text), '64.0%');
  assert.equal(modelProbability(highAsk.text), '64.0%');
  assert.match(lowAsk.text, /Market implied probability\n\s+25\.0%/);
  assert.match(highAsk.text, /Market implied probability\n\s+75\.0%/);
});
