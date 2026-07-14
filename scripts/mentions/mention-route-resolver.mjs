// Mention research-route resolver.
//
// Pure, deterministic, offline routing of a Kalshi-style mention event to a
// research route + scoring profile. Uses only text/ticker/close-time fields —
// never price fields — so the same event always resolves the same way.
//
// Route priority is event-subject-first. Strike/rules text is never allowed to
// reclassify a news, hearing, speech, interview, or other event.

import { resolveEarningsTicker } from './earnings-family-history.mjs';

export const RESEARCH_ROUTES = Object.freeze([
  'sports_announcer',
  'earnings_call',
  'political_general',
  'trump_event',
  'trump_weekly',
  'trump_monthly',
  'talk_show_media',
  'entertainment_reality',
  'fed_agency',
  'debate_hearing',
  'topic_most_mentioned',
  'news_broadcast',
  'speech_event',
  'interview_media',
]);

export const ROUTE_TO_PROFILE = Object.freeze({
  sports_announcer:      'sports_announcer_mentions',
  earnings_call:         'earnings_mentions',
  political_general:     'political_mentions',
  trump_event:           'political_mentions',
  trump_weekly:          'political_mentions',
  trump_monthly:         'political_mentions',
  talk_show_media:       'political_mentions',
  entertainment_reality: 'political_mentions',
  // New routes reuse existing scoring profiles (no new profile surface).
  fed_agency:            'political_mentions',
  debate_hearing:        'political_mentions',
  topic_most_mentioned:  'political_mentions',
  news_broadcast:       'political_mentions',
  speech_event:         'political_mentions',
  interview_media:      'political_mentions',
});

// Reserved policy hook for future Trump Truth Social history work. Not used
// by the resolver yet; mirror sources are proxies, never direct source proof.
export const FUTURE_SOURCE_POLICY = Object.freeze({
  truth_social: Object.freeze({
    mirror_sources: Object.freeze(['@truthtrumpposts']),
    note: 'mirror/proxy source for future Trump Truth history work; NOT direct source proof',
  }),
});

// Mirrors the legacy inference regexes in generate-mentions-daily.mjs so the
// route -> profile mapping never disagrees with prior profile behavior.
const EARNINGS_RE = /\b(earnings|earnings call|quarterly results|guidance|eps|revenue|cfo|ceo|investor relations|10-k|10-q|sec filing)\b/;
// Note: bare "broadcast" is intentionally absent — settlement rules for any
// live show say "during the broadcast" (e.g. podcasts), which is not sports
// announcer context. "game broadcast" and announcer-specific terms remain.
const SPORTS_RE = /\b(announcer|commentator|commentary|pregame|postgame|espn|fox sports|tnt|cbs sports|nbc sports|game broadcast|play-by-play)\b/;
const SPORTS_EVENT_RE = /\b(world cup|fifa|world series|super bowl|stanley cup|champions league|premier league|olympics?|grand prix|\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|\bmls\b|\bufc\b)\b/;
const NEWS_BROADCAST_RE = /\b(world news tonight|nightly news|evening news|news broadcast|network news|newscast|abc news|cbs news|nbc news|news tonight)\b/;
const SPEECH_RE = /\b(address|remarks|speech|rally|campaign speech|keynote)\b/;
const INTERVIEW_RE = /\b(interview|one-on-one|q&a|question and answer)\b/;
const TALK_SHOW_RE = /\b(talk show|late night|tonight show|podcast|interview|press briefing|snl|saturday night live|kimmel|fallon|colbert|rogan|the view|meet the press)\b/;
const ENTERTAINMENT_RE = /\b(reality tv|reality show|bachelor|bachelorette|survivor|big brother|love island|award show|oscars|academy awards|grammys|emmys)\b/;
const POLITICAL_RE = /\b(president|trump|biden|vance|senate|congress|governor|mayor|election|debate|speech|rally|hearing|white house|secretary|minister|campaign|candidate)\b/;
// Fed / central-bank / agency-testimony context. Subject-level, not a strike.
const FED_RE = /\b(fed|fomc|federal reserve|jerome powell|powell|rate decision|rate hike|rate cut|interest rate decision|treasury secretary|central bank)\b/;
// Debate / hearing / witness / candidate context (non-Trump political events).
const DEBATE_HEARING_RE = /\b(debate|hearing|witness(?:es)?|candidates?|testif(?:y|ies|ied|ying)|congressional hearing|town hall)\b/;
// "Most mentioned" / word-bank / topic-count market structure.
const TOPIC_MOST_RE = /\b(mentioned most|most mentioned|mention(?:ed)? the most|said the most|most said|most frequent|word bank|topic count|how many times|mention count)\b/;
const TRUMP_RE = /\btrump\b/;
const WEEKLY_RE = /\bweek(ly)?\b/;
const MONTHLY_RE = /\bmonth(ly)?\b/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function lowerJoined(parts) {
  return parts.map(asText).filter(Boolean).join(' ').toLowerCase();
}

