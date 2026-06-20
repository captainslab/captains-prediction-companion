import { createHash } from 'node:crypto';

export const RULES_ACTIVE_FAMILIES = Object.freeze([
  'earnings_call',
  'fed_agency',
  'trump_event',
  'political_general',
  'debate_hearing',
  'sports_announcer',
  'talk_show_media',
  'entertainment_reality',
  'topic_most_mentioned',
]);

export const RULES_OUT_OF_SCOPE_REASONS = Object.freeze([
  'OUT_OF_SCOPE_ROLLING',
]);

export const RULES_BLOCK_REASONS = Object.freeze([
  'BLOCKED_RULES_UNCLEAR',
  ...RULES_OUT_OF_SCOPE_REASONS,
]);

export const RULES_SOURCE_ORDER = Object.freeze([
  'rules',
  'kalshi_historical_hits_misses',
  'trusted_corpus',
  'bounded_current_context_research',
  'settlement_source_final_proof',
]);

export const RULES_FORBIDDEN_FIELDS = Object.freeze([
  'price',
  'price_cents',
  'yes_bid',
  'yes_ask',
  'no_bid',
  'no_ask',
  'bid',
  'ask',
  'last_price',
  'last_trade_price',
  'last_trade_price_cents',
  'volume',
  'volume_24h',
  'open_interest',
  'liquidity',
  'spread',
  'spread_cents',
  'dollar_volume',
  'notional_value',
  'settlement_value_dollars',
]);

export const RULES_FORBIDDEN_PATTERN = /price|bid|ask|volume|liquidity|interest|spread|notional|value.*dollars/i;

const ACTIVE_RULE_FAMILY_SET = new Set(RULES_ACTIVE_FAMILIES);
const FORBIDDEN_FIELD_SET = new Set(RULES_FORBIDDEN_FIELDS);

const EARNINGS_RE = /\b(earnings|earnings call|quarterly results|guidance|eps|revenue|cfo|ceo|investor relations|10-k|10-q|sec filing)\b/i;
const SPORTS_RE = /\b(announcer|commentator|commentary|pregame|postgame|espn|fox sports|tnt|cbs sports|nbc sports|game broadcast|play-by-play)\b/i;
const TALK_SHOW_RE = /\b(talk show|late night|tonight show|podcast|interview|press briefing|snl|saturday night live|kimmel|fallon|colbert|rogan|the view|meet the press)\b/i;
const ENTERTAINMENT_RE = /\b(reality tv|reality show|bachelor|bachelorette|survivor|big brother|love island|award show|oscars|academy awards|grammys|emmys)\b/i;
const POLITICAL_RE = /\b(president|trump|biden|vance|senate|congress|governor|mayor|election|debate|speech|rally|hearing|white house|secretary|minister|campaign|candidate)\b/i;
const FED_RE = /\b(fed|fomc|federal reserve|jerome powell|powell|rate decision|rate hike|rate cut|interest rate decision|treasury secretary|central bank)\b/i;
const DEBATE_HEARING_RE = /\b(debate|hearing|witness(?:es)?|candidates?|testif(?:y|ies|ied|ying)|congressional hearing|town hall)\b/i;
const TOPIC_MOST_RE = /\b(mentioned most|most mentioned|mention(?:ed)? the most|said the most|most said|most frequent|word bank|topic count|how many times|mention count)\b/i;
const TRUMP_RE = /\btrump\b/i;
const WEEKLY_RE = /\bweek(ly)?\b/i;
const MONTHLY_RE = /\bmonth(ly)?\b/i;
const ROLLING_TICKER_RE = /MENTIONW\b|MENTIONM\b/i;
const TRUTH_SOCIAL_RE = /\btruth[\s_-]*social\b|\bsocial[\s_-]*post\b|\btruth[\s_-]*post\b/i;
const ARCHIVE_RE = /\barchiv(?:e|al)|pre[- ]?recorded|replay|rerun\b/i;
const PRESS_OPEN_RE = /\bpress(?:\s+portion)?(?:\s+(?:is|must|be|must\s+be))?\s+open\b|\bpress\s+portion\s+open\b|\bpress\s+open\b/i;
const OFFICIAL_CAPACITY_RE = /\bofficial(?:\s|-)?capacity\b/i;
const CANCELLATION_RE = /\bcancel(?:led|ed)?\b/i;
const POSTPONEMENT_RE = /\bpostpon(?:ed|ement)\b/i;
const RESCHEDULE_RE = /\breschedul(?:ed|ing|e)\b/i;
const NEVER_AIRED_RE = /\bstream(?:\s+|-)never(?:\s+|-)aired\b|\bnever\s+aired\b|\bnever\s+airs\b/i;
const EVENT_DOES_NOT_OCCUR_RE = /\bevent\s+does\s+not\s+occur\b|\bdoes\s+not\s+happen\b/i;
const NO_OFFICIAL_CAPACITY_RE = /\bno\s+official(?:\s|-)?capacity\s+speech\b/i;
const SLASH_RE = /\//;
const NUMBER_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
});

