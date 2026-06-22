// Deterministic sports preview builder.
// Pure ESM. Date formatting only; no network or filesystem access.
//
// TODO(full-slate integration): scripts/worldcup/lib/packet-renderer.mjs
// TODO(full-slate integration): scripts/mlb/lib/article-render.mjs

import { validateCpcCustomerPacket } from '../packets/lib/cpc-packet-validator.mjs';

export const BANNED_CUSTOMER_PREVIEW_WORDS = Object.freeze([
  'pick',
  'lean',
  'watch',
  'fade',
  'lock',
  'hammer',
  'smash',
  'trigger board',
  'top edge candidates',
  'no edge',
  'projection-only',
  'actionable',
  'monitor-only',
]);

const CHICAGO_TZ = 'America/Chicago';

const TERM_REPLACEMENTS = new Map([
  ['trigger board', 'trigger list'],
  ['top edge candidates', 'top sourced options'],
  ['projection-only', 'model-only'],
  ['monitor-only', 'review-only'],
  ['no edge', 'no clear signal'],
  ['actionable', 'usable'],
  ['hammer', 'strong'],
  ['smash', 'strong'],
  ['pick', 'selection'],
  ['lean', 'signal'],
  ['watch', 'review'],
  ['fade', 'avoid'],
  ['lock', 'anchor'],
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value, fallback = 'unavailable') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text.length ? text : fallback;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstText(...candidates) {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const text = String(candidate).trim();
    if (text.length) return text;
  }
  return '';
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubCustomerText(text) {
  let out = String(text ?? '');
  for (const [term, replacement] of TERM_REPLACEMENTS) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'), replacement);
  }
  return out;
}