function parseTimeMs(isoLike) {
  if (!isoLike) return null;
  const ms = new Date(isoLike).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function combinedText(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  return lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
    ...markets.flatMap((m) => [m?.ticker, m?.title, m?.subtitle, m?.yes_sub_title, m?.no_sub_title, m?.rules_primary, m?.rules_secondary]),
  ]);
}

// Title/ticker/rules subset used for horizon-term checks (weekly/monthly).
function horizonText(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  return lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
    ...markets.flatMap((m) => [m?.ticker, m?.title, m?.rules_primary, m?.rules_secondary]),
  ]);
}

/**
 * Days from `now` to the latest event/market close_time /
 * expected_expiration_time. Null when no parsable close timestamp exists.
 */
function closeWindowDays(event, nowMs) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const candidates = [
    event?.close_time,
    event?.expected_expiration_time,
    ...markets.flatMap((m) => [m?.close_time, m?.expected_expiration_time]),
  ];
  let latest = null;
  for (const c of candidates) {
    const ms = parseTimeMs(c);
    if (ms != null && (latest == null || ms > latest)) latest = ms;
  }
  if (latest == null) return null;
  return (latest - nowMs) / MS_PER_DAY;
}

function result(route, basis, { entity = null, horizon = null, close_window_days = null, event_format = null } = {}) {
  return {
    route,
    profile_key: ROUTE_TO_PROFILE[route],
    basis,
    entity,
    horizon,
    close_window_days,
    event_format: event_format ?? route,
  };
}

/**
 * Resolve the research route for a Kalshi-style mention event.
 * Pure and offline: depends only on `event` text/close fields, `now`, and an
 * optional rulesSnapshot override.
 */
export function resolveResearchRoute(event, { now, rulesSnapshot } = {}) {
  return resolveResearchRouteWithSnapshot(event, { now, rulesSnapshot });
}

function activeRuleFamilyFromSnapshot(rulesSnapshot) {
  if (!rulesSnapshot || rulesSnapshot.out_of_scope === true) return null;
  const direct = rulesSnapshot?.rule_family;
  if (typeof direct === 'string' && Object.hasOwn(ROUTE_TO_PROFILE, direct)) return direct;
  if (Array.isArray(rulesSnapshot?.markets)) {
    for (const market of rulesSnapshot.markets) {
      const family = market?.rule_family;
      if (typeof family === 'string' && market?.out_of_scope !== true && Object.hasOwn(ROUTE_TO_PROFILE, family)) {
        return family;
      }
    }
  }
  return null;
}