function asText(value) {
  return value == null ? '' : String(value).trim();
}

// Kalshi markets sometimes carry the strike word as an object (e.g.
// { Word: 'Fraud' }) rather than a bare string. Without this, String(obj)
// becomes "[object Object]" and pollutes the surface / accepted_forms. Mirror
// the legacy strike-word extraction (Word/word/text/value/label/phrase/strike).
function strikeSurface(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['Word', 'word', 'text', 'value', 'label', 'phrase', 'strike']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
    return '';
  }
  return asText(value);
}

function lowerFold(value) {
  return asText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeSurface(value) {
  return lowerFold(value).replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

function uniquePush(list, seen, value) {
  const s = normalizeSurface(value);
  if (!s || seen.has(s)) return;
  seen.add(s);
  list.push(s);
}

function deepSanitize(value) {
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (isForbiddenKey(key)) continue;
      out[key] = deepSanitize(raw);
    }
    return out;
  }
  return value;
}

function isForbiddenKey(key) {
  return FORBIDDEN_FIELD_SET.has(key) || RULES_FORBIDDEN_PATTERN.test(String(key));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashSnapshot(snapshot) {
  return createHash('sha256').update(stableStringify(snapshot), 'utf8').digest('hex');
}

function lowerJoined(parts) {
  return parts.map(asText).filter(Boolean).join(' ').toLowerCase();
}

function countTokenToNumber(token) {
  const raw = lowerFold(token).replace(/[+]/g, '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return NUMBER_WORDS[raw] ?? null;
}

export function parseThresholdCount(text) {
  const normalized = lowerFold(text).replace(/[“”]/g, '"').replace(/[’‘]/g, "'");
  if (!normalized) return null;
  const patterns = [
    /\b(?:at least\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:\+|plus)\s*(?:mentions?|times?)\b/i,
    /\b(?:at least\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:or more)(?:\s*(?:mentions?|times?))?\b/i,
    /\b(?:at least\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\+\b/i,
    /\bat least\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const parsed = countTokenToNumber(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function eventText(event) {
  return lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
  ]);
}

function marketText(market) {
  return lowerJoined([
    market?.ticker,
    market?.title,
    market?.subtitle,
    market?.yes_sub_title,
    market?.no_sub_title,
    market?.rules_primary,
    market?.rules_secondary,
    strikeSurface(market?.custom_strike),
    market?.strike_type,
    market?.result,
    market?.close_time,
    market?.expected_expiration_time,
  ]);
}

function combinedText(event, market) {
  return `${eventText(event)} ${marketText(market)}`.trim();
}

function hasRollingHorizon(event, market) {
  const text = lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
    market?.ticker,
    market?.title,
    market?.subtitle,
    market?.yes_sub_title,
    market?.no_sub_title,
    market?.rules_primary,
    market?.rules_secondary,
    strikeSurface(market?.custom_strike),
  ]);
  return WEEKLY_RE.test(text) || MONTHLY_RE.test(text) || ROLLING_TICKER_RE.test(text);
}

function hasTruthSocialFraming(event, market) {
  const text = lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
    market?.ticker,
    market?.title,
    market?.subtitle,
    market?.yes_sub_title,
    market?.no_sub_title,
    market?.rules_primary,
    market?.rules_secondary,
    strikeSurface(market?.custom_strike),
  ]);
  return TRUTH_SOCIAL_RE.test(text);
}

