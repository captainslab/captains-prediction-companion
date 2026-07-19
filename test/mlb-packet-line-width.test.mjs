import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildKalshiGamePacket,
  buildMlbSlatePacket,
} from '../scripts/packets/generate-mlb-daily.mjs';

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
      gamePicks: [{ ...pick, classification: 'PRE_LINEUP_PICK', kalshi_ask: null }],
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
