// Sports game-context builder for sports_announcer-routed mention markets.
//
// Extracts teams, venue, matchup, series/tournament state, and phrase triggers
// from event metadata. Produces layer records for current_game_context,
// sport_phrase_likelihood, and game_context_trigger.
//
// Pure, deterministic, offline. No network. No pricing.

import { assertNoForbiddenFields } from './settled-history.mjs';

const RIVALRY_PAIRS = Object.freeze([
  ['yankees', 'red sox'], ['dodgers', 'giants'], ['cubs', 'cardinals'],
  ['celtics', 'lakers'], ['warriors', 'cavaliers'],
  ['cowboys', 'eagles'], ['packers', 'bears'],
  ['penguins', 'flyers'], ['bruins', 'canadiens'],
  ['brazil', 'argentina'], ['england', 'germany'], ['usa', 'mexico'],
  ['spain', 'portugal'], ['france', 'italy'],
]);

function isRivalry(teams) {
  if (!teams || teams.length < 2) return false;
  const lower = teams.map(t => t.toLowerCase());
  return RIVALRY_PAIRS.some(([a, b]) =>
    (lower.some(t => t.includes(a)) && lower.some(t => t.includes(b)))
  );
}

const PHRASE_TRIGGER_TERMS = Object.freeze([
  'injury', 'injured', 'IL', 'disabled list',
  'milestone', 'record', 'career', '100th', '500th', '1000th',
  'debut', 'rookie', 'first',
  'trade', 'traded', 'transaction', 'waiver', 'DFA',
  'rivalry', 'rival',
  'playoff', 'postseason', 'elimination', 'clinch',
  'no-hitter', 'perfect game', 'cycle', 'triple-double',
  'hat trick', 'shutout',
]);

function detectPhraseTriggers(term, title, teams) {
  const combined = [term, title, ...teams].filter(Boolean).join(' ').toLowerCase();
  return PHRASE_TRIGGER_TERMS.filter(t => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(combined);
  });
}

function detectSeries(eventTicker, seriesTicker, title) {
  const combined = [eventTicker, seriesTicker, title].filter(Boolean).join(' ').toUpperCase();
  if (/WORLD\s*CUP|FIFA|KXWC/.test(combined)) return 'world_cup';
  if (/PLAYOFF|POSTSEASON|WILD\s*CARD|DIVISION|CHAMPIONSHIP|WORLD\s*SERIES/.test(combined)) return 'postseason';
  if (/ALL.STAR|ALL-STAR/.test(combined)) return 'all_star';
  if (/SPRING\s*TRAINING|PRESEASON/.test(combined)) return 'preseason';
  return 'regular_season';
}

function extractTeamsFromTitle(title) {
  if (!title) return [];
  const m = title.match(/during\s+(.+?)\s+(?:Professional|Game|Match|Series)/i);
  if (!m) {
    const m2 = title.match(/(\w[\w\s]+?)\s+vs\.?\s+(\w[\w\s]+?)(?:\s+(?:Professional|Game|Match|at|$))/i);
    if (m2) return [m2[1].trim(), m2[2].trim()];
    return [];
  }
  return m[1].split(/\s+vs\.?\s+/i).map(t => t.trim()).filter(Boolean);
}

function extractVenue(title) {
  if (!title) return null;
  const m = title.match(/(?:at|@)\s+([A-Z][a-zA-Z\s]+(?:Stadium|Arena|Park|Field|Center|Centre|Dome|Garden))/i);
  return m ? m[1].trim() : null;
}

/**
 * buildSportsGameContext — pure, deterministic.
 *
 * @param {object} opts
 * @param {object}  opts.event       - Kalshi event object
 * @param {string}  opts.term        - strike term being scored
 * @param {object?} opts.gameInfo    - optional { probable_pitchers, lineups, injuries, transactions }
 * @returns {object} { gameContext, layers }
 */
export function buildSportsGameContext({
  event = null,
  term = null,
  gameInfo = null,
} = {}) {
  const title = event?.title ?? '';
  const eventTicker = event?.event_ticker ?? '';
  const seriesTicker = event?.series_ticker ?? '';

  const teams = extractTeamsFromTitle(title);
  const venue = extractVenue(title);
  const seriesState = detectSeries(eventTicker, seriesTicker, title);
  const rivalry = isRivalry(teams);
  const triggers = detectPhraseTriggers(term, title, teams);

  const gameContext = {
    teams,
    venue,
    matchup: teams.length >= 2 ? `${teams[0]} vs ${teams[1]}` : null,
    series_state: seriesState,
    rivalry,
    probable_pitchers: gameInfo?.probable_pitchers ?? null,
    lineups: gameInfo?.lineups ?? null,
    injuries: gameInfo?.injuries ?? null,
    transactions: gameInfo?.transactions ?? null,
    phrase_triggers: triggers,
  };

  const currentGameContextLayer = buildCurrentGameContextLayer(gameContext);
  const phraseLikelihoodLayer = buildPhraseLikelihoodLayer(gameContext, term);
  const triggerLayer = buildGameContextTriggerLayer(gameContext, term);

  assertNoForbiddenFields({ currentGameContextLayer, phraseLikelihoodLayer, triggerLayer }, 'sports game context output');

  return {
    gameContext,
    layers: {
      current_game_context: currentGameContextLayer,
      sport_phrase_likelihood: phraseLikelihoodLayer,
      game_context_trigger: triggerLayer,
    },
  };
}

