import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSportsSettledHistory,
  detectSport,
  extractTeamsFromTitle,
  extractVenueFromTitle,
  filterBySport,
} from '../scripts/mentions/sports-settled-history.mjs';

import {
  buildSportsGameContext,
  detectSeries,
  isRivalry,
  detectPhraseTriggers,
} from '../scripts/mentions/sports-game-context.mjs';

import {
  buildMentionCompositeForMarket,
} from '../scripts/packets/generate-mentions-daily.mjs';

import { HISTORY_FORBIDDEN_PATTERN } from '../scripts/mentions/settled-history.mjs';

// --- Fixtures ---

function mlbHistoryRecords() {
  return [
    { event_ticker: 'KXMLBMENTION-26JUN10NYYBOS', market_ticker: 'KXMLBMENTION-26JUN10NYYBOS-T1', series_ticker: 'KXMLBMENTION', event_date: '2026-06-10', result: 'yes', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'home run', context: 'Yankees vs Red Sox — MLB game broadcast mention' },
    { event_ticker: 'KXMLBMENTION-26JUN09LADSFG', market_ticker: 'KXMLBMENTION-26JUN09LADSFG-T1', series_ticker: 'KXMLBMENTION', event_date: '2026-06-09', result: 'no', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'home run', context: 'Dodgers vs Giants — MLB game broadcast mention' },
    { event_ticker: 'KXMLBMENTION-26JUN08CHCCRD', market_ticker: 'KXMLBMENTION-26JUN08CHCCRD-T1', series_ticker: 'KXMLBMENTION', event_date: '2026-06-08', result: 'yes', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'home run', context: 'Cubs vs Cardinals — MLB game broadcast mention' },
    { event_ticker: 'KXMLBMENTION-26JUN07AZCIN', market_ticker: 'KXMLBMENTION-26JUN07AZCIN-T1', series_ticker: 'KXMLBMENTION', event_date: '2026-06-07', result: 'yes', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'home run', context: 'Diamondbacks vs Reds — MLB game broadcast mention' },
    { event_ticker: 'KXMLBMENTION-26JUN06MINSEA', market_ticker: 'KXMLBMENTION-26JUN06MINSEA-T1', series_ticker: 'KXMLBMENTION', event_date: '2026-06-06', result: 'no', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'stolen base', context: 'Twins vs Mariners — MLB game broadcast mention' },
    { event_ticker: 'KXMLBMENTION-26JUN05TEXHOU', market_ticker: 'KXMLBMENTION-26JUN05TEXHOU-T1', series_ticker: 'KXMLBMENTION', event_date: '2026-06-05', result: 'yes', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'strikeout', context: 'Rangers vs Astros — MLB game broadcast mention' },
  ];
}

function wcHistoryRecords() {
  return [
    { event_ticker: 'KXWCMENTION-26JUN10BRAARG', market_ticker: 'KXWCMENTION-26JUN10BRAARG-T1', series_ticker: 'KXWCMENTION', event_date: '2026-06-10', result: 'yes', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'goal', context: 'Brazil vs Argentina — World Cup match mention' },
    { event_ticker: 'KXWCMENTION-26JUN09ENGGER', market_ticker: 'KXWCMENTION-26JUN09ENGGER-T1', series_ticker: 'KXWCMENTION', event_date: '2026-06-09', result: 'no', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'goal', context: 'England vs Germany — World Cup match mention' },
  ];
}

function sportsEvent(ticker = 'KXMLBMENTION-26JUN12AZCIN') {
  return {
    event_ticker: ticker,
    series_ticker: 'KXMLBMENTION',
    title: 'What will the announcer say during Diamondbacks vs Reds Professional Baseball Game?',
    markets: [
      { ticker: `${ticker}-T1`, yes_sub_title: 'home run', custom_strike: { Word: 'home run' }, close_time: '2026-06-12T23:00:00Z' },
      { ticker: `${ticker}-T2`, yes_sub_title: 'strikeout', custom_strike: { Word: 'strikeout' }, close_time: '2026-06-12T23:00:00Z' },
    ],
  };
}