function resolveResearchRouteWithSnapshot(event, { now, rulesSnapshot } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now ?? Date.now())).getTime();
  const snapshotFamily = activeRuleFamilyFromSnapshot(rulesSnapshot);
  if (snapshotFamily) {
    const horizon = snapshotFamily === 'topic_most_mentioned' ? null : 'event';
    const entity = snapshotFamily === 'trump_event'
      ? 'trump'
      : snapshotFamily === 'earnings_call'
        ? resolveEarningsTicker(event?.series_ticker, [event?.title, event?.sub_title].filter(Boolean).join(' '))
        : null;
    return result(snapshotFamily, 'rules_snapshot', { entity, horizon, close_window_days: closeWindowDays(event, nowMs) });
  }
  const text = combinedText(event);
  const subjectText = lowerJoined([
    event?.event_ticker, event?.series_ticker, event?.title, event?.sub_title,
    event?.subtitle, event?.event_title,
  ]);
  const windowDays = closeWindowDays(event, nowMs);

  // Subject fields win before any strike/rules text is examined. This prevents
  // a news story mentioning a sports tournament from becoming a sports route.
  if (NEWS_BROADCAST_RE.test(subjectText)) {
    return result('news_broadcast', 'news_broadcast_subject', {
      close_window_days: windowDays, horizon: 'event', event_format: 'news_broadcast',
    });
  }
  if (EARNINGS_RE.test(text)) {
    const earningsTicker = resolveEarningsTicker(event?.series_ticker, [event?.title, event?.sub_title].filter(Boolean).join(' '));
    return result('earnings_call', 'earnings_terms', {
      entity: earningsTicker,
      close_window_days: windowDays,
      horizon: 'event',
    });
  }
  if (INTERVIEW_RE.test(subjectText)) {
    return result('interview_media', 'interview_subject', {
      close_window_days: windowDays, horizon: 'event', event_format: 'interview',
    });
  }
  // A Trump EVENT subject must not be captured by the sports branches: the
  // all-market text can carry sports-like strike terms (World Cup, Olympics,
  // ball, broadcast-adjacent words) that are not the event subject. Skip sports
  // when the ticker/series/title marks a Trump event and let it fall through to
  // the trump_weekly/trump_monthly/trump_event routing below (subject fields
  // only — never market strikes/rules).
  const subjectIsTrump =
    TRUMP_RE.test(lowerJoined([event?.title, event?.sub_title, event?.subtitle, event?.event_title])) ||
    /trump/.test(lowerJoined([event?.event_ticker, event?.series_ticker]));
  // Mirror the subjectIsTrump guard for speech subjects: a speech event (Biden
  // campaign speech, etc.) whose STRIKE phrase carries a sports term ("World
  // Cup") must not be captured by the strike-inclusive sports branches. It
  // falls through to the speech_event subject check below. Subject-only signal.
  const subjectIsSpeech = SPEECH_RE.test(subjectText);
  if (!subjectIsTrump && !subjectIsSpeech && SPORTS_RE.test(text)) {
    return result('sports_announcer', 'broadcast_terms', { close_window_days: windowDays, horizon: 'event' });
  }
  if (!subjectIsTrump && !subjectIsSpeech && SPORTS_EVENT_RE.test(text)) {
    return result('sports_announcer', 'sports_event_terms', { close_window_days: windowDays, horizon: 'event' });
  }
  // Fed/FOMC/agency-testimony context routes before Trump so a Powell/FOMC
  // event is never mistaken for a generic political event. (No existing Trump
  // fixture carries Fed terms, so Trump routing stays stable.)
  if (FED_RE.test(text)) {
    return result('fed_agency', 'fed_agency_terms', { close_window_days: windowDays, horizon: 'event' });
  }

  // Trump routing keys off the EVENT subject (ticker/series/title/subtitle),
  // never market strikes/rules: "Will Mamdani say 'Trump'?" is a Mamdani
  // event with a Trump strike term, not a Trump event. Word-boundary match on
  // titles (no "trumpet"); plain substring only inside ticker tokens.
  const titleText = lowerJoined([event?.title, event?.sub_title]);
  const tickerText = lowerJoined([event?.event_ticker, event?.series_ticker]);
  const isTrump = TRUMP_RE.test(titleText) || /trump/.test(tickerText);
  if (isTrump && POLITICAL_RE.test(text)) {
    const hText = horizonText(event);
    if (WEEKLY_RE.test(hText)) {
      return result('trump_weekly', 'trump_weekly_ticker_term', { entity: 'trump', horizon: 'weekly', close_window_days: windowDays });
    }
    if (MONTHLY_RE.test(hText)) {
      return result('trump_monthly', 'trump_monthly_ticker_term', { entity: 'trump', horizon: 'monthly', close_window_days: windowDays });
    }
    // Close-window heuristics apply to LIVE events only: a negative window
    // means already closed (e.g. settled-history ingest probes) and must not
    // imply a weekly horizon.
    if (windowDays != null && windowDays >= 0 && windowDays <= 8) {
      return result('trump_weekly', 'trump_weekly_close_window', { entity: 'trump', horizon: 'weekly', close_window_days: windowDays });
    }
    if (windowDays != null && windowDays >= 21) {
      return result('trump_monthly', 'trump_monthly_close_window', { entity: 'trump', horizon: 'monthly', close_window_days: windowDays });
    }
    return result('trump_event', 'trump_event_default', { entity: 'trump', horizon: 'event', close_window_days: windowDays });
  }

  if (SPEECH_RE.test(subjectText)) {
    return result('speech_event', 'speech_subject', {
      close_window_days: windowDays, horizon: 'event', event_format: 'speech',
    });
  }

  // Debate/hearing/witness/candidate — checked AFTER the Trump block so a
  // "Trump debate" event keeps its trump_* route, but generic debates/hearings
  // get the more specific route instead of falling through to political_general.
  if (DEBATE_HEARING_RE.test(text)) {
    return result('debate_hearing', 'debate_hearing_terms', { close_window_days: windowDays, horizon: 'event' });
  }
  if (TALK_SHOW_RE.test(text)) {
    return result('talk_show_media', 'talk_show_terms', { close_window_days: windowDays, horizon: 'event' });
  }
  if (ENTERTAINMENT_RE.test(text)) {
    return result('entertainment_reality', 'entertainment_terms', { close_window_days: windowDays, horizon: 'event' });
  }
  // "Most mentioned" / word-bank / topic-count market structure.
  if (TOPIC_MOST_RE.test(text)) {
    return result('topic_most_mentioned', 'topic_most_mentioned_terms', { close_window_days: windowDays, horizon: null });
  }
  if (POLITICAL_RE.test(text)) {
    return result('political_general', 'political_terms', { close_window_days: windowDays, horizon: null });
  }
  return result('political_general', 'default_political_general', { close_window_days: windowDays, horizon: null });
}
