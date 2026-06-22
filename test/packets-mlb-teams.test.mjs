// Tests for MLB team display name enrichment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupMlbTeam,
  parseEventTickerTeams,
  parseMarketTickerTeam,
  buildEventDisplay,
  buildMarketDisplay,
} from '../scripts/packets/lib/mlb-teams.mjs';

test('lookupMlbTeam: required mappings (LAD, SD, SF, AZ, ATH)', () => {
  assert.equal(lookupMlbTeam('LAD'), 'Los Angeles Dodgers');
  assert.equal(lookupMlbTeam('SD'),  'San Diego Padres');
  assert.equal(lookupMlbTeam('SF'),  'San Francisco Giants');
  assert.equal(lookupMlbTeam('AZ'),  'Arizona Diamondbacks');
  // Per source convention: bare 'ATH' = Athletics. 'OAK' kept as Oakland Athletics
  // for legacy data. Both must resolve to a non-null full name.
  assert.equal(lookupMlbTeam('ATH'), 'Athletics');
  assert.equal(lookupMlbTeam('OAK'), 'Oakland Athletics');
});

test('lookupMlbTeam: case insensitive and tolerant of whitespace/null', () => {
  assert.equal(lookupMlbTeam('lad'), 'Los Angeles Dodgers');
  assert.equal(lookupMlbTeam('  sd  '), 'San Diego Padres');
  assert.equal(lookupMlbTeam(null), null);
  assert.equal(lookupMlbTeam(''), null);
  assert.equal(lookupMlbTeam('ZZZ'), null);
});

test('parseEventTickerTeams: splits Kalshi ticker into [away, home]', () => {
  assert.deepEqual(parseEventTickerTeams('KXMLBGAME-26MAY182140LADSD'), ['LAD', 'SD']);
  assert.deepEqual(parseEventTickerTeams('KXMLBGAME-26MAY182140SFAZ'), ['SF', 'AZ']);
  assert.deepEqual(parseEventTickerTeams('KXMLBGAME-26MAY182140CWSSEA'), ['CWS', 'SEA']);
  assert.deepEqual(parseEventTickerTeams('KXMLBGAME-26MAY182138ATHLAA'), ['ATH', 'LAA']);
  assert.deepEqual(parseEventTickerTeams('KXMLBGAME-26MAY181940BOSKC'), ['BOS', 'KC']);
});

test('parseEventTickerTeams: returns null on unknown teams or malformed input', () => {
  assert.equal(parseEventTickerTeams('KXMLBGAME-26MAY181940ZZZQQQ'), null);
  assert.equal(parseEventTickerTeams(''), null);
  assert.equal(parseEventTickerTeams(null), null);
});

test('parseMarketTickerTeam: resolves YES-side abbreviation suffix', () => {
  assert.equal(
    parseMarketTickerTeam('KXMLBGAME-26MAY182140LADSD-LAD', 'KXMLBGAME-26MAY182140LADSD'),
    'LAD',
  );
  assert.equal(
    parseMarketTickerTeam('KXMLBGAME-26MAY182140LADSD-SD', 'KXMLBGAME-26MAY182140LADSD'),
    'SD',
  );
  assert.equal(
    parseMarketTickerTeam('KXMLBGAME-26MAY182140SFAZ-AZ', 'KXMLBGAME-26MAY182140SFAZ'),
    'AZ',
  );
  // Unknown abbrev -> null
  assert.equal(
    parseMarketTickerTeam('KXMLBGAME-26MAY182140LADSD-ZZZ', 'KXMLBGAME-26MAY182140LADSD'),
    null,
  );
});

test('buildEventDisplay: LADSD renders full team names', () => {
  const ev = {
    event_ticker: 'KXMLBGAME-26MAY182140LADSD',
    title: 'Los Angeles D vs San Diego',
    sub_title: 'LAD vs SD (May 18)',
  };
  const d = buildEventDisplay(ev);
  assert.equal(d.display_name_status, 'OK');
  assert.equal(d.display_event_title, 'Los Angeles Dodgers vs San Diego Padres');
  assert.equal(d.away_abbrev, 'LAD');
  assert.equal(d.home_abbrev, 'SD');
  assert.equal(d.away_full, 'Los Angeles Dodgers');
  assert.equal(d.home_full, 'San Diego Padres');
});

test('buildEventDisplay: SFAZ renders full team names', () => {
  const ev = {
    event_ticker: 'KXMLBGAME-26MAY182140SFAZ',
    title: 'San Francisco vs Arizona',
  };
  const d = buildEventDisplay(ev);
  assert.equal(d.display_event_title, 'San Francisco Giants vs Arizona Diamondbacks');
  assert.equal(d.display_name_status, 'OK');
});

