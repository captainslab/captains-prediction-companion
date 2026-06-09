// World Cup market contract parser.
//
// Normalizes a market contract (ticker + title + optional rules text) into:
//   {
//     market_family: '1x2' | 'spread' | 'total' | 'btts' | 'to_advance' | 'unknown',
//     period: 'full' | 'first_half',
//     side: 'home' | 'away' | 'draw' | 'over' | 'under' | 'yes' | 'no' | null,
//     line: number | null,                     // goal line for spread/total
//     settlement: {
//       scope: 'regulation_90_plus_stoppage' | 'includes_extra_time' | 'includes_penalties',
//       explicit: boolean,                     // true only if contract text says so
//     },
//     normalized_target: string,               // human-readable canonical form
//     market_type: string,                     // lane key for the ceiling board
//     parse_confidence: 'high' | 'low',
//   }
//
// Hard rules:
//   - Regulation soccer markets settle on 90 minutes + stoppage time UNLESS the
//     contract text explicitly includes extra time / penalties.
//   - Ambiguous contracts return market_family 'unknown' with parse_confidence
//     'low' — they are routed to audit/BLOCKED, never guessed.
//   - This module reads contract TEXT only. It never reads or returns prices.

const FAMILY_TO_LANE = Object.freeze({
  '1x2:full': 'match_winner',
  '1x2:first_half': 'match_winner_first_half',
  'spread:full': 'spread_full_game',
  'spread:first_half': 'spread_first_half',
  'total:full': 'total_goals',
  'total:first_half': 'total_goals_first_half',
  'btts:full': 'both_teams_to_score',
  'btts:first_half': 'btts_first_half',
  'to_advance:full': 'team_to_advance',
});

function detectPeriod(text) {
  if (/\b(1st|first)[\s-]?half\b|\bhalf[\s-]?time\b|\bHT\b/i.test(text)) return 'first_half';
  return 'full';
}

function detectSettlement(text) {
  // Penalties imply extra time was also in scope; check penalties first.
  if (/\bpenalt(y|ies)\b|\bshootout\b|\bto advance\b|\bto qualify\b|\bto progress\b/i.test(text)) {
    return { scope: 'includes_penalties', explicit: true };
  }
  if (/\bextra time\b|\bovertime\b|\bafter 120\b|\bincluding ET\b|\bincl\.? ET\b/i.test(text)) {
    return { scope: 'includes_extra_time', explicit: true };
  }
  if (/\bregulation\b|\b90 minutes\b|\bregular time\b|\bfull time\b|\bstoppage\b/i.test(text)) {
    return { scope: 'regulation_90_plus_stoppage', explicit: true };
  }
  // Default for soccer markets: regulation 90' + stoppage.
  return { scope: 'regulation_90_plus_stoppage', explicit: false };
}