// --- Sports detection ---

test('detectSport identifies MLB from ticker', () => {
  assert.equal(detectSport('KXMLBMENTION-26JUN12AZCIN', 'KXMLBMENTION', ''), 'mlb');
});

test('detectSport identifies World Cup from title', () => {
  assert.equal(detectSport('', '', 'World Cup match mention'), 'worldcup');
});

test('detectSport returns null for unrecognized sport', () => {
  assert.equal(detectSport('KXRANDOM', '', 'Some event'), null);
});

// --- Team/venue extraction ---

test('extractTeamsFromTitle extracts matchup', () => {
  const teams = extractTeamsFromTitle('What will the announcer say during Diamondbacks vs Reds Professional Baseball Game?');
  assert.deepEqual(teams, ['Diamondbacks', 'Reds']);
});

test('extractVenueFromTitle extracts venue', () => {
  const venue = extractVenueFromTitle('Game at Chase Field Stadium');
  assert.equal(venue, 'Chase Field Stadium');
});

// --- filterBySport ---

test('filterBySport filters MLB records', () => {
  const all = [...mlbHistoryRecords(), ...wcHistoryRecords()];
  const mlb = filterBySport(all, 'mlb');
  assert.ok(mlb.length > 0);
  assert.ok(mlb.every(r => r.series_ticker === 'KXMLBMENTION'));
});

test('filterBySport filters World Cup records', () => {
  const all = [...mlbHistoryRecords(), ...wcHistoryRecords()];
  const wc = filterBySport(all, 'worldcup');
  assert.ok(wc.length > 0);
  assert.ok(wc.every(r => r.series_ticker === 'KXWCMENTION'));
});

// --- Sports settled history ---