test('buildEventDisplay: unknown abbrev falls back to raw title and MISSING_MAPPING', () => {
  const ev = {
    event_ticker: 'KXMLBGAME-26MAY181940ZZZQQQ',
    title: 'Mystery Team vs Other',
  };
  const d = buildEventDisplay(ev);
  assert.equal(d.display_name_status, 'MISSING_MAPPING');
  assert.equal(d.display_event_title, 'Mystery Team vs Other');
});

test('buildEventDisplay: explicit away/home fields populate the matchup even without a parsed ticker', () => {
  const ev = {
    event_ticker: 'KXMLBGAME-UNKNOWN',
    title: 'Generic Game Title',
    away_team: 'NYY',
    home_team: 'BOS',
    away_full: 'New York Yankees',
    home_full: 'Boston Red Sox',
  };
  const d = buildEventDisplay(ev);
  assert.equal(d.display_name_status, 'OK');
  assert.equal(d.display_event_title, 'New York Yankees vs Boston Red Sox');
  assert.equal(d.away_abbrev, 'NYY');
  assert.equal(d.home_abbrev, 'BOS');
  assert.equal(d.away_full, 'New York Yankees');
  assert.equal(d.home_full, 'Boston Red Sox');
});

test('buildMarketDisplay: LADSD -> LAD market shows Dodgers as YES, Padres as NO', () => {
  const evDisp = buildEventDisplay({
    event_ticker: 'KXMLBGAME-26MAY182140LADSD',
    title: 'Los Angeles D vs San Diego',
  });
  const market = {
    ticker: 'KXMLBGAME-26MAY182140LADSD-LAD',
    event_ticker: 'KXMLBGAME-26MAY182140LADSD',
    title: 'Los Angeles D vs San Diego Winner?',
    yes_sub_title: 'Los Angeles D',
    no_sub_title: 'Los Angeles D',
  };
  const md = buildMarketDisplay(market, evDisp);
  assert.equal(md.display_name_status, 'OK');
  assert.equal(md.display_yes_label, 'Los Angeles Dodgers');
  assert.equal(md.display_no_label, 'San Diego Padres');
  assert.equal(
    md.display_market_title,
    'Los Angeles Dodgers vs San Diego Padres Winner?',
  );
  assert.equal(md.yes_abbrev, 'LAD');
});

test('buildMarketDisplay: LADSD -> SD market shows Padres as YES, Dodgers as NO', () => {
  const evDisp = buildEventDisplay({
    event_ticker: 'KXMLBGAME-26MAY182140LADSD',
    title: 'Los Angeles D vs San Diego',
  });
  const market = {
    ticker: 'KXMLBGAME-26MAY182140LADSD-SD',
    event_ticker: 'KXMLBGAME-26MAY182140LADSD',
    title: 'Los Angeles D vs San Diego Winner?',
    yes_sub_title: 'San Diego',
    no_sub_title: 'San Diego',
  };
  const md = buildMarketDisplay(market, evDisp);
  assert.equal(md.display_yes_label, 'San Diego Padres');
  assert.equal(md.display_no_label, 'Los Angeles Dodgers');
  assert.equal(md.display_name_status, 'OK');
});

test('buildMarketDisplay: SFAZ market produces full Giants/Diamondbacks labels', () => {
  const evDisp = buildEventDisplay({
    event_ticker: 'KXMLBGAME-26MAY182140SFAZ',
    title: 'San Francisco vs Arizona',
  });
  const sfMarket = {
    ticker: 'KXMLBGAME-26MAY182140SFAZ-SF',
    event_ticker: 'KXMLBGAME-26MAY182140SFAZ',
    title: 'San Francisco vs Arizona Winner?',
    yes_sub_title: 'San Francisco',
    no_sub_title: 'San Francisco',
  };
  const md = buildMarketDisplay(sfMarket, evDisp);
  assert.equal(md.display_yes_label, 'San Francisco Giants');
  assert.equal(md.display_no_label, 'Arizona Diamondbacks');
  assert.equal(
    md.display_market_title,
    'San Francisco Giants vs Arizona Diamondbacks Winner?',
  );
});

test('buildMarketDisplay: unknown YES abbrev flags MISSING_MAPPING but does not crash', () => {
  const evDisp = buildEventDisplay({
    event_ticker: 'KXMLBGAME-26MAY182140LADSD',
    title: 'Los Angeles D vs San Diego',
  });
  const market = {
    ticker: 'KXMLBGAME-26MAY182140LADSD-ZZZ',
    event_ticker: 'KXMLBGAME-26MAY182140LADSD',
    title: 'Los Angeles D vs San Diego Winner?',
    yes_sub_title: 'Mystery',
    no_sub_title: 'Mystery',
  };
  const md = buildMarketDisplay(market, evDisp);
  assert.equal(md.display_name_status, 'MISSING_MAPPING');
  // Falls back to raw yes_sub_title
  assert.equal(md.display_yes_label, 'Mystery');
});
