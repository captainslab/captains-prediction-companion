import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

import { buildFighterEntry } from '../scripts/ufc/lib/stats-to-layers.mjs';
import { parseUfcStatsPage, searchFighterUrl } from '../scripts/ufc/lib/source-fetcher.mjs';
import { renderUfcModelScores } from '../scripts/ufc/lib/model-score-matrix.mjs';
import { renderUfcPacket } from '../scripts/ufc/lib/packet-renderer.mjs';
import { buildCompositeCard } from '../scripts/packets/generate-ufc-weekly.mjs';

function fullFighterStats(overrides = {}) {
  return {
    slpm: 5.5,
    str_acc: 55,
    sapm: 3.0,
    str_def: 58,
    td_avg: 2.5,
    td_acc: 50,
    td_def: 72,
    sub_avg: 0.8,
    height: '5\' 11"',
    reach: 73,
    stance: 'Switch',
    record: { wins: 15, losses: 3, draws: 0 },
    fights: [
      { result: 'win', method: 'KO/TKO' },
      { result: 'win', method: 'U-DEC' },
      { result: 'win', method: 'KO/TKO' },
      { result: 'loss', method: 'U-DEC' },
      { result: 'win', method: 'SUB' },
    ],
    ...overrides,
  };
}

function weakFighterStats(overrides = {}) {
  return {
    slpm: 2.5,
    str_acc: 38,
    sapm: 5.5,
    str_def: 40,
    td_avg: 0.5,
    td_acc: 25,
    td_def: 45,
    sub_avg: 0.2,
    height: '5\' 8"',
    reach: 68,
    stance: 'Orthodox',
    record: { wins: 8, losses: 6, draws: 0 },
    fights: [
      { result: 'loss', method: 'KO/TKO' },
      { result: 'loss', method: 'U-DEC' },
      { result: 'win', method: 'U-DEC' },
      { result: 'loss', method: 'SUB' },
      { result: 'win', method: 'U-DEC' },
    ],
    ...overrides,
  };
}

test('buildFighterEntry produces all configured UFC layers', () => {
  const entry = buildFighterEntry(fullFighterStats());
  for (const key of [
    'striking_offense',
    'striking_defense',
    'grappling_offense',
    'grappling_defense',
    'opponent_adjusted_striking',
    'opponent_adjusted_grappling',
    'finish_power',
    'durability',
    'cardio_pace',
    'recent_form',
    'physical_style',
  ]) {
    assert.equal(entry[key].present, true, `${key} should be present`);
    assert.equal(typeof entry[key].score, 'number', `${key} should be scored`);
  }
  assert.equal(entry.profile.source_quality, 'high');
});

test('UFCStats parser preserves opponent, round, time, and per-fight stat rows when available', () => {
  const md = `## Michael Chandler     Record: 23-10-0

_Career statistics:_

- _SLpM:_

4.04

- _Str. Acc.:_
49%

- _SApM:_
4.52

- _Str. Def:_
43%

- _TD Avg.:_

1.96

- _TD Acc.:_
41%

- _TD Def.:_
61%

- _Sub. Avg.:_
0.6

| W/L | Fighter | KD | Str | TD | Sub | Event | Method | Round | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [_loss_](http://www.ufcstats.com/fight-details/d05cb4c4135ce402) | [Michael Chandler](http://www.ufcstats.com/fighter-details/4b93a88f3b1de35b)<br>[Paddy Pimblett](http://www.ufcstats.com/fighter-details/7826923b47f8d72a) | 0<br> <br>0 | 11<br> <br>80 | 4<br> <br>1 | 0<br> <br>0 | [UFC 314: Volkanovski vs. Lopes](http://www.ufcstats.com/event-details/22f4b6cb6b1bd7fd)<br> <br>Apr. 12, 2025 | KO/TKO<br> <br> <br>Elbows | 3 | 3:07 |`;
  const stats = parseUfcStatsPage(md);
  assert.equal(stats.fights.length, 1);
  assert.equal(stats.fights[0].opponent, 'Paddy Pimblett');
  assert.equal(stats.fights[0].round, 3);
  assert.equal(stats.fights[0].time, '3:07');
  assert.equal(stats.fights[0].sig_str_for, 11);
  assert.equal(stats.fights[0].sig_str_against, 80);
  assert.equal(stats.fights[0].td_for, 4);
  assert.equal(stats.fights[0].td_against, 1);
});

test('searchFighterUrl extracts exact fighter URL from UFCStats alphabetic table', () => {
  const md = `| First | Last | Nickname | Ht. |
| --- | --- | --- | --- |
| [Michael](http://www.ufcstats.com/fighter-details/4b93a88f3b1de35b) | [Chandler](http://www.ufcstats.com/fighter-details/4b93a88f3b1de35b) | [Iron](http://www.ufcstats.com/fighter-details/4b93a88f3b1de35b) | 5' 8" |
| [Mike](http://www.ufcstats.com/fighter-details/f5585e675af7afd4) | [Campbell](http://www.ufcstats.com/fighter-details/f5585e675af7afd4) | [The Beast](http://www.ufcstats.com/fighter-details/f5585e675af7afd4) | 5' 9" |`;
  assert.equal(searchFighterUrl(md, 'Michael Chandler'), 'http://www.ufcstats.com/fighter-details/4b93a88f3b1de35b');
});

