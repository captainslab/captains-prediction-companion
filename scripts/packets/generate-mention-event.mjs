#!/usr/bin/env node
// Manual single-event earnings-call mention packet generator.
// URL/ticker in, Perplexity source-backed customer packet out. No Telegram. No trades.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { makeEmptyCpcResearchArtifact, assertCpcResearchArtifact } from '../shared/cpc-research-artifact-schema.mjs';
import { buildPerplexityEntityAttachmentContract } from '../shared/perplexity-attachment-contract.mjs';
import { CPC_RESEARCH_PROMPT_BUILDERS } from '../shared/perplexity-preview-prompts.mjs';
import { sanitizeResearchArtifact, assertNoMarketLeak } from '../shared/preview-artifact-sanitizer.mjs';
import { writeResearchBankArtifacts } from '../shared/cpc-research-bank.mjs';
import { validateCpcCustomerPacket } from './lib/cpc-packet-validator.mjs';
import { defaultFetcher, KALSHI_API_BASE } from './lib/kalshi-discovery.mjs';
import { resolveResearchRoute } from '../mentions/mention-route-resolver.mjs';
import { validatePacketText } from '../cron/cpc-packet-janitor.mjs';
import { ensurePerplexityEnvLoaded, hasPerplexityKey } from '../mentions/mentions-research-perplexity.mjs';

const PACKET_TYPE = 'mention-event';
const RESEARCH_PACKET_TYPE = 'earnings-call-mention';
const ROUTE = 'earnings_call';
const COMPANY = 'FedEx';
const TICKER = 'FDX';
const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const PPLX_KEY_PATH = path.resolve(homedir(), '.config/cpc/perplexity.key');
const DEFAULT_SOURCE_URLS = Object.freeze([
  'https://investors.fedex.com/home/default.aspx',
  'https://investors.fedex.com/news-and-events/upcoming-events/upcoming-events-details/2026/FedEx-Q4-FY26-Earnings-Call/default.aspx',
  'https://investors.fedex.com/news-and-events/webcasts-and-presentations/default.aspx',
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=FDX&owner=exclude&count=10',
]);

function usage() {
  return [
    'Usage:',
    '  node scripts/packets/generate-mention-event.mjs --event-url <kalshi-url> --date YYYY-MM-DD [--dry-run]',
    '  node scripts/packets/generate-mention-event.mjs --event KXEARNINGSMENTIONFDX-26JUN23 --date YYYY-MM-DD [--dry-run]',
    '',
    'No Telegram send. No trades. Writes packet + research bank artifacts under state/.',
  ].join('\n');
}

function readFlag(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

export function parseEventIdFromUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const withoutQuery = text.split('?')[0];
  const parts = withoutQuery.split('/').filter(Boolean);
  const last = parts.at(-1) ?? '';
  return /^KX[A-Z0-9-]+$/i.test(last) ? last.toUpperCase() : null;
}