function buildCurrentGameContextLayer(ctx) {
  let score = 0;
  const factors = [];

  if (ctx.teams.length >= 2) { score += 30; factors.push('matchup identified'); }
  if (ctx.venue) { score += 10; factors.push(`venue: ${ctx.venue}`); }
  if (ctx.rivalry) { score += 15; factors.push('rivalry matchup'); }
  if (ctx.series_state === 'postseason') { score += 15; factors.push('postseason'); }
  else if (ctx.series_state === 'world_cup') { score += 15; factors.push('World Cup'); }
  else if (ctx.series_state === 'all_star') { score += 5; factors.push('All-Star'); }
  if (ctx.probable_pitchers) { score += 10; factors.push('pitchers confirmed'); }
  if (ctx.lineups) { score += 5; factors.push('lineups available'); }
  if (ctx.injuries?.length) { score += 10; factors.push(`${ctx.injuries.length} injury note(s)`); }
  if (ctx.transactions?.length) { score += 5; factors.push(`${ctx.transactions.length} transaction(s)`); }

  score = Math.min(100, score);

  if (score === 0) {
    return {
      present: false,
      score: null,
      source_basis: 'sports-game-context: no game context extractable from event',
      source_path: null,
      detail: null,
      missing_note: 'no teams/venue/matchup/series context found in event metadata',
    };
  }

  return {
    present: true,
    score,
    source_basis: `game context: ${factors.join(', ')}`,
    source_path: null,
    detail: `factors: ${factors.join('; ')}; series=${ctx.series_state}`,
    missing_note: null,
  };
}

function buildPhraseLikelihoodLayer(ctx, term) {
  if (!term) {
    return {
      present: false,
      score: null,
      source_basis: 'sports-game-context: no term for phrase likelihood',
      source_path: null,
      detail: null,
      missing_note: 'no strike term provided',
    };
  }

  const termLower = term.toLowerCase();
  let score = 30; // base: any term has some chance during a broadcast
  const factors = [];

  // Team name in term
  if (ctx.teams.some(t => termLower.includes(t.toLowerCase()) || t.toLowerCase().includes(termLower))) {
    score += 25;
    factors.push('term matches team name');
  }
  // Venue in term
  if (ctx.venue && termLower.includes(ctx.venue.toLowerCase())) {
    score += 15;
    factors.push('term matches venue');
  }
  // Rivalry boost
  if (ctx.rivalry) {
    score += 10;
    factors.push('rivalry increases mention density');
  }
  // Postseason/World Cup boost
  if (ctx.series_state === 'postseason' || ctx.series_state === 'world_cup') {
    score += 10;
    factors.push(`${ctx.series_state} increases mention likelihood`);
  }
  // Phrase triggers present
  if (ctx.phrase_triggers.length > 0) {
    score += Math.min(20, ctx.phrase_triggers.length * 5);
    factors.push(`triggers: ${ctx.phrase_triggers.join(', ')}`);
  }

  score = Math.min(100, score);

  return {
    present: true,
    score,
    source_basis: `sport phrase likelihood: ${factors.length ? factors.join(', ') : 'base broadcast likelihood'}`,
    source_path: null,
    detail: `base=30 + adjustments; factors: ${factors.join('; ') || 'none'}`,
    missing_note: null,
  };
}

function buildGameContextTriggerLayer(ctx, term) {
  const triggers = ctx.phrase_triggers;

  if (!triggers.length && !ctx.rivalry && ctx.series_state === 'regular_season') {
    return {
      present: true,
      score: 25,
      source_basis: 'no game-context trigger detected; regular season, no rivalry, no phrase triggers',
      source_path: null,
      detail: 'no active triggers',
      missing_note: null,
    };
  }

  let score = 30;
  const factors = [];

  if (ctx.rivalry) { score += 20; factors.push('rivalry'); }
  if (triggers.length) {
    score += Math.min(30, triggers.length * 10);
    factors.push(`phrase triggers: ${triggers.join(', ')}`);
  }
  if (ctx.series_state === 'postseason' || ctx.series_state === 'world_cup') {
    score += 15;
    factors.push(ctx.series_state);
  }
  if (ctx.injuries?.length) { score += 10; factors.push('injury context'); }
  if (ctx.transactions?.length) { score += 10; factors.push('transaction context'); }

  score = Math.min(100, score);

  return {
    present: true,
    score,
    source_basis: `game context trigger: ${factors.join(', ')}`,
    source_path: null,
    detail: `trigger score=${score}; factors: ${factors.join('; ')}`,
    missing_note: null,
  };
}

export { extractTeamsFromTitle, extractVenue, detectSeries, isRivalry, detectPhraseTriggers };