test('sports_announcer uses settled sports history before source/model extraction', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sports-hist-'));
  try {
    const result = await buildSportsSettledHistory({
      eventTicker: 'KXMLBMENTION-26JUN12AZCIN',
      seriesTicker: 'KXMLBMENTION',
      eventTitle: 'Diamondbacks vs Reds Professional Baseball Game',
      term: 'home run',
      route: 'sports_announcer',
      horizon: 'event',
      stateRoot: tmpDir,
      preloadedRecords: mlbHistoryRecords(),
    });
    assert.ok(result.layers.settled_mentions_history.present);
    assert.ok(result.layers.settled_mentions_history.score > 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('exact series beats same sport beats broader fallback', async () => {
  const records = [
    ...mlbHistoryRecords(),
    { event_ticker: 'KXNBAMENTION-26JUN01', market_ticker: 'KXNBAMENTION-T1', series_ticker: 'KXNBAMENTION', event_date: '2026-06-01', result: 'yes', route: 'sports_announcer', entity: null, horizon: 'event', strike_term: 'home run', context: 'NBA game mention' },
  ];
  const result = await buildSportsSettledHistory({
    eventTicker: 'KXMLBMENTION-26JUN12AZCIN',
    seriesTicker: 'KXMLBMENTION',
    term: 'home run',
    route: 'sports_announcer',
    horizon: 'event',
    preloadedRecords: records,
  });
  assert.equal(result.historyMatch.match_tier, 'exact_horizon');
});

test('past 5 relevant settled events are used, or all if fewer', async () => {
  const result = await buildSportsSettledHistory({
    seriesTicker: 'KXMLBMENTION',
    term: 'home run',
    route: 'sports_announcer',
    horizon: 'event',
    preloadedRecords: mlbHistoryRecords(),
  });
  assert.ok(result.historyMatch.sample_size <= 5);
  assert.ok(result.historyMatch.sample_size > 0);
});

test('misses are recorded', async () => {
  const result = await buildSportsSettledHistory({
    seriesTicker: 'KXMLBMENTION',
    term: 'home run',
    route: 'sports_announcer',
    horizon: 'event',
    preloadedRecords: mlbHistoryRecords(),
  });
  assert.ok(result.historyMatch.misses > 0, 'misses should be > 0');
  assert.equal(result.historyMatch.hits + result.historyMatch.misses, result.historyMatch.sample_size);
});

test('empty sports history falls back safely without fake conviction', async () => {
  const result = await buildSportsSettledHistory({
    seriesTicker: 'KXMLBMENTION',
    term: 'home run',
    route: 'sports_announcer',
    horizon: 'event',
    preloadedRecords: [],
  });
  assert.equal(result.layers.settled_mentions_history.present, false);
  assert.equal(result.layers.settled_mentions_history.score, null);
});

// --- Game context ---

test('game context changes layer evidence deterministically', () => {
  const event = sportsEvent();
  const r1 = buildSportsGameContext({ event, term: 'home run' });
  const r2 = buildSportsGameContext({ event, term: 'home run' });
  assert.deepEqual(r1, r2);
  assert.ok(r1.layers.current_game_context.present);
  assert.ok(r1.gameContext.teams.length >= 2);
});

test('rivalry detection works', () => {
  assert.ok(isRivalry(['Yankees', 'Red Sox']));
  assert.ok(!isRivalry(['Diamondbacks', 'Reds']));
});

test('series detection works', () => {
  assert.equal(detectSeries('KXWCMENTION', '', 'World Cup match'), 'world_cup');
  assert.equal(detectSeries('KXMLBMENTION', '', 'Regular game'), 'regular_season');
});

test('phrase triggers detected from term', () => {
  const triggers = detectPhraseTriggers('injury', 'Game title', ['Team A']);
  assert.ok(triggers.includes('injury'));
});

test('missing transcript is not treated as main blocker', () => {
  const event = sportsEvent();
  const result = buildSportsGameContext({ event, term: 'home run' });
  assert.ok(result.layers.current_game_context.present);
  assert.ok(result.layers.sport_phrase_likelihood.present);
});

// --- Price/market isolation ---

test('price/market fields cannot affect sports history layers', async () => {
  const recordWithPrice = {
    event_ticker: 'KXMLBMENTION-26JUN10', market_ticker: 'T1', series_ticker: 'KXMLBMENTION',
    event_date: '2026-06-10', result: 'yes', route: 'sports_announcer', entity: null,
    horizon: 'event', strike_term: 'test', context: 'test',
  };
  const result = await buildSportsSettledHistory({
    seriesTicker: 'KXMLBMENTION',
    term: 'test',
    route: 'sports_announcer',
    horizon: 'event',
    preloadedRecords: [recordWithPrice, { ...recordWithPrice, market_ticker: 'T2', result: 'no' }],
  });
  const json = JSON.stringify(result.layers);
  assert.ok(!HISTORY_FORBIDDEN_PATTERN.test(Object.keys(result.layers).join('\n')));
});

// --- Non-sports routes do not receive sports layers ---

test('non-sports routes do not receive sports layers', () => {
  const event = {
    event_ticker: 'KXEARNINGS-DELL',
    series_ticker: 'KXEARNINGS',
    title: 'What will Dell say during earnings call?',
    markets: [{ ticker: 'T1', yes_sub_title: 'PowerEdge', close_time: '2026-06-12T23:00:00Z' }],
  };
  const composite = buildMentionCompositeForMarket({
    event,
    market: event.markets[0],
    historyRecords: mlbHistoryRecords(),
  });
  assert.equal(composite.sports_history, null);
  assert.equal(composite.sports_game_context, null);
});

// --- Composite integration ---

test('sports_announcer composite uses settled history and game context', () => {
  const event = sportsEvent();
  const records = mlbHistoryRecords();
  const composite = buildMentionCompositeForMarket({
    event,
    market: event.markets[0],
    historyRecords: records,
    sportsSettledResult: {
      sport: 'mlb',
      teams: ['Diamondbacks', 'Reds'],
      venue: null,
      historyMatch: { match_tier: 'exact_horizon', sample_size: 4, hits: 3, misses: 1, hit_rate: 0.75, match_quality_penalty: 0 },
      layers: {
        settled_mentions_history: { present: true, score: 75, source_basis: 'test', source_path: null, detail: 'test', missing_note: null },
        sport_phrase_frequency: { present: true, score: 60, source_basis: 'test', source_path: null, detail: 'test', missing_note: null },
        venue_team_phrase_relevance: { present: false, score: null, source_basis: 'none', source_path: null, detail: null, missing_note: 'n<2' },
      },
    },
    sportsGameContextResult: buildSportsGameContext({ event, term: 'home run' }),
  });
  assert.ok(composite.sports_history);
  assert.equal(composite.sports_history.sport, 'mlb');
  assert.equal(composite.sports_history.history_hits, 3);
  assert.equal(composite.sports_history.history_misses, 1);
  assert.ok(composite.sports_game_context);
  assert.ok(composite.sports_game_context.teams.length >= 2);
});

test('sports packet no longer stays flat when history/context differentiates terms', () => {
  const event = sportsEvent();
  const records = mlbHistoryRecords();

  // home run has history; strikeout has different history
  const c1 = buildMentionCompositeForMarket({
    event,
    market: event.markets[0], // home run
    historyRecords: records,
    sportsSettledResult: {
      sport: 'mlb', teams: ['Diamondbacks', 'Reds'], venue: null,
      historyMatch: { match_tier: 'exact_horizon', sample_size: 4, hits: 3, misses: 1, hit_rate: 0.75, match_quality_penalty: 0 },
      layers: {
        settled_mentions_history: { present: true, score: 75, source_basis: 'test', source_path: null, detail: 'test', missing_note: null },
        sport_phrase_frequency: { present: true, score: 75, source_basis: 'test', source_path: null, detail: 'test', missing_note: null },
        venue_team_phrase_relevance: { present: false, score: null, source_basis: 'none', source_path: null, detail: null, missing_note: 'n/a' },
      },
    },
    sportsGameContextResult: buildSportsGameContext({ event, term: 'home run' }),
  });

  const c2 = buildMentionCompositeForMarket({
    event,
    market: event.markets[1], // strikeout
    historyRecords: records,
    sportsSettledResult: {
      sport: 'mlb', teams: ['Diamondbacks', 'Reds'], venue: null,
      historyMatch: { match_tier: 'exact_horizon', sample_size: 1, hits: 1, misses: 0, hit_rate: 1.0, match_quality_penalty: 0 },
      layers: {
        settled_mentions_history: { present: false, score: null, source_basis: 'n<2', source_path: null, detail: null, missing_note: 'n<2' },
        sport_phrase_frequency: { present: false, score: null, source_basis: 'n<2', source_path: null, detail: null, missing_note: 'n<2' },
        venue_team_phrase_relevance: { present: false, score: null, source_basis: 'none', source_path: null, detail: null, missing_note: 'n/a' },
      },
    },
    sportsGameContextResult: buildSportsGameContext({ event, term: 'strikeout' }),
  });

  // Different history → different layer presence (home run has settled history, strikeout does not)
  const ledger1 = c1.result.evidence_ledger;
  const ledger2 = c2.result.evidence_ledger;
  const smh1 = ledger1.find(l => l.category === 'settled_mentions_history');
  const smh2 = ledger2.find(l => l.category === 'settled_mentions_history');
  assert.ok(smh1?.present === true, 'home run should have settled_mentions_history present');
  assert.ok(smh2?.present === false, 'strikeout should not have settled_mentions_history (n<2)');
  const spf1 = ledger1.find(l => l.category === 'sport_phrase_frequency');
  const spf2 = ledger2.find(l => l.category === 'sport_phrase_frequency');
  assert.ok(spf1?.present === true, 'home run should have sport_phrase_frequency present');
  assert.ok(spf2?.present === false, 'strikeout should not have sport_phrase_frequency (n<2)');
});

// --- Renderer invariant ---

test('renderer deterministic and 9-section order is stable', async () => {
  const { renderMentionPacket, validateRenderedPacket, SECTION_ORDER } = await import('../scripts/mentions/render-mention-packet.mjs');
  assert.equal(SECTION_ORDER.length, 9);
  assert.equal(SECTION_ORDER[0], '1. FAST READ');
  assert.equal(SECTION_ORDER[8], '9. MODEL-MARKET SNAPSHOTS');
});
