import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMlbResearchPrompt,
  classifyResearchFact,
  QUERY_TYPES,
  FORBIDDEN_MARKET_TERMS,
} from '../scripts/mlb/lib/perplexity-prompt-builder.mjs';

const ANCHOR = {
  game_pk: '778899',
  date: '2026-06-20',
  away_team: 'Baltimore Orioles',
  home_team: 'Los Angeles Dodgers',
  venue: 'Dodger Stadium',
  first_pitch_utc: '2026-06-21T02:10:00Z',
  away_starter: 'Trevor Rogers',
  home_starter: 'Yoshinobu Yamamoto',
};

test('1. prompt includes game_pk, date, teams, venue, first pitch', () => {
  for (const qt of QUERY_TYPES) {
    const { user } = buildMlbResearchPrompt(qt, ANCHOR);
    assert.ok(user.includes('778899'), `${qt} missing game_pk`);
    assert.ok(user.includes('2026-06-20'), `${qt} missing date`);
    assert.ok(user.includes('Baltimore Orioles'), `${qt} missing away_team`);
    assert.ok(user.includes('Los Angeles Dodgers'), `${qt} missing home_team`);
    assert.ok(user.includes('Dodger Stadium'), `${qt} missing venue`);
    assert.ok(user.includes('2026-06-21T02:10:00Z'), `${qt} missing first pitch`);
  }
});

test('game_pk says unknown when not provided', () => {
  const { user } = buildMlbResearchPrompt('PRE_GAME', { ...ANCHOR, game_pk: undefined });
  assert.ok(/game_pk: unknown/.test(user));
});

test('2. prompt forbids all market/price terms (literal)', () => {
  const { user } = buildMlbResearchPrompt('PRE_GAME', ANCHOR);
  const required = [
    'betting odds',
    'Kalshi',
    'bid/ask',
    'open interest',
    'volume',
    'liquidity',
    'sportsbook',
    'market prices',
  ];
  for (const term of required) {
    assert.ok(user.includes(term), `forbid block missing literal term: ${term}`);
  }
  // also the canonical list export is wired in
  for (const term of FORBIDDEN_MARKET_TERMS) {
    assert.ok(user.includes(term), `prompt missing forbidden term: ${term}`);
  }
});

test('3. prompt tells Perplexity NOT to decide live score when MLB official is available', () => {
  const pre = buildMlbResearchPrompt('PRE_GAME', ANCHOR).user;
  const ingame = buildMlbResearchPrompt('IN_GAME', ANCHOR).user;
  assert.ok(/source of truth/i.test(pre) || /SOURCE OF TRUTH/.test(pre));
  assert.ok(/not decide or override the live score/i.test(ingame));
});

test('4. prompt excludes previous-day games unless series_context', () => {
  const { user } = buildMlbResearchPrompt('PRE_GAME', ANCHOR);
  assert.ok(/EXCLUDE previous-day/i.test(user));
  assert.ok(/series_context/.test(user));
});

test('5. prompt requires source URLs for every claim', () => {
  const { user } = buildMlbResearchPrompt('PRE_GAME', ANCHOR);
  assert.ok(/source_url/.test(user));
  assert.ok(/Every claim MUST include a source_title and a source_url/i.test(user));
});

test('6. prompt requires unavailable/UNAVAILABLE instead of guessing', () => {
  const { user } = buildMlbResearchPrompt('PRE_GAME', ANCHOR);
  assert.ok(/UNAVAILABLE/.test(user));
  assert.ok(/unavailable/.test(user));
  assert.ok(/do NOT guess/i.test(user));
});

test('7. IN_GAME prompt says official MLB live state is authoritative', () => {
  const { user, system } = buildMlbResearchPrompt('IN_GAME', ANCHOR);
  assert.ok(/AUTHORITATIVE/.test(user));
  assert.ok(/authoritative/i.test(system));
});

test('8. POST_GAME allows final recap only after MLB official says final', () => {
  const { user } = buildMlbResearchPrompt('POST_GAME', ANCHOR);
  assert.ok(/ONLY after MLB official reports the game is final/i.test(user));
  assert.ok(/return UNAVAILABLE for the final result/i.test(user));
});

test('LINEUP_INJURY_ONLY restricts to lineup + injury', () => {
  const { user } = buildMlbResearchPrompt('LINEUP_INJURY_ONLY', ANCHOR);
  assert.ok(/Restrict all facts to category "lineup" or "injury"/i.test(user));
});

test('WEATHER_PARK_ONLY restricts to weather + park and only when official missing', () => {
  const { user } = buildMlbResearchPrompt('WEATHER_PARK_ONLY', ANCHOR);
  assert.ok(/Restrict all facts to category "weather" or "park"/i.test(user));
  assert.ok(/only when official weather is missing/i.test(user));
});

test('output_schema is returned and embedded in user prompt', () => {
  const out = buildMlbResearchPrompt('PRE_GAME', ANCHOR);
  assert.equal(typeof out.output_schema, 'object');
  assert.ok(out.user.includes('REQUIRED OUTPUT SCHEMA'));
  assert.ok(out.user.includes('forbidden_market_data_present'));
});

test('unknown query type throws', () => {
  assert.throws(() => buildMlbResearchPrompt('NOPE', ANCHOR), /Unknown queryType/);
});

test('known starters appear in prompt', () => {
  const { user } = buildMlbResearchPrompt('PRE_GAME', ANCHOR);
  assert.ok(user.includes('Trevor Rogers'));
  assert.ok(user.includes('Yoshinobu Yamamoto'));
});

test('9. Jun 19 contamination classified CONFLICTED / series_context, not current game', () => {
  const contaminated = {
    claim: 'Final: Dodgers beat Orioles 5-2',
    category: 'starter',
    status: 'CONFIRMED',
    source_title: 'Box Score',
    source_url: 'https://example.com/box',
    source_time_or_date: '2026-06-19',
  };
  const res = classifyResearchFact(contaminated, ANCHOR);
  assert.equal(res.belongs_to_current_game, false);
  assert.equal(res.status, 'CONFLICTED');
  assert.equal(res.category, 'series_context');
});

test('matching-date fact belongs to current game and keeps category', () => {
  const ok = {
    claim: 'Trevor Rogers confirmed starter',
    category: 'starter',
    status: 'CONFIRMED',
    source_time_or_date: '2026-06-20T18:00:00Z',
  };
  const res = classifyResearchFact(ok, ANCHOR);
  assert.equal(res.belongs_to_current_game, true);
  assert.equal(res.category, 'starter');
});

test('missing fact date is not asserted as current game', () => {
  const res = classifyResearchFact({ claim: 'x', category: 'storyline' }, ANCHOR);
  assert.equal(res.belongs_to_current_game, false);
  assert.equal(res.reason, 'missing_date');
});
