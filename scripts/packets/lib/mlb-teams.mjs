// MLB team abbreviation → full team name mapping for Kalshi market display
// enrichment. Pure data + small parsing helpers; no I/O.
//
// Source convention: Kalshi MLB market tickers end in the team abbreviation,
// e.g. KXMLBGAME-26MAY182140LADSD-LAD. Event tickers end in the two team
// abbreviations concatenated (LADSD = LAD + SD).
//
// Add new abbreviations here when MLB rosters change. Keep keys uppercase.

export const MLB_TEAM_BY_ABBREV = Object.freeze({
  ARI: 'Arizona Diamondbacks',
  AZ:  'Arizona Diamondbacks',
  ATL: 'Atlanta Braves',
  BAL: 'Baltimore Orioles',
  BOS: 'Boston Red Sox',
  CHC: 'Chicago Cubs',
  CWS: 'Chicago White Sox',
  CHW: 'Chicago White Sox',
  CIN: 'Cincinnati Reds',
  CLE: 'Cleveland Guardians',
  COL: 'Colorado Rockies',
  DET: 'Detroit Tigers',
  HOU: 'Houston Astros',
  KC:  'Kansas City Royals',
  KCR: 'Kansas City Royals',
  LAA: 'Los Angeles Angels',
  LAD: 'Los Angeles Dodgers',
  MIA: 'Miami Marlins',
  MIL: 'Milwaukee Brewers',
  MIN: 'Minnesota Twins',
  NYM: 'New York Mets',
  NYY: 'New York Yankees',
  ATH: 'Athletics',
  OAK: 'Oakland Athletics',
  PHI: 'Philadelphia Phillies',
  PIT: 'Pittsburgh Pirates',
  SD:  'San Diego Padres',
  SDP: 'San Diego Padres',
  SEA: 'Seattle Mariners',
  SF:  'San Francisco Giants',
  SFG: 'San Francisco Giants',
  STL: 'St. Louis Cardinals',
  TB:  'Tampa Bay Rays',
  TBR: 'Tampa Bay Rays',
  TEX: 'Texas Rangers',
  TOR: 'Toronto Blue Jays',
  WSH: 'Washington Nationals',
  WAS: 'Washington Nationals',
});

/**
 * Look up a team's full display name by abbreviation. Returns null on unknown.
 * Case-insensitive; trims input.
 */
export function lookupMlbTeam(abbrev) {
  if (abbrev == null) return null;
  const k = String(abbrev).trim().toUpperCase();
  if (!k) return null;
  return MLB_TEAM_BY_ABBREV[k] ?? null;
}

/**
 * Parse a Kalshi MLB event ticker into [awayAbbrev, homeAbbrev].
 * Expected format: KXMLBGAME-<YYMMMDDHHMM><AWAY><HOME>
 *   e.g. KXMLBGAME-26MAY182140LADSD -> ["LAD", "SD"]
 *        KXMLBGAME-26MAY182138ATHLAA -> ["ATH", "LAA"]
 *
 * Strategy: take the trailing alphabetic chunk, greedy-split on the longest
 * known abbreviation prefix, recurse on the remainder. Returns null on parse
 * failure or if either side maps to an unknown team.
 */
export function parseEventTickerTeams(eventTicker) {
  if (typeof eventTicker !== 'string') return null;
  const tail = eventTicker.split('-').pop() || '';
  // strip leading digit/time portion; keep trailing uppercase letters
  const m = tail.match(/([A-Z]+?)(?:G\d+)?$/);
  if (!m) return null;
  const letters = m[1];
  // Try every split point; prefer the split where BOTH halves are known
  // abbreviations. If multiple matches, prefer the longest first-half match
  // (resolves CWSSEA -> CWS+SEA rather than CW+SSEA).
  const candidates = [];
  for (let i = 2; i <= letters.length - 2; i += 1) {
    const a = letters.slice(0, i);
    const b = letters.slice(i);
    if (MLB_TEAM_BY_ABBREV[a] && MLB_TEAM_BY_ABBREV[b]) {
      candidates.push([a, b]);
    }
  }
  if (!candidates.length) return null;
  // Pick the candidate with the longest first abbreviation
  candidates.sort((x, y) => y[0].length - x[0].length);
  return candidates[0];
}

/**
 * Parse the team abbreviation suffix from a market ticker, given its event
 * ticker. e.g. ("KXMLBGAME-26MAY182140LADSD-LAD", "KXMLBGAME-26MAY182140LADSD")
 *   -> "LAD"
 * Returns null if the market ticker does not end with -<KNOWN_ABBREV>.
 */
export function parseMarketTickerTeam(marketTicker, eventTicker) {
  if (typeof marketTicker !== 'string') return null;
  let suffix = null;
  if (typeof eventTicker === 'string' && marketTicker.startsWith(`${eventTicker}-`)) {
    suffix = marketTicker.slice(eventTicker.length + 1);
  } else {
    const parts = marketTicker.split('-');
    suffix = parts[parts.length - 1] || null;
  }
  if (!suffix) return null;
  const upper = suffix.toUpperCase();
  return MLB_TEAM_BY_ABBREV[upper] ? upper : null;
}