export function parseMentionEventArgs(argv = process.argv.slice(2)) {
  const eventUrl = readFlag(argv, '--event-url') ?? readFlag(argv, '--url');
  const eventArg = readFlag(argv, '--event') ?? readFlag(argv, '--event-id');
  const eventId = (eventArg ?? parseEventIdFromUrl(eventUrl) ?? '').toUpperCase();
  const date = readFlag(argv, '--date') ?? new Date().toISOString().slice(0, 10);
  const stateRoot = readFlag(argv, '--state-root') ?? 'state';
  const dryRun = argv.includes('--dry-run');
  const help = argv.includes('--help') || argv.includes('-h');

  if (help) return { help, eventUrl, eventId, date, stateRoot, dryRun };
  if (!eventId || !/^KX[A-Z0-9-]+$/.test(eventId)) throw new Error('missing or invalid --event / --event-url');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid --date: ${date}`);
  return { help, eventUrl, eventId, date, stateRoot, dryRun };
}

function text(value, fallback = 'unavailable') {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s || fallback;
}

function titleForSource(url) {
  if (/upcoming-events-details\/2026\/FedEx-Q4-FY26-Earnings-Call/i.test(url)) return 'FedEx Q4 FY26 Earnings Call | FedEx';
  if (/webcasts-and-presentations/i.test(url)) return 'Webcasts & presentations | FedEx';
  if (/sec\.gov/i.test(url)) return 'EDGAR Search Results — FEDEX CORP';
  return 'Investor Relations | FedEx';
}

function extractStrikeTerm(market = {}) {
  const custom = market.custom_strike;
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  if (custom && typeof custom === 'object') {
    for (const key of ['Word', 'word', 'Term', 'term', 'Phrase', 'phrase']) {
      if (typeof custom[key] === 'string' && custom[key].trim()) return custom[key].trim();
    }
  }
  for (const key of ['yes_sub_title', 'subtitle', 'title']) {
    if (typeof market[key] === 'string' && market[key].trim()) return market[key].trim();
  }
  return text(market.ticker, 'unavailable');
}

function stripPriceLikeFields(input) {
  const priceKey = /price|bid|ask|volume|liquidity|open_interest|notional|orderbook|order_book|market_snapshot|oi/i;
  if (Array.isArray(input)) return input.map(stripPriceLikeFields);
  if (input && typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (priceKey.test(key)) continue;
      out[key] = stripPriceLikeFields(value);
    }
    return out;
  }
  return input;
}

function eventForRoute(kalshiEvent) {
  return stripPriceLikeFields({
    event_ticker: kalshiEvent?.event_ticker,
    series_ticker: kalshiEvent?.series_ticker,
    title: kalshiEvent?.title,
    sub_title: kalshiEvent?.sub_title,
    markets: (kalshiEvent?.markets ?? []).map((m) => ({
      ticker: m.ticker,
      title: m.title,
      subtitle: m.subtitle,
      yes_sub_title: m.yes_sub_title,
      custom_strike: m.custom_strike,
      rules_primary: m.rules_primary,
      rules_secondary: m.rules_secondary,
    })),
  });
}

async function fetchKalshiEvent(eventId, kalshiFetcher) {
  const url = `${KALSHI_API_BASE}/events/${encodeURIComponent(eventId)}`;
  const result = await kalshiFetcher(url);
  if (!result?.ok || !result?.json) throw new Error(`Kalshi event fetch failed for ${eventId}: ${result?.error ?? result?.status ?? 'unknown error'}`);
  const event = result.json.event ?? null;
  const markets = Array.isArray(result.json.markets) ? result.json.markets : (Array.isArray(event?.markets) ? event.markets : []);
  if (!event?.event_ticker) throw new Error(`Kalshi event payload missing event_ticker for ${eventId}`);
  return { ...event, markets };
}

function readPerplexityKey(env = process.env) {
  ensurePerplexityEnvLoaded(env);
  const fromEnv = (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY || '').replace(/\s+/g, '');
  if (fromEnv) return fromEnv;
  if (fs.existsSync(PPLX_KEY_PATH)) {
    const key = fs.readFileSync(PPLX_KEY_PATH, 'utf8').replace(/\s+/g, '');
    if (key) return key;
  }
  throw new Error('Perplexity key unavailable (env / .env.local / ~/.config/cpc/perplexity.key)');
}

async function defaultPerplexityImpl({ key, messages, model = 'sonar', maxTokens = 2200, timeoutMs = 65000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(PPLX_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.1, return_citations: true }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Perplexity HTTP ${res.status}: ${json?.error?.message || 'unknown'}`);
    return {
      content: json?.choices?.[0]?.message?.content ?? '',
      citations: Array.isArray(json?.citations) ? json.citations : [],
      search_results: Array.isArray(json?.search_results) ? json.search_results : [],
      usage: json?.usage ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(value) {
  const body = String(value ?? '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function buildPerplexityMessages({ promptContract, eventId, eventUrl, kalshiEvent, checkedAt }) {
  const strikeTerms = (kalshiEvent.markets ?? []).map(extractStrikeTerm).filter(Boolean);
  return [
    { role: 'system', content: promptContract.system },
    {
      role: 'user',
      content: [
        promptContract.user,
        '',
        'MANUAL SINGLE-EVENT EARNINGS MENTION INPUT:',
        `event_id: ${eventId}`,
        `event_url: ${eventUrl ?? `https://kalshi.com/events/${eventId}`}`,
        `company: ${COMPANY}`,
        `ticker: ${TICKER}`,
        `checked_at: ${checkedAt}`,
        `strike_terms: ${JSON.stringify(strikeTerms)}`,
        `source_urls_to_check_first: ${JSON.stringify(DEFAULT_SOURCE_URLS)}`,
        '',
        'Kalshi event contract context with all price-like fields removed:',
        JSON.stringify(stripPriceLikeFields(kalshiEvent), null, 2),
        '',
        'Return cpc_research_artifact_v1 JSON only. Required FedEx fields: company_identity, ticker, fiscal_period, earnings_call_datetime, executive_speakers, press_release_url, webcast_url, sec_filing_urls, prepared_remarks_status, transcript_status, prior_call_topics, current_guidance_topics, known_issues, current_catalysts. Use unavailable/not sourced when absent. Do not output prices, odds, volume, open interest, probabilities, scores, rankings, or local paths.',
      ].join('\n'),
    },
  ];
}

function normalizePerplexityArtifact(parsed, { eventUrl, eventId, kalshiEvent, checkedAt, promptContract }) {
  const strikeTerms = (kalshiEvent.markets ?? []).map(extractStrikeTerm).filter(Boolean);
  const rulesPrimary = text(kalshiEvent.markets?.[0]?.rules_primary, 'unavailable');
  const base = makeEmptyCpcResearchArtifact({
    packet_family: 'mentions',
    packet_type: RESEARCH_PACKET_TYPE,
    route: ROUTE,
    submarket: 'event',
    event_id: eventId,
    market_id: eventId,
    event_url: eventUrl ?? `https://kalshi.com/events/${eventId}`,
    generated_at: checkedAt,
  });
  const artifact = { ...base, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  artifact.schema = base.schema;
  artifact.packet_family = 'mentions';
  artifact.packet_type = RESEARCH_PACKET_TYPE;
  artifact.route = ROUTE;
  artifact.submarket = 'event';
  artifact.event_id = eventId;
  artifact.market_id = eventId;
  artifact.event_url = eventUrl ?? `https://kalshi.com/events/${eventId}`;
  artifact.generated_at = text(artifact.generated_at, checkedAt);
  artifact.source_id = 'perplexity';
  artifact.source_urls = Array.isArray(artifact.source_urls) ? artifact.source_urls.map(String) : [];
  artifact.source_titles = Array.isArray(artifact.source_titles) ? artifact.source_titles.map(String) : [];
  if (!artifact.source_titles.length && artifact.source_urls.length) artifact.source_titles = artifact.source_urls.map(titleForSource);
  artifact.source_freshness = Array.isArray(artifact.source_freshness) ? artifact.source_freshness : [];
  artifact.source_freshness = artifact.source_urls.map((url, i) => {
    const existing = artifact.source_freshness[i] ?? {};
    return {
      url,
      published_at: text(existing.published_at, 'unavailable'),
      checked_at: text(existing.checked_at, checkedAt),
      freshness: ['same_day', '1d', '2to7d', 'stale', 'undated'].includes(existing.freshness) ? existing.freshness : 'undated',
    };
  });
  artifact.confirmed_facts = Array.isArray(artifact.confirmed_facts) ? artifact.confirmed_facts.map(String) : [];
  artifact.unconfirmed_claims = Array.isArray(artifact.unconfirmed_claims) ? artifact.unconfirmed_claims.map(String) : [];
  artifact.unavailable_fields = Array.isArray(artifact.unavailable_fields) ? artifact.unavailable_fields.map(String) : [];
  artifact.headline_candidates = Array.isArray(artifact.headline_candidates) ? artifact.headline_candidates.map(String) : [];
  artifact.risk_notes = Array.isArray(artifact.risk_notes) ? artifact.risk_notes.map(String) : [];
  artifact.model_safe_inputs = {
    ...(artifact.model_safe_inputs && typeof artifact.model_safe_inputs === 'object' ? artifact.model_safe_inputs : {}),
    company_identity: text(artifact.model_safe_inputs?.company_identity, 'FedEx Corporation'),
    ticker: text(artifact.model_safe_inputs?.ticker, TICKER),
    settlement_scope: text(artifact.model_safe_inputs?.settlement_scope, rulesPrimary),
    strike_terms: Array.isArray(artifact.model_safe_inputs?.strike_terms) && artifact.model_safe_inputs.strike_terms.length ? artifact.model_safe_inputs.strike_terms : strikeTerms,
  };
  const factsText = artifact.confirmed_facts.join(' ');
  if (/\b(unavailable|not sourced)\b/i.test(text(artifact.model_safe_inputs.earnings_call_datetime)) && /June 23, 2026[^.]*04:00 PM CT/i.test(factsText)) {
    artifact.model_safe_inputs.earnings_call_datetime = 'June 23, 2026 at 04:00 PM CT';
    artifact.unavailable_fields = artifact.unavailable_fields.filter((field) => String(field) !== 'earnings_call_datetime');
  }
  artifact.editorial_context = stripPriceLikeFields(artifact.editorial_context && typeof artifact.editorial_context === 'object' ? artifact.editorial_context : {});
  artifact.market_context = { display_only: true, text: 'Market Context — NOT IN SCORE. Research only; no trades.' };
  if (!artifact.source_urls.length) artifact.unavailable_fields.push('source_urls');
  if (!artifact.confirmed_facts.length) artifact.unavailable_fields.push('confirmed_facts');
  artifact.prompt_contract = { packet_type: promptContract.packet_type, route: promptContract.route, submarket: promptContract.submarket };
  return artifact;
}

function scrubCustomerText(value) {
  return text(value, 'unavailable')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?Z?/g, '(timestamp withheld)')
    .replace(/(?:^|\s)\/home\/\S+/g, ' (path withheld)')
    .replace(/\S+\.mjs\b/g, '(module withheld)')
    .replace(/market_snapshot/gi, 'market context')
    .replace(/yes_bid|yes_ask|no_bid|no_ask|last_price|open_interest|orderbook|liquidity|volume/gi, 'market field');
}

function bullet(label, value) {
  return `- ${label}: ${scrubCustomerText(value)}`;
}

function renderList(lines, values, empty = '- unavailable') {
  const clean = (values ?? []).map(scrubCustomerText).filter((v) => v && v !== 'unavailable');
  if (!clean.length) {
    lines.push(empty);
    return;
  }
  for (const item of clean) lines.push(`- ${item}`);
}

function renderPacket({ date, eventId, eventUrl, artifact, routeResult }) {
  const input = artifact.model_safe_inputs ?? {};
  const sourceUnavailable = (artifact.unavailable_fields ?? [])
    .map((v) => String(v).replace(/_/g, ' '))
    .filter((v) => !/\b(?:price|bid|ask|volume|open interest|liquidity|market snapshot|orderbook|market field)\b/i.test(v));
  const strikeTerms = Array.isArray(input.strike_terms) ? input.strike_terms : [];
  const sourceLines = (artifact.source_titles ?? []).map((title, i) => `${scrubCustomerText(title)} — ${scrubCustomerText(artifact.source_urls?.[i] ?? 'unavailable')}`);
  const freshnessLine = (artifact.source_freshness ?? []).map((f) => `${titleForSource(f.url)}: ${f.freshness}`).join('; ') || 'unavailable';

  const lines = [];
  lines.push('=== Captain Mentions — CPC Packet: EARNINGS CALL MENTION EVENT ===');
  lines.push(`date: ${date}`);
  lines.push(`generated_utc: ${date}`);
  lines.push(`packet_type: ${PACKET_TYPE}`);
  lines.push(`route: ${ROUTE}`);
  lines.push(`event_id: ${eventId}`);
  lines.push(`company: ${COMPANY}`);
  lines.push('Market Context — NOT IN SCORE.');
  lines.push('Research only. No trades.');
  lines.push('');

  lines.push('1. Event Preview — Why This Call Matters');
  lines.push(scrubCustomerText(artifact.why_this_matters));
  lines.push('This is a manual research packet and not a full daily board. It isolates the FedEx event only.');
  lines.push('');

  lines.push('2. Market / Settlement Scope');
  lines.push(bullet('Event URL', eventUrl ?? `https://kalshi.com/events/${eventId}`));
  lines.push(bullet('Settlement scope', input.settlement_scope));
  lines.push(bullet('Eligible speakers', 'any FedEx Corporation representative, including the operator and Q&A participants, per Kalshi settlement wording'));
  lines.push(bullet('Strike count', String(strikeTerms.length || 'unavailable')));
  lines.push(bullet('Unavailable fields', sourceUnavailable.length ? sourceUnavailable.join(', ') : 'none'));
  lines.push('');

  lines.push('3. Source-Backed Company Context');
  lines.push(bullet('Company identity', input.company_identity));
  lines.push(bullet('Ticker', input.ticker));
  lines.push(bullet('Fiscal period', input.fiscal_period));
  lines.push(bullet('SEC filing source', Array.isArray(input.sec_filing_urls) ? input.sec_filing_urls[0] : input.sec_filing_urls));
  lines.push('Confirmed facts:');
  renderList(lines, artifact.confirmed_facts);
  lines.push('Sources used:');
  renderList(lines, sourceLines);
  lines.push('');

  lines.push('4. Earnings Call Context');
  lines.push(bullet('Earnings call time', input.earnings_call_datetime));
  lines.push(bullet('Executive speakers', input.executive_speakers));
  lines.push(bullet('Press release URL', input.press_release_url));
  lines.push(bullet('Webcast URL', input.webcast_url));
  lines.push(bullet('Prepared remarks status', input.prepared_remarks_status));
  lines.push(bullet('Transcript status', input.transcript_status));
  lines.push(bullet('Prior call topics', Array.isArray(input.prior_call_topics) ? input.prior_call_topics.join('; ') : input.prior_call_topics));
  lines.push(bullet('Current guidance topics', Array.isArray(input.current_guidance_topics) ? input.current_guidance_topics.join('; ') : input.current_guidance_topics));
  lines.push(bullet('Known issues / catalysts', Array.isArray(input.current_catalysts) ? input.current_catalysts.join('; ') : input.current_catalysts));
  lines.push('');

  lines.push('5. Mention/Strike Terms');
  renderList(lines, strikeTerms);
  lines.push('');

  lines.push('6. Model Read');
  lines.push(bullet('Route proof', `${routeResult.route} via ${routeResult.basis}; profile ${routeResult.profile_key}; deterministic CPC resolver only`));
  lines.push('CPC model read: no probabilistic strike ranking is produced from this manual packet. Source-backed schedule, settlement scope, and official-company context are sufficient for a research packet; phrase likelihood remains unavailable until prepared remarks, transcript, or term-level source evidence is sourced.');
  lines.push('Market context is display-only and cannot affect route, confidence, headline, strike focus, ranking, posture, or source selection.');
  lines.push('');

  lines.push('7. Source Quality / Caveats');
  lines.push(bullet('Source freshness', freshnessLine));
  lines.push(bullet('Prepared remarks status', input.prepared_remarks_status));
  lines.push(bullet('Transcript status', input.transcript_status));
  lines.push(bullet('Unavailable fields', sourceUnavailable.length ? sourceUnavailable.join(', ') : 'none'));
  renderList(lines, artifact.risk_notes);
  lines.push('');

  lines.push('8. Model Limits');
  lines.push('Manual single-event packet only; not a daily mentions board and not a trade recommendation.');
  lines.push('The packet does not invent call details, speakers, prepared remarks, transcript status, or strike-level probabilities.');
  lines.push('Market Context — NOT IN SCORE. Research only / no trades.');
  lines.push('');
  lines.push('---');
  lines.push('Market Context — NOT IN SCORE. Research only. No trades.');

  return lines.join('\n');
}

function priceIsolationProof(sanitized, packetText) {
  const checks = {};
  let pass = true;
  try {
    assertNoMarketLeak(sanitized.model_safe_inputs);
    checks.model_safe_inputs = 'PASS';
  } catch (err) {
    checks.model_safe_inputs = `FAIL: ${err.message}`;
    pass = false;
  }
  const renderedLeak = /yes_bid|yes_ask|no_bid|no_ask|last_price|open_interest|orderbook|liquidity|market_snapshot|\b\d{1,3}\s*(?:¢|cents)\b/i.test(packetText);
  checks.customer_text = renderedLeak ? 'FAIL' : 'PASS';
  if (renderedLeak) pass = false;
  const pathLeak = /(?:^|\s)\/home\/|\.mjs\b/.test(packetText);
  checks.no_local_paths = pathLeak ? 'FAIL' : 'PASS';
  if (pathLeak) pass = false;
  const isoLeak = /\d{4}-\d\d-\d\dT\d\d:\d\d/.test(packetText);
  checks.no_raw_iso_timestamps = isoLeak ? 'FAIL' : 'PASS';
  if (isoLeak) pass = false;
  return { pass, checks };
}

export async function generateMentionEventPacket({
  eventUrl = null,
  eventId,
  date,
  stateRoot = 'state',
  dryRun = false,
  kalshiFetcher = defaultFetcher,
  env = process.env,
  perplexityImpl = defaultPerplexityImpl,
  perplexityModel = 'sonar',
  now = () => new Date().toISOString(),
} = {}) {
  if (!eventId) throw new Error('eventId is required');
  const checkedAt = now();
  const kalshiEvent = await fetchKalshiEvent(eventId, kalshiFetcher);
  const routeEvent = eventForRoute(kalshiEvent);
  const route = resolveResearchRoute(routeEvent, { now: new Date(`${date}T12:00:00Z`) });
  if (route.route !== ROUTE) throw new Error(`manual earnings mention path refused route=${route.route}; expected ${ROUTE}`);

  const promptContract = CPC_RESEARCH_PROMPT_BUILDERS[RESEARCH_PACKET_TYPE]({
    event_id: eventId,
    market_id: eventId,
    event_url: eventUrl ?? `https://kalshi.com/events/${eventId}`,
    route: ROUTE,
    submarket: 'event',
    date_central: date,
  });

  if (!hasPerplexityKey(env)) throw new Error('Perplexity key unavailable for manual earnings mention research');
  const key = readPerplexityKey(env);
  const messages = buildPerplexityMessages({ promptContract, eventId, eventUrl, kalshiEvent, checkedAt });
  const perplexityRun = await perplexityImpl({ key, model: perplexityModel, messages });
  const parsed = extractJsonObject(perplexityRun.content);
  if (!parsed) throw new Error('Perplexity did not return a JSON research artifact');
  const normalized = normalizePerplexityArtifact(parsed, { eventUrl, eventId, kalshiEvent, checkedAt, promptContract });
  assertCpcResearchArtifact(normalized, eventId);

  const sanitized = sanitizeResearchArtifact(normalized);
  assertNoMarketLeak(sanitized.model_safe_inputs);
  const attachmentContract = buildPerplexityEntityAttachmentContract({
    entity_type: 'mention_event',
    entity_ids: [eventId],
    attached_entity_ids: Array.isArray(sanitized.source_urls) && sanitized.source_urls.length ? [eventId] : [],
  });
  if (!attachmentContract.all_entities_attached) {
    throw new Error(`Perplexity attachment contract failed closed for ${eventId}: no source-backed event attachment`);
  }

  const packetText = renderPacket({ date, eventId, eventUrl, artifact: sanitized, routeResult: route });
  const contract = validateCpcCustomerPacket(packetText);
  const janitor = validatePacketText(packetText, { packetType: PACKET_TYPE, stateRoot, date });
  const priceIsolation = priceIsolationProof(sanitized, packetText);

  const bank = writeResearchBankArtifacts({
    date,
    packet_family: sanitized.packet_family,
    packet_type: sanitized.packet_type,
    event_id: sanitized.event_id,
    route: sanitized.route,
    submarket: sanitized.submarket,
    raw: {
      event_id: eventId,
      event_url: eventUrl,
      kalshi_event: routeEvent,
      prompt_messages: messages,
      perplexity_citations: perplexityRun.citations ?? [],
      perplexity_search_results: (perplexityRun.search_results ?? []).map((s) => ({ title: s?.title ?? null, url: s?.url ?? null, date: s?.date ?? null })),
    },
    normalized,
    sanitized,
    builderInput: {
      prompt_contract: { packet_type: promptContract.packet_type, route: promptContract.route, submarket: promptContract.submarket },
      route_proof: route,
      sanitized_removed: sanitized.sanitized_removed ?? [],
      price_isolation: priceIsolation,
      contract_valid: contract.valid,
      janitor_verdict: janitor.verdict,
      attachment_contract: attachmentContract,
      dry_run: dryRun,
    },
    previewText: packetText,
    lineage: {
      generated_at: normalized.generated_at,
      source_id: normalized.source_id,
      source_urls: normalized.source_urls,
      source_titles: normalized.source_titles,
      source_freshness: normalized.source_freshness,
    },
    root: path.join(stateRoot, 'research'),
  });

  const packetDir = path.resolve(stateRoot, 'previews', date, PACKET_TYPE);
  fs.mkdirSync(packetDir, { recursive: true });
  const packetPath = path.join(packetDir, `${eventId}.txt`);
  fs.writeFileSync(packetPath, `${packetText}\n`, 'utf8');

  const proofPath = path.join(packetDir, `${eventId}.proof.json`);
  const proof = {
    event_id: eventId,
    route,
    prompt_contract: { packet_type: promptContract.packet_type, route: promptContract.route, submarket: promptContract.submarket },
    packet_path: packetPath,
    research_bank_dir: bank.dir,
    source_urls: sanitized.source_urls,
    source_titles: sanitized.source_titles,
    source_freshness: sanitized.source_freshness,
    attachment_contract: attachmentContract,
    unavailable_fields: sanitized.unavailable_fields ?? [],
    sanitized_removed: sanitized.sanitized_removed ?? [],
    contract_valid: contract.valid,
    contract_errors: contract.errors,
    janitor_verdict: janitor.verdict,
    janitor_errors: janitor.errors,
    janitor_warnings: janitor.warnings,
    price_isolation: priceIsolation,
    dry_run: dryRun,
    no_telegram_send: true,
    no_trades: true,
  };
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');

  return {
    eventId,
    packetPath,
    proofPath,
    researchBankDir: bank.dir,
    sanitized,
    route,
    promptContract: proof.prompt_contract,
    contract,
    janitor,
    priceIsolation,
    attachmentContract,
    perplexity: { citations: perplexityRun.citations ?? [], search_results: perplexityRun.search_results ?? [], model: perplexityModel },
    dryRun,
  };
}

function printProof(result) {
  console.log('CPC manual mention-event packet proof');
  console.log('='.repeat(64));
  console.log(`event_id:            ${result.eventId}`);
  console.log(`packet_path:         ${result.packetPath}`);
  console.log(`proof_path:          ${result.proofPath}`);
  console.log(`research_bank_dir:   ${result.researchBankDir}`);
  console.log(`route_resolver:      route=${result.route.route} basis=${result.route.basis} profile=${result.route.profile_key}`);
  console.log(`prompt_contract:     packet_type=${result.promptContract.packet_type} route=${result.promptContract.route} submarket=${result.promptContract.submarket}`);
  console.log(`source_count:        ${result.sanitized.source_urls.length}`);
  console.log(`attachment_status:   ${result.attachmentContract.attached_count}/${result.attachmentContract.entity_count} event(s) attached`);
  console.log(`source_freshness:    ${result.sanitized.source_freshness.map((f) => f.freshness).join(', ')}`);
  console.log(`sanitized_removed:   ${JSON.stringify(result.sanitized.sanitized_removed ?? [])}`);
  console.log(`unavailable_fields:  ${JSON.stringify(result.sanitized.unavailable_fields ?? [])}`);
  console.log(`contract_valid:      ${result.contract.valid ? 'PASS' : `FAIL: ${result.contract.errors.join('; ')}`}`);
  console.log(`janitor_verdict:     ${result.janitor.verdict}${result.janitor.errors.length ? ` errors=${JSON.stringify(result.janitor.errors)}` : ''}`);
  console.log(`price_isolation:     ${result.priceIsolation.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(result.priceIsolation.checks)}`);
  console.log(`dry_run:             ${result.dryRun ? 'true (no send)' : 'false (still no send)'}`);
  console.log('Sources:');
  for (let i = 0; i < result.sanitized.source_titles.length; i += 1) {
    console.log(`  - ${result.sanitized.source_titles[i]} :: ${result.sanitized.source_urls[i]}`);
  }
}

async function main() {
  const opts = parseMentionEventArgs();
  if (opts.help) {
    console.log(usage());
    return;
  }
  const result = await generateMentionEventPacket(opts);
  printProof(result);
  if (!result.contract.valid || !result.priceIsolation.pass || result.janitor.errors.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exitCode = 1;
  });
}
