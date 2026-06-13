// Sports settled-history alpha for sports_announcer-routed mention markets.
//
// Loads settled sports mention events from the history store and builds
// tiered match layers: exact series > same sport > broader fallback.
// Uses settled-history.mjs loadHistory/buildHistoryMatch as the foundation,
// then adds sport-specific phrase frequency and venue/team relevance layers.
//
// HARD RULE: prices/volume/liquidity NEVER persist and NEVER feed scoring.

import {
  loadHistory,
  buildHistoryMatch,
  historyToLayerScore,
  assertNoForbiddenFields,
} from './settled-history.mjs';

const SPORT_SERIES_PREFIXES = Object.freeze({
  mlb: ['KXMLBMENTION', 'KXMLB'],
  worldcup: ['KXWCMENTION', 'KXWORLDCUP', 'KXFIFA'],
  nba: ['KXNBAMENTION', 'KXNBA'],
  nfl: ['KXNFLMENTION', 'KXNFL'],
  nhl: ['KXNHLMENTION', 'KXNHL'],
});

function detectSport(eventTicker, seriesTicker, titleText) {
  const combined = [eventTicker, seriesTicker, titleText].filter(Boolean).join(' ').toUpperCase();
  const tickers = [eventTicker, seriesTicker].filter(Boolean).join(' ').toUpperCase();
  if (/\b(MLB|BASEBALL)\b/.test(combined) || /KXMLB/.test(tickers)) return 'mlb';
  if ((/\b(WORLDCUP|FIFA|WORLD CUP|SOCCER|FOOTBALL)\b/.test(combined) || /KXWC|KXFIFA|KXWORLDCUP/.test(tickers)) && !/\b(NFL|AMERICAN FOOTBALL)\b/.test(combined)) return 'worldcup';
  if (/\b(NBA|BASKETBALL)\b/.test(combined) || /KXNBA/.test(tickers)) return 'nba';
  if ((/\b(NFL|FOOTBALL)\b/.test(combined) || /KXNFL/.test(tickers)) && !/\bSOCCER\b/.test(combined)) return 'nfl';
  if (/\b(NHL|HOCKEY)\b/.test(combined) || /KXNHL/.test(tickers)) return 'nhl';
  return null;
}

function extractTeamsFromTitle(title) {
  if (!title) return [];
  const m = title.match(/during\s+(.+?)\s+(?:Professional|Game|Match|Series)/i);
  if (!m) return [];
  const matchup = m[1].trim();
  const teams = matchup.split(/\s+vs\.?\s+/i).map(t => t.trim()).filter(Boolean);
  return teams;
}

function extractVenueFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(?:at|@)\s+([A-Z][a-zA-Z\s]+(?:Stadium|Arena|Park|Field|Center|Centre|Dome|Garden))/i);
  return m ? m[1].trim() : null;
}

function filterBySport(records, sport) {
  if (!sport) return records;
  const prefixes = SPORT_SERIES_PREFIXES[sport] ?? [];
  return records.filter(r => {
    const st = String(r.series_ticker ?? r.event_ticker ?? '').toUpperCase();
    const ctx = String(r.context ?? '').toUpperCase();
    if (prefixes.some(p => st.startsWith(p))) return true;
    const sportTerms = {
      mlb: /\b(MLB|BASEBALL)\b/,
      worldcup: /\b(WORLDCUP|FIFA|WORLD CUP|SOCCER)\b/,
      nba: /\b(NBA|BASKETBALL)\b/,
      nfl: /\b(NFL|FOOTBALL)\b/,
      nhl: /\b(NHL|HOCKEY)\b/,
    };
    return sportTerms[sport]?.test(ctx) ?? false;
  });
}

/**
 * buildSportsSettledHistory — loads history and builds tiered match + phrase
 * frequency + venue/team relevance layers for a sports_announcer route.
 *
 * @param {object} opts
 * @param {string}  opts.eventTicker
 * @param {string}  opts.seriesTicker
 * @param {string}  opts.eventTitle
 * @param {string}  opts.term          - strike term being scored
 * @param {string}  opts.route         - should be 'sports_announcer'
 * @param {string}  opts.entity
 * @param {string}  opts.horizon
 * @param {string}  opts.stateRoot
 * @param {Array?}  opts.preloadedRecords - skip loadHistory if already loaded
 */
