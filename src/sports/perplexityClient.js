/**
 * perplexityClient.js
 * Shared Perplexity API client for CPC sports research pipelines.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SPORT_TOKEN_BUDGETS, maxTokens: budgetMaxTokens } = require('./sportTokenBudgets.js');

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
const DEFAULT_MODEL = 'sonar';
const DEFAULT_TIMEOUT_MS = 55000;
const DEFAULT_TEMPERATURE = 0.1;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1200;
const KEY_FILE_PATH = path.resolve(os.homedir(), '.config', 'cpc', 'perplexity.key');

const BANNED_PROMPT_TERMS = [
  'bet', 'betting', 'wager', 'sportsbook', 'odds', 'moneyline', 'prop',
  'pick', 'lean', 'lock', 'fade', 'edge', 'trade', 'buy', 'sell',
  'bankroll', 'stake', 'unit', 'market price', 'bid', 'ask',
  'open interest', 'volume', 'liquidity', 'NOT IN SCORE', 'display-only',
];

function readPerplexityKey(env = process.env) {
  const fromEnv = (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY || '').replace(/\s+/g, '');
  if (fromEnv) return fromEnv;
  if (fs.existsSync(KEY_FILE_PATH)) {
    const key = fs.readFileSync(KEY_FILE_PATH, 'utf8').replace(/\s+/g, '');
    if (key) return key;
  }
  return null;
}

function hasPerplexityKey(env = process.env) {
  return readPerplexityKey(env) !== null;
}

function maxTokens(sport) {
  return budgetMaxTokens(sport);
}

function formatCitationBlock(citations = []) {
  if (!Array.isArray(citations) || citations.length === 0) return '(no citations)';
  return citations.map((citation, index) => {
    if (typeof citation === 'string') {
      return `[${index + 1}] ${citation}`;
    }
    const title = citation?.title ? String(citation.title).trim() : null;
    const url = citation?.url ? String(citation.url).trim() : null;
    const snippet = citation?.snippet ? String(citation.snippet).trim() : null;
    const parts = [title, url, snippet].filter(Boolean);
    return `[${index + 1}] ${parts.join(' | ') || JSON.stringify(citation)}`;
  }).join('\n');
}

function stripPolicyBlocks(prompt) {
  return String(prompt ?? '').replace(/\[POLICY_START\][\s\S]*?\[POLICY_END\]/g, '');
}

function auditPrompt(prompt, options = {}) {
  const { skipPolicyBlock = false } = options;
  const scanTarget = skipPolicyBlock ? stripPolicyBlocks(prompt) : String(prompt ?? '');
  const lower = scanTarget.toLowerCase();
  const violations = BANNED_PROMPT_TERMS.filter((term) => lower.includes(term.toLowerCase()));
  return { safe: violations.length === 0, violations };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProvidedNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function buildSafeFallback(sport, reason) {
  return {
    ok: false,
    status: 'unavailable',
    content: null,
    citations: [],
    cost: null,
    error: reason,
    _meta: {
      provider: 'perplexity',
      model: null,
      sport,
      status: 'unavailable',
      reason,
      fetched_utc: null,
      cost_usd: null,
      citations: [],
      parse_status: 'fallback',
      missing_fields: ['all'],
    },
    research: null,
  };
}

function buildMlbUserPrompt(game) {
  return [
    '[POLICY_START]',
    'Write for a general sports audience.',
    'Use neutral forecast language describing starters, lineup status, injuries, weather, and recent series context only.',
    'Return JSON only.',
    '[POLICY_END]',
    '',
    `Provide pre-game research context for the MLB game: ${game.awayTeam} at ${game.homeTeam} on ${game.gameDate}${game.venue ? ` at ${game.venue}` : ''}.`,
    '',
    'Return a JSON object with exactly these keys:',
    '{',
    '  "home_team": string,',
    '  "away_team": string,',
    '  "game_date": string,',
    '  "venue": string | null,',
    '  "home_starter_name": string | null,',
    '  "home_starter_handedness": "R" | "L" | "S" | null,',
    '  "home_starter_recent_note": string | null,',
    '  "away_starter_name": string | null,',
    '  "away_starter_handedness": "R" | "L" | "S" | null,',
    '  "away_starter_recent_note": string | null,',
    '  "home_lineup_status": "confirmed" | "projected" | "unavailable" | null,',
    '  "away_lineup_status": "confirmed" | "projected" | "unavailable" | null,',
    '  "home_injury_notes": string | null,',
    '  "away_injury_notes": string | null,',
    '  "home_bullpen_note": string | null,',
    '  "away_bullpen_note": string | null,',
    '  "weather_note": string | null,',
    '  "weather_risk": true | false | null,',
    '  "run_environment_note": string | null,',
    '  "recent_series_context": string | null,',
    '  "home_last_5_record": string | null,',
    '  "away_last_5_record": string | null,',
    '  "research_confidence": "high" | "medium" | "low",',
    '  "research_notes": string | null',
    '}',
    '',
    'Constraints:',
    '- Return null for any field you cannot verify.',
    '- Focus on publicly available game context only.',
  ].join('\n');
}

function buildWcUserPrompt(match) {
  return [
    '[POLICY_START]',
    'Write for a general sports audience.',
    'Use neutral forecast language describing team form, confirmed XI status, injuries, suspensions, and public match context only.',
    'Return JSON only.',
    '[POLICY_END]',
    '',
    `Provide pre-match research context for the FIFA World Cup match: ${match.homeTeam} vs ${match.awayTeam} on ${match.matchDate}${match.venue ? ` at ${match.venue}` : ''}${match.group ? ` (${match.group})` : ''}.`,
    '',
    'Return a JSON object with exactly these keys:',
    '{',
    '  "home_team": string,',
    '  "away_team": string,',
    '  "match_date": string,',
    '  "venue": string | null,',
    '  "group": string | null,',
    '  "home_confirmed_xi": string[] | null,',
    '  "away_confirmed_xi": string[] | null,',
    '  "home_xi_source": string | null,',
    '  "away_xi_source": string | null,',
    '  "home_xi_confirmed": true | false | null,',
    '  "away_xi_confirmed": true | false | null,',
    '  "home_injury_notes": string | null,',
    '  "away_injury_notes": string | null,',
    '  "home_suspension_notes": string | null,',
    '  "away_suspension_notes": string | null,',
    '  "group_standings_note": string | null,',
    '  "advancement_context": string | null,',
    '  "recent_form_home": string | null,',
    '  "recent_form_away": string | null,',
    '  "match_context_note": string | null,',
    '  "research_confidence": "high" | "medium" | "low",',
    '  "research_notes": string | null',
    '}',
    '',
    'Constraints:',
    '- Return null for any field you cannot verify.',
    '- Focus on publicly available match context only.',
  ].join('\n');
}

function parseContent(content) {
  if (typeof content !== 'string') return null;
  const cleaned = content
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function postPerplexity(apiKey, body, { timeoutMs = DEFAULT_TIMEOUT_MS, domainAllowlist = null } = {}) {
  const requestBody = { ...body };
  if (Array.isArray(domainAllowlist) && domainAllowlist.length > 0) {
    requestBody.search_domain_filter = domainAllowlist;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timeout);
  }
}

async function callPerplexity(opts = {}) {
  const {
    sport = 'unknown',
    systemPrompt = '',
    userPrompt = '',
    model = DEFAULT_MODEL,
    temperature = DEFAULT_TEMPERATURE,
    timeout,
    timeoutMs,
    domainAllowlist = null,
    dryRun = false,
    env = process.env,
    maxTokens: explicitMaxTokens = null,
  } = opts;

  const auditOptions = { skipPolicyBlock: true };
  const sysAudit = auditPrompt(systemPrompt, auditOptions);
  const userAudit = auditPrompt(userPrompt, auditOptions);
  if (!sysAudit.safe || !userAudit.safe) {
    const violations = [...new Set([...sysAudit.violations, ...userAudit.violations])];
    return buildSafeFallback(sport, `prompt_audit_fail:${violations.join(',')}`);
  }

  const apiKey = readPerplexityKey(env);
  if (!apiKey || dryRun) {
    return buildSafeFallback(sport, dryRun ? 'dry_run' : 'no_api_key');
  }

  const tokenBudget = Number.isFinite(Number(explicitMaxTokens))
    && explicitMaxTokens !== null
    && explicitMaxTokens !== undefined
    && explicitMaxTokens !== ''
    ? Number(explicitMaxTokens)
    : maxTokens(sport);
  const responseTimeout = isProvidedNumber(timeout)
    ? Number(timeout)
    : (isProvidedNumber(timeoutMs) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS);

  const body = {
    model,
    max_tokens: tokenBudget,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    return_citations: true,
    return_images: false,
  };

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    try {
      const { ok, status, json } = await postPerplexity(apiKey, body, {
        timeoutMs: responseTimeout,
        domainAllowlist,
      });

      if (!ok) {
        const errorMessage = json?.error?.message || `HTTP ${status}`;
        lastError = `http_${status}:${errorMessage}`;
        continue;
      }

      const content = json?.choices?.[0]?.message?.content ?? '';
      const citations = Array.isArray(json?.citations)
        ? json.citations
        : (Array.isArray(json?.search_results)
          ? json.search_results.map((item) => ({
            url: item?.url ?? null,
            title: item?.title ?? null,
            snippet: item?.snippet ?? item?.summary ?? null,
          }))
          : []);
      const parsed = parseContent(content);
      const missingFields = parsed && typeof parsed === 'object'
        ? Object.entries(parsed).filter(([, value]) => value === null || value === undefined).map(([key]) => key)
        : [];
      const cost = json?.usage?.cost?.total_cost ?? json?.usage?.total_cost ?? null;

      return {
        ok: true,
        status: 'ok',
        content,
        citations,
        cost,
        error: null,
        _meta: {
          provider: 'perplexity',
          model,
          sport,
          status: 'ok',
          reason: null,
          fetched_utc: new Date().toISOString(),
          cost_usd: cost,
          citations,
          parse_status: parsed ? 'ok' : 'parse_error',
          missing_fields: missingFields,
          raw_content: parsed ? undefined : content,
        },
        research: parsed,
      };
    } catch (err) {
      if (err?.name === 'AbortError') {
        return buildSafeFallback(sport, `timeout:${responseTimeout}`);
      }
      lastError = err?.message || String(err);
    }
  }

  return buildSafeFallback(sport, `api_failure:${lastError || 'unknown'}`);
}

module.exports = {
  readPerplexityKey,
  hasPerplexityKey,
  maxTokens,
  formatCitationBlock,
  auditPrompt,
  buildSafeFallback,
  buildMlbUserPrompt,
  buildWcUserPrompt,
  callPerplexity,
  BANNED_PROMPT_TERMS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TEMPERATURE,
  SPORT_TOKEN_BUDGETS,
};