function detectRuleFamily(event, market) {
  const eventOnly = eventText(event);
  const text = combinedText(event, market);
  const titleText = lowerJoined([event?.title, event?.sub_title]);
  const tickerText = lowerJoined([event?.event_ticker, event?.series_ticker]);
  const isTrump = TRUMP_RE.test(titleText) || /trump/.test(tickerText);

  if (EARNINGS_RE.test(text)) return 'earnings_call';
  if (SPORTS_RE.test(text)) return 'sports_announcer';
  if (FED_RE.test(text)) return 'fed_agency';
  if (isTrump && POLITICAL_RE.test(text)) return 'trump_event';
  if (DEBATE_HEARING_RE.test(text)) return 'debate_hearing';
  if (TALK_SHOW_RE.test(text)) return 'talk_show_media';
  if (ENTERTAINMENT_RE.test(text)) return 'entertainment_reality';
  if (TOPIC_MOST_RE.test(text)) return 'topic_most_mentioned';
  if (POLITICAL_RE.test(text) || TRUMP_RE.test(eventOnly)) return 'political_general';
  return null;
}

function detectMarketType(event, market, family) {
  const text = combinedText(event, market);
  if (TOPIC_MOST_RE.test(text)) return 'comparative_count';

  if (parseThresholdCount(text)) return 'threshold_count';

  if (
    EVENT_DOES_NOT_OCCUR_RE.test(text) ||
    NO_OFFICIAL_CAPACITY_RE.test(text) ||
    NEVER_AIRED_RE.test(text) ||
    CANCELLATION_RE.test(text) ||
    POSTPONEMENT_RE.test(text) ||
    RESCHEDULE_RE.test(text)
  ) {
    return 'ednq';
  }

  if (family) return 'binary';

  const hasYesNoStrike = [market?.yes_sub_title, market?.no_sub_title, strikeSurface(market?.custom_strike), market?.title, market?.subtitle]
    .some((value) => /\bwill\b|\bresolves\b|\byes\b|\bno\b/i.test(asText(value)) || asText(value).length > 0);
  return hasYesNoStrike ? 'binary' : 'unsupported';
}

function pluralizeSurface(value) {
  const base = normalizeSurface(value);
  if (!base) return null;
  const parts = base.split(' ');
  const last = parts.pop();
  if (!last) return null;
  let plural = last;
  if (/[^aeiou]y$/i.test(last)) plural = last.replace(/y$/i, 'ies');
  else if (/(s|x|z|ch|sh)$/i.test(last)) plural = `${last}es`;
  else plural = `${last}s`;
  return [...parts, plural].join(' ').trim();
}

function possessiveSurface(value) {
  const base = normalizeSurface(value);
  if (!base) return null;
  return base.endsWith('s') ? `${base}'` : `${base}'s`;
}

function acronymExpansionCandidate(value) {
  const base = normalizeSurface(value).replace(/[.\s-]+/g, '');
  if (!/^[a-z]{2,6}$/.test(base)) return null;
  return base;
}

function extractSurfaceSource(event, market) {
  for (const candidate of [
    strikeSurface(market?.custom_strike),
    market?.yes_sub_title,
    market?.no_sub_title,
    market?.subtitle,
    market?.title,
  ]) {
    if (asText(candidate)) return candidate;
  }
  return '';
}