export async function buildSportsSettledHistory({
  eventTicker = null,
  seriesTicker = null,
  eventTitle = null,
  term = null,
  route = 'sports_announcer',
  entity = null,
  horizon = 'event',
  stateRoot = 'state',
  preloadedRecords = null,
} = {}) {
  const allRecords = preloadedRecords ?? await loadHistory({ stateRoot });
  const sport = detectSport(eventTicker, seriesTicker, eventTitle);
  const teams = extractTeamsFromTitle(eventTitle);
  const venue = extractVenueFromTitle(eventTitle);

  const historyMatch = buildHistoryMatch({
    records: allRecords,
    route,
    entity,
    horizon,
    seriesTicker,
    maxSamples: 5,
  });

  const settledLayer = historyToLayerScore(historyMatch);

  const sportRecords = filterBySport(allRecords, sport);
  const phraseFreqLayer = buildPhraseFrequencyLayer(sportRecords, term);
  const venueTeamLayer = buildVenueTeamRelevanceLayer(sportRecords, term, teams, venue);

  assertNoForbiddenFields({ settledLayer, phraseFreqLayer, venueTeamLayer }, 'sports settled history output');

  return {
    sport,
    teams,
    venue,
    historyMatch,
    layers: {
      settled_mentions_history: settledLayer,
      sport_phrase_frequency: phraseFreqLayer,
      venue_team_phrase_relevance: venueTeamLayer,
    },
  };
}

function buildPhraseFrequencyLayer(sportRecords, term) {
  if (!term || !sportRecords.length) {
    return {
      present: false,
      score: null,
      source_basis: 'sports-settled-history: no sport records for phrase frequency',
      source_path: null,
      detail: null,
      missing_note: 'no settled sports mention history available for phrase frequency',
    };
  }

  const termLower = term.toLowerCase();
  const matching = sportRecords.filter(r =>
    String(r.strike_term ?? '').toLowerCase().includes(termLower) ||
    String(r.context ?? '').toLowerCase().includes(termLower)
  );

  if (matching.length === 0) {
    return {
      present: false,
      score: null,
      source_basis: `sports-settled-history: term "${term}" not found in settled sports records`,
      source_path: null,
      detail: null,
      missing_note: `term "${term}" has no prior settled sports mention history`,
    };
  }

  const settled = matching.filter(r => r.result === 'yes' || r.result === 'no');
  if (settled.length < 2) {
    return {
      present: false,
      score: null,
      source_basis: 'sports-settled-history: insufficient settled data for phrase frequency (n<2)',
      source_path: null,
      detail: `found ${settled.length} settled record(s) for "${term}"`,
      missing_note: 'insufficient settled history (n<2 settled outcomes)',
    };
  }

  const hits = settled.filter(r => r.result === 'yes').length;
  const rate = hits / settled.length;
  const score = Math.max(0, Math.min(100, Math.round(100 * rate)));
  const note = `sport phrase frequency: ${hits}/${settled.length} YES for "${term}" across ${sportRecords.length} sport records`;

  return {
    present: true,
    score,
    source_basis: note,
    source_path: null,
    detail: `${note}; rate=${rate.toFixed(4)}`,
    missing_note: null,
  };
}

function buildVenueTeamRelevanceLayer(sportRecords, term, teams, venue) {
  if (!term || (!teams.length && !venue) || !sportRecords.length) {
    return {
      present: false,
      score: null,
      source_basis: 'sports-settled-history: no venue/team context for relevance scoring',
      source_path: null,
      detail: null,
      missing_note: 'no venue/team context extracted from event title',
    };
  }

  const termLower = term.toLowerCase();
  const contextMatching = sportRecords.filter(r => {
    const ctx = String(r.context ?? '').toLowerCase();
    const teamMatch = teams.some(t => ctx.includes(t.toLowerCase()));
    const venueMatch = venue ? ctx.includes(venue.toLowerCase()) : false;
    return teamMatch || venueMatch;
  });

  if (contextMatching.length === 0) {
    return {
      present: false,
      score: null,
      source_basis: `sports-settled-history: no settled history for teams/venue [${teams.join(', ')}${venue ? `, ${venue}` : ''}]`,
      source_path: null,
      detail: null,
      missing_note: `no settled history involving ${teams.join('/')}${venue ? ` at ${venue}` : ''}`,
    };
  }

  const termMatching = contextMatching.filter(r =>
    String(r.strike_term ?? '').toLowerCase().includes(termLower) ||
    String(r.context ?? '').toLowerCase().includes(termLower)
  );

  const settled = termMatching.filter(r => r.result === 'yes' || r.result === 'no');
  if (settled.length < 2) {
    return {
      present: false,
      score: null,
      source_basis: 'sports-settled-history: insufficient venue/team data for this term (n<2)',
      source_path: null,
      detail: `found ${settled.length} settled venue/team record(s) for "${term}"`,
      missing_note: 'insufficient venue/team settled history (n<2)',
    };
  }

  const hits = settled.filter(r => r.result === 'yes').length;
  const rate = hits / settled.length;
  const score = Math.max(0, Math.min(100, Math.round(100 * rate)));
  const note = `venue/team phrase relevance: ${hits}/${settled.length} YES for "${term}" with ${teams.join('/')}${venue ? ` at ${venue}` : ''}`;

  return {
    present: true,
    score,
    source_basis: note,
    source_path: null,
    detail: `${note}; rate=${rate.toFixed(4)}; context_pool=${contextMatching.length}`,
    missing_note: null,
  };
}

export { detectSport, extractTeamsFromTitle, extractVenueFromTitle, filterBySport };
