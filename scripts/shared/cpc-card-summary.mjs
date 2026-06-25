// Shared customer-facing CPC card helpers.
// Pure formatting only: no I/O, no network, no credentials, no pricing math.

export const PRICE_CONTEXT_DISPLAY_ONLY =
  'Price is display-only and was not used in CPC posture or scoring.';

export const APPROVED_CPC_READS = Object.freeze([
  'PICK',
  'LEAN',
  'WATCH',
  'FADE',
  'PASS',
  'BLOCKED',
]);

export const CPC_READ_DISPLAY_TEXT = Object.freeze({
  PICK: 'top-rated model side',
  LEAN: 'rates higher',
  WATCH: 'monitor only',
  FADE: 'lower-rated by CPC',
  PASS: 'no rated view',
  BLOCKED: 'blocked — missing required evidence',
});

export const APPROVED_EVIDENCE_STATUSES = Object.freeze([
  'complete',
  'thin',
  'provisional',
  'blocked',
  'unavailable',
]);

function cleanText(value, fallback = 'unavailable') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCpcRead(value, fallback = 'WATCH') {
  const raw = cleanText(value, fallback).toUpperCase().replace(/[-\s]+/g, '_');
  if (raw === 'CLEAR_PICK' || raw === 'STRONG_EVIDENCE_LEAN') return 'PICK';
  if (raw === 'EVIDENCE_LEAN' || raw === 'MARKET_ONLY_LEAN' || raw === 'BUY_YES' || raw === 'BUY_NO') return 'LEAN';
  if (raw === 'NO_CLEAR_PICK' || raw === 'NO_PICK' || raw === 'NO_EDGE') return 'PASS';
  if (raw === 'CONTEXT_WATCH' || raw === 'MONITOR_ONLY') return 'WATCH';
  if (raw === 'BLOCK' || raw === 'BLOCKED_SOURCE_LAYER_MISSING') return 'BLOCKED';
  if (APPROVED_CPC_READS.includes(raw)) return raw;
  return fallback;
}

export function describeCpcRead(value, {
  subject = null,
  comparison = null,
  fallback = 'no rated view',
} = {}) {
  const read = normalizeCpcRead(value);
  const left = cleanText(subject, '');
  const right = cleanText(comparison, '');
  if (left && right) {
    if (read === 'PICK' || read === 'LEAN') return `${left} rate higher than ${right}.`;
    if (read === 'FADE') return `${left} rate lower than ${right}.`;
  }
  return CPC_READ_DISPLAY_TEXT[read] ?? cleanText(fallback, 'no rated view');
}

export function normalizeEvidenceStatus(value, fallback = 'provisional') {
  const raw = cleanText(value, fallback).toLowerCase().replace(/[-\s]+/g, '_');
  if (raw === 'ready' || raw === 'complete' || raw === 'confirmed') return 'complete';
  if (raw === 'thin' || raw === 'partial' || raw === 'limited') return 'thin';
  if (raw === 'blocked' || raw === 'fail_closed') return 'blocked';
  if (raw === 'missing' || raw === 'unavailable' || raw === 'none') return 'unavailable';
  if (raw === 'provisional' || raw === 'waiting' || raw === 'needs_pricing') return 'provisional';
  return fallback;
}

export function evidenceStatusFrom({
  explicit = null,
  status = null,
  blocker = null,
  layersPresent = null,
  layersTotal = null,
  sourceAvailable = null,
} = {}) {
  if (explicit) return normalizeEvidenceStatus(explicit);
  if (blocker) return 'blocked';
  const statusText = cleanText(status, '').toLowerCase();
  if (/blocked|fail|no usable/.test(statusText)) return 'blocked';
  if (/unavailable|missing/.test(statusText)) return 'unavailable';
  if (/waiting|needs|provisional|pending/.test(statusText)) return 'provisional';
  if (sourceAvailable === false) return 'unavailable';

  const present = num(layersPresent);
  const total = num(layersTotal);
  if (present !== null && total && total > 0) {
    const ratio = present / total;
    if (ratio >= 0.8) return 'complete';
    if (ratio >= 0.35) return 'thin';
    return 'unavailable';
  }

  if (/ready|complete|active/.test(statusText)) return 'complete';
  return 'provisional';
}