function countWords(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function truncateWords(text, maxWords) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function sentenceCase(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function joinSentences(sentences) {
  return sentences.map((sentence) => sentenceCase(sentence)).filter(Boolean).join(' ');
}

function formatChicagoDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

function pickHeadline(research, sport, packet_type, id) {
  const candidate = firstText(...toArray(research?.headline_candidates));
  if (candidate) return candidate;
  return sport === 'worldcup'
    ? `World Cup match preview ${id}`
    : `MLB game preview ${id}`;
}

function pickWhy(research, model, sport) {
  if (research && research.status !== 'PERPLEXITY_UNAVAILABLE') {
    return firstText(
      research.why_this_game_matters,
      research.why_this_match_matters,
      research.why_it_matters,
    ) || 'unavailable';
  }
  return firstText(
    model?.why_it_matters,
    model?.context_summary,
    model?.stakes,
    model?.stakes_summary,
    model?.context,
    model?.match_context,
    model?.game_context,
  ) || (sport === 'worldcup' ? 'Match context unavailable.' : 'Game context unavailable.');
}

function pickKeySourceContext(research) {
  const title = firstText(...toArray(research?.source_titles));
  if (title) {
    return `Primary source: ${title}`;
  }
  return 'No external source confirmed for this preview.';
}

function pickModelLine(model, keys, fallback = 'unavailable') {
  return firstText(...keys.map((key) => model?.[key]), fallback);
}

function pickWeatherNote(model, research) {
  const weather = model?.weather ?? model?.weather_context ?? model?.venue_weather ?? model?.roof_weather;
  if (weather && weather !== 'unavailable') {
    return `Weather context: ${truncateWords(toText(weather, 'unavailable'), 18)}`;
  }

  const unavailable = toArray(research?.unavailable_fields).some((field) => String(field).trim().toLowerCase() === 'weather');
  if (unavailable || !weather) {
    return 'Weather context is not sourced.';
  }
  return '';
}

function composeStoryline({ research, model, sport, packet_type }) {
  const contextPieces = [];
  const editorial = research?.editorial_context;
  if (isObject(editorial)) {
    contextPieces.push(
      firstText(
        editorial.rivalry_h2h,
        editorial.rivalry,
        editorial.public_narrative,
        editorial.history,
        editorial.tournament_storyline,
        editorial.momentum,
        editorial.tactical_angle,
      ),
    );
  } else {
    contextPieces.push(firstText(research?.editorial_context, model?.context_summary, model?.context, model?.stakes));
  }

  const contextSentence = truncateWords(firstText(...contextPieces) || (sport === 'worldcup' ? 'Match context is sourced.' : 'Game context is sourced.'), 30);

  const resultEdge = truncateWords(
    firstText(
      model?.result_edge,
      model?.edge,
      model?.read,
      model?.model_edge,
    ) || 'unavailable',
    22,
  );

  const projection = truncateWords(
    firstText(
      model?.projection,
      model?.projected,
      model?.projection_text,
      model?.score_projection,
      model?.run_projection,
      model?.goal_projection,
    ) || 'unavailable',
    22,
  );

  const totalEnvironment = truncateWords(
    firstText(
      model?.total_environment,
      model?.environment,
      model?.total_read,
      model?.total_context,
    ) || 'not sourced',
    22,
  );

  const caveat = truncateWords(firstText(model?.caveat, model?.model_caveat, model?.risk_note) || 'unavailable', 22);
  const weatherNote = pickWeatherNote(model, research);

  const sentences = [
    contextSentence,
    `Model read: ${resultEdge}; projected: ${projection}; total environment: ${totalEnvironment}`,
  ];

  if (weatherNote) {
    sentences.push(weatherNote);
  }

  if (caveat && caveat !== 'unavailable') {
    sentences.push(`Model caveat: ${caveat}`);
  }

  let story = joinSentences(sentences);
  if (countWords(story) > 110) {
    const words = story.trim().split(/\s+/).filter(Boolean);
    story = `${words.slice(0, 110).join(' ')}...`;
  }
  return scrubCustomerText(story);
}

function buildQuickRead({ model, research, sport, packet_type }) {
  const projected = truncateWords(
    firstText(
      model?.projection,
      model?.projected,
      model?.score_projection,
      model?.run_projection,
      model?.goal_projection,
    ) || 'unavailable',
    18,
  );
  const totalEnvironment = truncateWords(
    firstText(
      model?.total_environment,
      model?.environment,
      model?.total_read,
      model?.total_context,
    ) || 'not sourced',
    18,
  );

  const resultEdge = truncateWords(
    firstText(
      model?.result_edge,
      model?.edge,
      model?.read,
      model?.model_edge,
    ) || 'not sourced',
    18,
  );

  const modelCaveat = truncateWords(firstText(model?.caveat, model?.model_caveat, model?.risk_note) || 'unavailable', 18);
  const keySourceContext = pickKeySourceContext(research);

  return {
    result_edge: scrubCustomerText(`Result edge: ${resultEdge}`),
    projected: scrubCustomerText(`Projected: ${projected}`),
    total_environment: scrubCustomerText(`Total environment: ${totalEnvironment}`),
    key_source_context: scrubCustomerText(keySourceContext),
    model_caveat: scrubCustomerText(`Model caveat: ${modelCaveat}`),
  };
}

function buildModelOnlyWhy(model, sport) {
  return firstText(
    model?.why_it_matters,
    model?.context_summary,
    model?.stakes,
    model?.stakes_summary,
    model?.context,
    model?.match_context,
    model?.game_context,
  ) || (sport === 'worldcup' ? 'Match context unavailable.' : 'Game context unavailable.');
}

function assembleText({ headline, whyItMatters, storyline, quickRead, displayOnlyMarketLine }) {
  const lines = [
    `Headline: ${headline}`,
    `Why it matters: ${whyItMatters}`,
    `Storyline: ${storyline}`,
    'Quick read:',
    `- ${quickRead.result_edge}`,
    `- ${quickRead.projected}`,
    `- ${quickRead.total_environment}`,
    `- ${quickRead.key_source_context}`,
    `- ${quickRead.model_caveat}`,
  ];

  if (displayOnlyMarketLine) {
    lines.push(`Market context (display only, NOT IN SCORE): ${displayOnlyMarketLine}`);
  }

  return scrubCustomerText(lines.join('\n'));
}

function usableResearch(research) {
  return Boolean(research) && research !== 'PERPLEXITY_UNAVAILABLE' && research?.status !== 'PERPLEXITY_UNAVAILABLE';
}

export function buildSportsPreview({ sport, packet_type, id, model = {}, research = null, generatedAtUtc = new Date().toISOString() }) {
  const hasResearch = usableResearch(research);
  const headline = scrubCustomerText(pickHeadline(research, sport, packet_type, id));
  const whyItMatters = scrubCustomerText(hasResearch ? pickWhy(research, model, sport) : buildModelOnlyWhy(model, sport));
  const storyline = composeStoryline({ research: hasResearch ? research : null, model, sport, packet_type });
  const quickRead = buildQuickRead({ model, research: hasResearch ? research : null, sport, packet_type });
  const displayOnlyMarketLine = firstText(
    model?.display_only_market_line,
    isObject(model?.market_context) && model.market_context.display_only === true
      ? firstText(model.market_context.display_only_line, model.market_context.line, model.market_context.summary)
      : '',
  );

  const text = assembleText({
    headline,
    whyItMatters,
    storyline,
    quickRead,
    displayOnlyMarketLine: displayOnlyMarketLine ? scrubCustomerText(displayOnlyMarketLine) : '',
  });

  return {
    text,
    sections: {
      headline,
      why_it_matters: whyItMatters,
      storyline,
      quick_read: quickRead,
    },
    used_research: hasResearch,
    fallback: !hasResearch,
  };
}

export function assembleCpcPreviewPacket({ title, generatedAtUtc, previewText }) {
  const humanUtc = formatChicagoDateTime(generatedAtUtc);
  const text = [
    `=== CPC Packet: ${toText(title, 'Sports Preview')} ===`,
    `generated_utc: ${humanUtc}`,
    'Market Context — NOT IN SCORE.',
    previewText,
    'Research only. No trades.',
  ].join('\n');

  validateCpcCustomerPacket(text);
  return text;
}