function subjectSpeakerFromEvent(event) {
  const text = asText(event?.title) || asText(event?.sub_title);
  const match = text.match(/\b(?:what will|will|what does|what did|what would|what can)\s+([a-z][a-z0-9.'-]*(?:\s+[a-z][a-z0-9.'-]*){0,2})\s+(?:say|speak|announce|post|mention|tell|answer|do|be)\b/i);
  if (match?.[1]) return normalizeSurface(match[1].replace(/\s+(?:during|on|at|for|in)\b.*$/i, ''));
  return null;
}

function slashVariants(surface) {
  const raw = asText(surface);
  if (!raw) return [];
  if (!SLASH_RE.test(raw)) return [raw];
  return raw.split('/').map((part) => part.trim()).filter(Boolean);
}

function buildAcceptedForms(surface) {
  const seen = new Set();
  const out = [];
  for (const variant of slashVariants(surface)) {
    uniquePush(out, seen, variant);
    uniquePush(out, seen, possessiveSurface(variant));
    if (!normalizeSurface(variant).endsWith('s')) {
      const plural = pluralizeSurface(variant);
      uniquePush(out, seen, plural);
      uniquePush(out, seen, possessiveSurface(plural));
    }
  }
  return out;
}

const BLOCKED_FORM_CATEGORIES = Object.freeze([
  'other_inflections',
  'expanded_acronyms',
  'closed_compounds',
  'homophones',
  'phonetic_or_synthetic_voice',
]);

const BLOCKED_ACRONYM_EXPANSIONS = Object.freeze({
  ai: 'artificial intelligence',
});

function buildBlockedForms(surface) {
  // blocked_forms are exclusion CATEGORIES, not an enumerated word list, because
  // real excluded forms cannot be truthfully enumerated; inventing surface forms
  // would be fake data.
  const seen = new Set();
  const out = [];
  for (const category of BLOCKED_FORM_CATEGORIES) {
    uniquePush(out, seen, category);
  }
  const acronymKey = acronymExpansionCandidate(surface);
  const acronymExpansion = acronymKey ? BLOCKED_ACRONYM_EXPANSIONS[acronymKey] : null;
  if (acronymExpansion) {
    uniquePush(out, seen, `expanded_acronym:${acronymExpansion}`);
  }
  return out;
}

function speakerScopeForFamily(family) {
  switch (family) {
    case 'earnings_call':
      return 'any_company_representative_incl_operator_and_qa';
    case 'fed_agency':
      return 'any_official_participant';
    case 'sports_announcer':
      return 'single_speaker_or_announcer_panel';
    case 'talk_show_media':
      return 'single_speaker';
    case 'entertainment_reality':
      return 'any_on_camera_participant';
    case 'debate_hearing':
      return 'any_official_participant';
    case 'topic_most_mentioned':
      return 'any_official_participant';
    case 'trump_event':
    case 'political_general':
    default:
      return 'single_speaker';
  }
}

function contentWindowForFamily(family) {
  switch (family) {
    case 'earnings_call':
      return 'earnings_call_window_includes_operator_and_qa';
    case 'fed_agency':
      return 'agency_or_hearing_window_excludes_archive';
    case 'sports_announcer':
      return 'live_broadcast_window_excludes_ads_and_archive';
    case 'talk_show_media':
      return 'broadcast_interview_window_excludes_promos_ads_and_archive';
    case 'entertainment_reality':
      return 'episode_or_broadcast_window_excludes_promos_and_archive';
    case 'debate_hearing':
      return 'live_event_window_excludes_archive';
    case 'topic_most_mentioned':
      return 'counting_window_excludes_replays_and_duplicates';
    case 'trump_event':
      return 'press_portion_live_only_excludes_archival_or_prerecorded_replays';
    case 'political_general':
    default:
      return 'single_speaker_window_excludes_archive_and_promos';
  }
}