test('UFC model-score matrix exposes every fighter and fight-lane model without market prices', () => {
  const fight = {
    fighter_a_name: 'Alpha',
    fighter_b_name: 'Beta',
    fighter_a_ledger: buildFighterEntry(fullFighterStats()),
    fighter_b_ledger: buildFighterEntry(weakFighterStats()),
    fighter_a_score: 82,
    fighter_b_score: 61,
    fighter_a_posture: 'PICK',
    fighter_b_posture: 'PICK',
    fighter_a_layers: 11,
    fighter_b_layers: 11,
    favored: 'Alpha',
    edge_score: 21,
    posture: 'PICK',
    lanes: {
      winner: { lean: 'Alpha' },
      method_of_victory: { method: 'KO/TKO', confidence: 78, ko_tko: 80, submission: 32, decision: 24 },
      go_the_distance: { goes_distance: 'NO', confidence: 62, yes: 22, no: 78 },
      round_of_victory: { lean: 'EARLY', confidence: 71, early: 73, mid: 50, late: 22 },
      round_of_finish: { lean: 'EARLY', confidence: 69, early: 70, mid: 48, late: 25 },
      method_of_finish: { method: 'KO/TKO', confidence: 79, ko_tko: 81, submission: 30, decision: 23 },
    },
  };
  const text = renderUfcModelScores({ cardTitle: 'Test', date: '2099-01-03', card: { fights: [fight] } });
  assert.match(text, /fighter_composite: Alpha score=/);
  assert.match(text, /fighter_composite: Beta score=/);
  assert.match(text, /winner_model:/);
  assert.match(text, /go_the_distance_model:/);
  assert.doesNotMatch(text, /bid=|ask=|last=|vol=|open_interest|yes_bid|yes_ask|last_price|volume_fp/);
});

test('UFC composite path consumes cached stats and all lane events without price scoring', () => {
  const tmp = mkdtempSync(join(osTmpdir(), 'ufc-composite-generator-'));
  try {
    const cacheDir = join(tmp, 'ufc', 'sources');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'alpha-fighter.json'), JSON.stringify({ stats: fullFighterStats() }), 'utf8');
    writeFileSync(join(cacheDir, 'beta-fighter.json'), JSON.stringify({ stats: weakFighterStats() }), 'utf8');

    const winner = {
      event_ticker: 'KXUFCFIGHT-99JAN03ALPBET',
      title: 'Alpha Fighter vs Beta Fighter',
      sub_title: 'UFC test card',
      series_ticker: 'KXUFCFIGHT',
      markets: [
        {
          ticker: 'KXUFCFIGHT-99JAN03ALPBET-ALPHA',
          yes_sub_title: 'Alpha Fighter',
          no_sub_title: 'Beta Fighter',
          yes_bid_dollars: '0.42',
          yes_ask_dollars: '0.45',
          last_price_dollars: '0.44',
          volume_fp: '150',
        },
        {
          ticker: 'KXUFCFIGHT-99JAN03ALPBET-BETA',
          yes_sub_title: 'Beta Fighter',
          no_sub_title: 'Alpha Fighter',
          yes_bid_dollars: '0.55',
          yes_ask_dollars: '0.58',
          last_price_dollars: '0.56',
          volume_fp: '120',
        },
      ],
    };
    const laneEvents = [
      winner,
      { event_ticker: 'KXUFCMOV-99JAN03ALPBET', title: 'Alpha Fighter vs Beta Fighter: Method of Victory', markets: [{ ticker: 'MOV1' }] },
      { event_ticker: 'KXUFCDISTANCE-99JAN03ALPBET', title: 'Alpha Fighter vs Beta Fighter: To Go The Distance', markets: [{ ticker: 'DIST' }] },
      { event_ticker: 'KXUFCVICROUND-99JAN03ALPBET', title: 'Alpha Fighter vs Beta Fighter: Round of Victory', markets: [{ ticker: 'VIC1' }] },
      { event_ticker: 'KXUFCROUNDS-99JAN03ALPBET', title: 'Alpha Fighter vs Beta Fighter: Round of Finish', markets: [{ ticker: 'ROF1' }] },
      { event_ticker: 'KXUFCMOF-99JAN03ALPBET', title: 'Alpha Fighter vs Beta Fighter: Method of Finish', markets: [{ ticker: 'MOF1' }] },
    ];

    const composite = buildCompositeCard({
      kalshiEvents: [winner],
      allLaneEvents: laneEvents,
      cacheDir,
      date: '2099-01-03',
    });
    assert.equal(composite.scoredFights, 1);
    assert.equal(composite.fights[0].market_context.lane_events.length, 6);

    const text = renderUfcPacket({
      cardTitle: composite.cardTitle,
      date: '2099-01-03',
      card: { fights: composite.fights },
      sources: ['UFCStats.com'],
    });
    assert.match(text, /round of finish:/);
    assert.match(text, /captured lanes:/);
    assert.doesNotMatch(text, /bid=|ask=|last=|vol=/, 'customer packet must not print raw market prices');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
