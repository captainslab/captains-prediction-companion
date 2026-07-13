// PMT advisory context for Trump mention packets.
//
// This is a distilled, first-pass advisory layer derived from the committed
// PMT Trump/mentions playbook and transcript inventory. It is intentionally
// non-scoring: no price, odds, liquidity, or ranking fields live here.

const SOURCE_DOCS = Object.freeze([
  'docs/mentions/pmt-trump-mentions-playbook.md',
  'docs/mentions/pmt-transcript-inventory.md',
  'docs/mentions/pmt-transcript-inventory.json',
]);

const TRUMP_ROUTES = Object.freeze(new Set([
  'trump_event',
  'trump_weekly',
  'trump_monthly',
]));

const SUPPORTING_VIDEO_IDS = Object.freeze([
  'yu--taGiDBQ',
  'lahki5GjV5A',
  'Ve5Ps_3YcAM',
  'wqYpjejFoEI',
  'rRuIgO84OF0',
  'j0XPOxZ-ZPo',
  'TOCgj28XJFM',
  'kCafX_WhgxA',
  '_zDTyxzaLfk',
]);

function asText(value) {
  return value == null ? '' : String(value).trim();
}

export function isTrumpPmtRoute(route) {
  return TRUMP_ROUTES.has(asText(route));
}

export function buildPmtAdvisoryContext({
  route = null,
  eventTitle = null,
  eventSubtitle = null,
  speaker = 'Trump',
} = {}) {
  if (!isTrumpPmtRoute(route)) return null;

  const routeText = asText(route);
  const title = asText(eventTitle) || asText(eventSubtitle) || `${speaker} mention event`;
  const horizon =
    routeText === 'trump_weekly' ? 'weekly' :
    routeText === 'trump_monthly' ? 'monthly' :
    'event';

  return Object.freeze({
    enabled: true,
    scope: 'advisory-only',
    coverage_note: 'first-pass transcript mining only; not exhaustive heuristic extraction',
    source_commit: 'f426a70',
    source_docs: SOURCE_DOCS,
    route: routeText,
    route_horizon: horizon,
    event_label: title,
    event_format_prior: 'Event format comes first: rally, signing, press conference, interview, or summit changes the expected wording path.',
    recent_language_prior: 'Historical phrasing helps, but it is not enough on its own.',
    live_timing_prior: 'Fresh news can override old priors minutes before the event.',
    audience_context: 'Venue and crowd shape the likely topic family.',
    current_news_shock: 'Current-event shock is a first-order input.',
    exact_wording_settlement_fit: 'Exact payout text governs settlement; broad topic relevance is not enough.',
    consensus_heavy_warning: 'Crowded narratives are a warning sign, not a reason to force a pick.',
    nt_no_edge_guidance: 'NT / skip remains valid when the edge is thin or support is weak.',
    general_mentions_process: [
      'Pick a niche and stay in it.',
      'Use transcripts and comparable history.',
      'Read contract rules before forming an opinion.',
      'Separate prepared remarks from Q&A.',
      'Treat current events as first-order input.',
      'Avoid forced action when the edge is thin.',
      'Recognize lane differences.',
    ],
    supporting_video_ids: SUPPORTING_VIDEO_IDS,
  });
}

export function formatPmtAdvisoryContext(context) {
  if (!context) return [];
  const lines = [];
  lines.push('ADVISORY CONTEXT');
  lines.push(`source: Trump/mentions playbook @ ${context.source_commit} (advisory only)`);
  lines.push(`route: ${context.route}${context.route_horizon ? ` (${context.route_horizon})` : ''}`);
  lines.push(`event: ${context.event_label}`);
  lines.push(`event format prior: ${context.event_format_prior}`);
  lines.push(`recent language prior: ${context.recent_language_prior}`);
  lines.push(`live timing prior: ${context.live_timing_prior}`);
  lines.push(`audience / venue context: ${context.audience_context}`);
  lines.push(`current news shock: ${context.current_news_shock}`);
  lines.push(`exact wording / settlement fit: ${context.exact_wording_settlement_fit}`);
  lines.push(`consensus-heavy warning: ${context.consensus_heavy_warning}`);
  lines.push(`NT / no-edge guidance: ${context.nt_no_edge_guidance}`);
  if (Array.isArray(context.general_mentions_process) && context.general_mentions_process.length) {
    lines.push(`general mentions process: ${context.general_mentions_process.join(' | ')}`);
  }
  if (Array.isArray(context.supporting_video_ids) && context.supporting_video_ids.length) {
    lines.push(`supporting clips: ${context.supporting_video_ids.join(', ')}`);
  }
  lines.push(`coverage note: ${context.coverage_note}`);
  return lines;
}