function extractLine(text) {
  const m = /\b(?:over|under|by (?:over|more than)|line of|[+-])\s*(\d+(?:\.\d+)?)\s*(?:goals?)?\b/i.exec(text)
    || /\b(\d+(?:\.\d+)?)\s*[\s-]*goal (?:line|spread|handicap)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

function matchTeamSide(text, homeTeam, awayTeam) {
  const t = text.toLowerCase();
  const home = homeTeam ? t.includes(homeTeam.toLowerCase()) : false;
  const away = awayTeam ? t.includes(awayTeam.toLowerCase()) : false;
  if (home && !away) return 'home';
  if (away && !home) return 'away';
  return null; // both or neither named — caller decides if that is ambiguous
}

/**
 * Parse a market contract. `homeTeam`/`awayTeam` anchor side detection.
 * Text-only: no price fields are read or emitted.
 */
export function parseMarketContract({ ticker = '', title = '', rules = '', homeTeam = null, awayTeam = null } = {}) {
  const text = `${title} ${rules}`.trim() || ticker;
  const period = detectPeriod(text);
  const settlement = detectSettlement(text);
  const teamSide = matchTeamSide(text, homeTeam, awayTeam);

  const base = {
    ticker: ticker || null,
    period,
    settlement,
    line: null,
    side: null,
    parse_confidence: 'high',
  };

  const done = (market_family, side, line, normalized_target, confidence = 'high') => ({
    ...base,
    market_family,
    side,
    line,
    normalized_target,
    market_type: FAMILY_TO_LANE[`${market_family}:${period}`] ?? null,
    parse_confidence: confidence,
  });

  // --- to_advance (knockout progression; settles incl. ET + penalties) ---
  if (/\bto advance\b|\bto qualify\b|\bto progress\b|\breach the (next round|quarter|semi|final)\b/i.test(text)) {
    if (!teamSide) return done('unknown', null, null, 'ambiguous advance market (no single team matched)', 'low');
    return done('to_advance', teamSide, null, `${teamSide} to advance (incl. extra time and penalties)`);
  }

  // --- BTTS ---
  if (/\bboth teams (?:to )?score\b|\bBTTS\b/i.test(text)) {
    const side = /\bno\b\s*$|\bnot\b/i.test(title) ? 'no' : 'yes';
    return done('btts', side, null, `both teams to score: ${side} (${period === 'first_half' ? '1st half' : 'full game'})`);
  }

  // --- total (over/under N goals, no team anchor) ---
  if (/\b(?:total|combined)\b.*\bgoals?\b|\bgoals?\b.*\b(?:over|under)\b|\b(?:over|under)\b.*\bgoals?\b/i.test(text) && !teamSide) {
    const line = extractLine(text);
    const side = /\bunder\b/i.test(text) ? 'under' : /\bover\b/i.test(text) ? 'over' : null;
    if (line === null || side === null) {
      return done('unknown', side, line, 'ambiguous total market (missing line or side)', 'low');
    }
    return done('total', side, line, `${side} ${line} goals (${period === 'first_half' ? '1st half' : 'full game'})`);
  }

  // --- spread / handicap (team wins by over X / covers X-goal line) ---
  if (/\bwins? by\b|\bhandicap\b|\bspread\b|\bgoal line\b|\bcovers?\b|[+-]\d+(\.\d+)?\s*goals?/i.test(text)) {
    const line = extractLine(text);
    if (!teamSide || line === null) {
      return done('unknown', teamSide, line, 'ambiguous spread market (missing team or line)', 'low');
    }
    return done('spread', teamSide, line, `${teamSide} covers ${line} goal line (${period === 'first_half' ? '1st half' : 'full game'})`);
  }

  // --- 1X2 draw outcome ---
  if (/\bdraw\b|\btie\b|\bends? (in a )?(draw|tie|level)\b/i.test(text)) {
    return done('1x2', 'draw', null, `draw (${period === 'first_half' ? '1st half' : 'regulation 90' + "'+stoppage"})`);
  }

  // --- 1X2 team win ---
  if (/\bwins?\b|\bbeats?\b|\bdefeats?\b|\bvictor/i.test(text)) {
    // When both teams are named ("South Africa beats Mexico"), the winner is
    // the subject BEFORE the verb — anchor side detection there first.
    const subject = /^(.*?)\b(?:wins?|beats?|defeats?)\b/i.exec(text)?.[1] ?? '';
    const resultSide = matchTeamSide(subject, homeTeam, awayTeam) ?? teamSide;
    if (!resultSide) return done('unknown', null, null, 'ambiguous result market (no single team matched)', 'low');
    return done('1x2', resultSide, null, `${resultSide} wins (${period === 'first_half' ? '1st half lead' : settlement.scope === 'regulation_90_plus_stoppage' ? "regulation 90'+stoppage" : settlement.scope})`);
  }

  return done('unknown', null, null, 'unrecognized market family', 'low');
}

export const MARKET_FAMILY_TO_LANE = FAMILY_TO_LANE;
