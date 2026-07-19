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
}

test('morning_proxy packet keeps FAST READ and full-slate lines <= 80 chars', () => {
  const slate = buildMlbSlatePacket({
    date: '2026-06-21',
    scoring: { picks: [pick], summaryCounts: { pre_lineup_pick: 1 } },
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