export function formatBaseRate(value) {
  if (!value) return { summary: 'unavailable', sample_size: null, hit_rate: null, tier: null };
  if (typeof value === 'string') {
    return { summary: cleanText(value), sample_size: null, hit_rate: null, tier: null };
  }
  const sampleSize = value.sample_size ?? value.sampleSize ?? value.n ?? null;
  const hitRate = value.hit_rate ?? value.hitRate ?? null;
  const tier = value.tier ?? value.match_tier ?? value.matchTier ?? null;
  const summary = value.summary
    ?? [
      sampleSize != null ? `n=${sampleSize}` : null,
      hitRate != null ? `hit_rate=${hitRate}` : null,
      tier ? `tier=${tier}` : null,
    ].filter(Boolean).join(', ')
    ?? 'unavailable';
  return {
    summary: summary || 'unavailable',
    sample_size: sampleSize,
    hit_rate: hitRate,
    tier,
  };
}

export function buildCpcCardSummary({
  title,
  subtitle,
  plainEnglish,
  settlement,
  route,
  cpcRead,
  cpcReadText = null,
  evidenceStatus,
  baseRate = null,
  priceContext = PRICE_CONTEXT_DISPLAY_ONLY,
  ticker = null,
  marketId = null,
  eventId = null,
  reason = null,
} = {}) {
  return {
    title: cleanText(title, 'CPC card'),
    subtitle: cleanText(subtitle, 'Private CPC research card'),
    plain_english: cleanText(plainEnglish, 'This card explains the contract or game in plain English.'),
    settlement: cleanText(settlement, 'Settlement follows the market rules.'),
    route: cleanText(route, 'cpc/general'),
    cpc_read: normalizeCpcRead(cpcRead),
    cpc_read_text: cpcReadText ? cleanText(cpcReadText, null) : null,
    evidence_status: normalizeEvidenceStatus(evidenceStatus),
    base_rate: formatBaseRate(baseRate),
    price_context: cleanText(priceContext, PRICE_CONTEXT_DISPLAY_ONLY),
    ticker_or_market_id: cleanText(ticker ?? marketId ?? eventId, 'unavailable'),
    ids: {
      ticker: ticker ?? null,
      market_id: marketId ?? null,
      event_id: eventId ?? null,
    },
    reason: reason ? cleanText(reason) : null,
  };
}

export function renderCpcCardText(card = {}) {
  const baseRate = formatBaseRate(card.base_rate);
  const ids = card.ids ?? {};
  const tickerLine = cleanText(
    card.ticker_or_market_id ?? ids.ticker ?? ids.market_id ?? ids.event_id,
    'unavailable',
  );
  const cpcReadText = cleanText(
    card.cpc_read_text ?? describeCpcRead(card.cpc_read),
    'no rated view',
  );
  const lines = [
    `Big title: ${cleanText(card.title, 'CPC card')}`,
    `Subtitle: ${cleanText(card.subtitle, 'Private CPC research card')}`,
    `Plain English: ${cleanText(card.plain_english, 'This card explains the contract or game in plain English.')}`,
    `Settlement: ${cleanText(card.settlement, 'Settlement follows the market rules.')}`,
    `Route: ${cleanText(card.route, 'cpc/general')}`,
    `CPC Read: ${cpcReadText}`,
    `Evidence status: ${normalizeEvidenceStatus(card.evidence_status)}`,
    `Base rate: ${baseRate.summary}`,
    `Price context: ${cleanText(card.price_context, PRICE_CONTEXT_DISPLAY_ONLY)}`,
    `Ticker/market ID: ${tickerLine}`,
  ];
  if (card.reason) lines.push(`Reason: ${cleanText(card.reason)}`);
  return lines.join('\n');
}

export function buildCpcStackItem({ rank = null, ...cardInput } = {}) {
  return {
    rank,
    ...buildCpcCardSummary(cardInput),
  };
}

export function renderCpcStackText(items = []) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return 'CPC stack: no rows available.';
  return rows.map((item, index) => {
    const rank = item.rank ?? index + 1;
    const cpcReadText = cleanText(
      item.cpc_read_text ?? describeCpcRead(item.cpc_read),
      'no rated view',
    );
    return [
      `#${rank} ${cleanText(item.title, 'CPC card')}`,
      `Plain English: ${cleanText(item.plain_english, 'This card explains the contract or game in plain English.')}`,
      `Ticker/market ID: ${cleanText(item.ticker_or_market_id, 'unavailable')}`,
      `Route: ${cleanText(item.route, 'cpc/general')}`,
      `Base rate: ${formatBaseRate(item.base_rate).summary}`,
      `Evidence status: ${normalizeEvidenceStatus(item.evidence_status)}`,
      `CPC Read: ${cpcReadText}`,
      item.reason ? `Reason: ${cleanText(item.reason)}` : null,
      `Price context: ${cleanText(item.price_context, PRICE_CONTEXT_DISPLAY_ONLY)}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}