/**
 * Build display enrichment for an MLB Kalshi event. Returns:
 *   {
 *     display_event_title,    // "Los Angeles Dodgers vs San Diego Padres"
 *     display_name_status,    // "OK" or "MISSING_MAPPING"
 *     away_abbrev, home_abbrev,
 *     away_full, home_full,
 *   }
 * On failure (unknown abbreviations), preserves status=MISSING_MAPPING and
 * falls back to the raw event title.
 */
export function buildEventDisplay(event) {
  const ticker = event?.event_ticker || '';
  const rawTitle = (event?.title || '').trim();
  const normalizeAbbrev = (value) => {
    const key = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return MLB_TEAM_BY_ABBREV[key] ? key : null;
  };
  const explicitAwayAbbrev = normalizeAbbrev(event?.away_team);
  const explicitHomeAbbrev = normalizeAbbrev(event?.home_team);
  const explicitAwayFull = typeof event?.away_full === 'string' && event.away_full.trim() ? event.away_full.trim() : null;
  const explicitHomeFull = typeof event?.home_full === 'string' && event.home_full.trim() ? event.home_full.trim() : null;
  const teams = parseEventTickerTeams(ticker);
  const awayAbbrev = explicitAwayAbbrev ?? teams?.[0] ?? null;
  const homeAbbrev = explicitHomeAbbrev ?? teams?.[1] ?? null;
  const awayFull = explicitAwayFull ?? lookupMlbTeam(awayAbbrev);
  const homeFull = explicitHomeFull ?? lookupMlbTeam(homeAbbrev);
  if (!awayAbbrev && !homeAbbrev) {
    return {
      display_event_title: rawTitle || 'MISSING',
      display_name_status: 'MISSING_MAPPING',
      away_abbrev: null,
      home_abbrev: null,
      away_full: null,
      home_full: null,
    };
  }
  if (!awayFull || !homeFull) {
    return {
      display_event_title: rawTitle || 'MISSING',
      display_name_status: 'MISSING_MAPPING',
      away_abbrev: awayAbbrev,
      home_abbrev: homeAbbrev,
      away_full: awayFull,
      home_full: homeFull,
    };
  }
  return {
    display_event_title: `${awayFull} vs ${homeFull}`,
    display_name_status: 'OK',
    away_abbrev: awayAbbrev,
    home_abbrev: homeAbbrev,
    away_full: awayFull,
    home_full: homeFull,
  };
}

/**
 * Build display enrichment for an MLB Kalshi market within an event.
 * Returns:
 *   {
 *     display_market_title, display_yes_label, display_no_label,
 *     display_name_status, yes_abbrev,
 *   }
 * display_yes_label = the YES team's full name (parsed from market ticker
 * suffix). display_no_label = the opposing team's full name (from the event).
 * Preserves raw market.title in callers; this only adds *display_* fields.
 */
export function buildMarketDisplay(market, eventDisplay) {
  const status = { display_name_status: 'OK' };
  const rawTitle = typeof market?.title === 'string' ? market.title.trim() : '';
  const yesAbbrev = parseMarketTickerTeam(market?.ticker, market?.event_ticker);
  // Resolve YES team full name from ticker suffix; fall back to MISSING
  let yesFull = lookupMlbTeam(yesAbbrev);
  let noFull = null;
  if (yesAbbrev && eventDisplay?.away_abbrev && eventDisplay?.home_abbrev) {
    if (yesAbbrev === eventDisplay.away_abbrev) noFull = eventDisplay.home_full;
    else if (yesAbbrev === eventDisplay.home_abbrev) noFull = eventDisplay.away_full;
  }
  if (!yesFull || !noFull) {
    status.display_name_status = 'MISSING_MAPPING';
  }
  // Build a full-name market title by substituting team-full names into the
  // raw market title's "X vs Y" portion when possible. Otherwise fall back to
  // "<event_display_title> Winner?" or the raw title.
  let displayMarketTitle = rawTitle || 'MISSING';
  if (eventDisplay?.display_name_status === 'OK' && rawTitle) {
    // Common pattern: "Los Angeles D vs San Diego Winner?" — replace the
    // "X vs Y" prefix with full names, preserve any trailing suffix.
    const suffixMatch = rawTitle.match(/\s+vs\s+[^?]*(\?.*)?$/i);
    const trailing = (suffixMatch && rawTitle.match(/\s+(Winner\??.*)$/i)) || null;
    const trail = trailing ? ` ${trailing[1]}` : '';
    displayMarketTitle = `${eventDisplay.display_event_title}${trail || ' Winner?'}`.trim();
  } else if (eventDisplay?.display_event_title && eventDisplay.display_event_title !== 'MISSING') {
    displayMarketTitle = `${eventDisplay.display_event_title} Winner?`;
  }
  return {
    display_market_title: displayMarketTitle,
    display_yes_label: yesFull || (market?.yes_sub_title || 'MISSING'),
    display_no_label: noFull || (market?.no_sub_title || 'MISSING'),
    display_name_status: status.display_name_status,
    yes_abbrev: yesAbbrev,
  };
}