function resolutionAuthorityForFamily(family) {
  switch (family) {
    case 'earnings_call':
      return 'company_ir_transcript';
    case 'fed_agency':
      return 'agency';
    case 'sports_announcer':
    case 'talk_show_media':
    case 'entertainment_reality':
    case 'trump_event':
    case 'political_general':
    case 'debate_hearing':
    case 'topic_most_mentioned':
    default:
      return 'video_then_transcript';
  }
}

function eligibleSpeakerSetForFamily(family, event, market) {
  switch (family) {
    case 'earnings_call':
      return ['company_representative', 'operator', 'q_and_a_participant'];
    case 'trump_event':
      return ['trump'];
    case 'political_general':
    case 'debate_hearing':
    case 'fed_agency':
      return null;
    case 'sports_announcer':
      return ['announcer', 'commentator', 'play_by_play'];
    case 'talk_show_media':
      return [subjectSpeakerFromEvent(event)].filter(Boolean);
    case 'entertainment_reality':
      return null;
    case 'topic_most_mentioned':
      return null;
    default:
      return null;
  }
}

function qualificationRequirementsForFamily(family, text) {
  const out = [];
  if (family === 'trump_event' && PRESS_OPEN_RE.test(text)) out.push('press_portion_must_be_open');
  if (family === 'trump_event' && OFFICIAL_CAPACITY_RE.test(text)) out.push('official_capacity');
  if (family === 'earnings_call') {
    out.push('company_ir_context');
    out.push('operator_and_qa_in_scope');
  }
  if (family === 'fed_agency') {
    out.push('official_capacity');
  }
  if (family === 'sports_announcer') {
    out.push('broadcast_context');
  }
  return out;
}

function ednqTriggersFromText(text, family) {
  const out = [];
  if (EVENT_DOES_NOT_OCCUR_RE.test(text)) out.push('event_does_not_occur');
  if (CANCELLATION_RE.test(text)) out.push('cancellation');
  if (POSTPONEMENT_RE.test(text)) out.push('postponement');
  if (RESCHEDULE_RE.test(text)) out.push('rescheduled');
  if (NEVER_AIRED_RE.test(text)) out.push('stream_never_aired');
  if (ARCHIVE_RE.test(text)) out.push('archival_or_prerecorded_replay');
  if (NO_OFFICIAL_CAPACITY_RE.test(text)) out.push('no_official_capacity_speech');
  if (family === 'trump_event' && PRESS_OPEN_RE.test(text)) out.push('press_portion_not_open');
  return [...new Set(out)];
}

function settlementSourcesFromEvent(event) {
  const sources = [];
  const seen = new Set();
  for (const entry of Array.isArray(event?.settlement_sources) ? event.settlement_sources : []) {
    const url = asText(entry?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push(url);
  }
  return sources;
}

function marketTypeBestEffort(event, market, family) {
  return detectMarketType(event, market, family);
}

function baseSnapshot({
  event,
  market,
  family,
  marketType,
  outOfScope,
  blockReasons,
}) {
  const text = combinedText(event, market);
  const surface = extractSurfaceSource(event, market);
  const settlementSources = settlementSourcesFromEvent(event);
  const acceptedForms = outOfScope ? [] : buildAcceptedForms(surface);
  const blockedForms = outOfScope
    ? []
    : buildBlockedForms(surface).filter((value) => !acceptedForms.includes(value));

  const snapshot = {
    event_ticker: asText(event?.event_ticker) || null,
    series_ticker: asText(event?.series_ticker) || null,
    market_ticker: asText(market?.ticker ?? market?.market_ticker) || null,
    market_title: asText(market?.title) || null,
    market_subtitle: asText(market?.subtitle) || null,
    out_of_scope: Boolean(outOfScope),
    rule_family: outOfScope ? null : family,
    market_type: marketType,
    accepted_forms: acceptedForms,
    blocked_forms: blockedForms,
    slash_bundle_policy: outOfScope
      ? { is_bundle: false, variants: [] }
      : {
          is_bundle: slashVariants(surface).length > 1,
          variants: slashVariants(surface).map((v) => normalizeSurface(v)),
        },
    plural_possessive_allowed: true,
    other_inflections_allowed: false,
    eligible_speaker_set: outOfScope ? null : eligibleSpeakerSetForFamily(family, event, market),
    speaker_scope_policy: outOfScope ? null : speakerScopeForFamily(family),
    content_window_policy: outOfScope ? null : contentWindowForFamily(family),
    resolution_authority: outOfScope ? null : resolutionAuthorityForFamily(family),
    settlement_sources: settlementSources,
    required_count: outOfScope ? null : (marketType === 'threshold_count'
      ? parseThresholdCount(text)
      : (marketType === 'binary' || marketType === 'ednq' ? 1 : null)),
    ednq_trigger_set: outOfScope ? [] : ednqTriggersFromText(text, family),
    qualification_requirements: outOfScope ? [] : qualificationRequirementsForFamily(family, text),
    source_order: RULES_SOURCE_ORDER,
    historical_corpus_source_policy: 'trusted_corpus_after_kalshi_historical_hits_misses',
    block_reasons: [...new Set(blockReasons)],
  };

  const snapshotForHash = { ...snapshot };
  delete snapshotForHash.rules_snapshot_hash;
  snapshot.rules_snapshot_hash = hashSnapshot(snapshotForHash);
  return snapshot;
}

export function buildMarketRulesSnapshot(event, market) {
  const safeEvent = deepSanitize(event ?? {});
  const safeMarket = deepSanitize(market ?? {});
  const text = combinedText(safeEvent, safeMarket);

  const outOfScope = hasRollingHorizon(safeEvent, safeMarket) || hasTruthSocialFraming(safeEvent, safeMarket);
  const family = outOfScope ? null : detectRuleFamily(safeEvent, safeMarket);
  const marketType = marketTypeBestEffort(safeEvent, safeMarket, family);

  // BLOCKED_RULES_UNCLEAR fires only when the rules contract genuinely cannot
  // determine what counts: an unsupported market type, or no resolvable accepted
  // form. A null rule_family alone is NOT unclear — if the market carries a
  // determinable strike (accepted_forms) and a supported market type, the
  // literal lexical contract knows exactly what to match and routing is handled
  // separately by the research-route resolver. This prevents sparse fixture
  // shape from producing a fake hard block on otherwise-determinable markets.
  const acceptedFormsCount = outOfScope
    ? 0
    : buildAcceptedForms(extractSurfaceSource(safeEvent, safeMarket)).length;

  const blockReasons = [];
  if (outOfScope) blockReasons.push('OUT_OF_SCOPE_ROLLING');
  if (!outOfScope && (marketType === 'unsupported' || acceptedFormsCount === 0)) {
    blockReasons.push('BLOCKED_RULES_UNCLEAR');
  }

  return baseSnapshot({
    event: safeEvent,
    market: safeMarket,
    family,
    marketType,
    outOfScope,
    blockReasons,
  });
}

export function buildRulesSnapshot(event) {
  const safeEvent = deepSanitize(event ?? {});
  const markets = Array.isArray(safeEvent?.markets) ? safeEvent.markets : [];
  const marketSnapshots = markets.map((market) => buildMarketRulesSnapshot(safeEvent, market));
  return {
    event_ticker: asText(safeEvent?.event_ticker) || null,
    out_of_scope: marketSnapshots.length === 0 ? true : marketSnapshots.every((m) => m.out_of_scope === true),
    markets: marketSnapshots,
  };
}

export function rulesSnapshotHasForbiddenFields(value) {
  const json = JSON.stringify(value, (key, v) => {
    if (key && isForbiddenKey(key)) {
      throw new Error(`rules snapshot contains forbidden field "${key}"`);
    }
    return v;
  });
  return json;
}

export { deepSanitize, isForbiddenKey, hashSnapshot, hasTruthSocialFraming };
