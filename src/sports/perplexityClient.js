/**
 * perplexityClient.js
 * Shared Perplexity API client for all CPC sports research pipelines.
 *
 * Contract:
 *  - JSON-only prompt output; unknown/unavailable values returned as null.
 *  - PERPLEXITY_API_KEY absent or API fail => safe fallback (never throws).
 *  - Key fallback order: PERPLEXITY_API_KEY env → PPLX_API_KEY env →
 *    ~/.config/cpc/perplexity.key file (same order as run-perplexity-research.mjs).
 *  - No market price data in any research prompt.
 *  - No betting/wagering language generated or accepted.
 *  - auditPrompt() strips a policyBlock before scanning so positive-framing
 *    public-safe instructions in prompts do not self-block the audit.
 *  - Structured return shape: { ok, status, content, citations, cost, error }
 */

'use strict';

const https = require('https');
const { existsSync, readFileSync } = require('fs');
const { homedir } = require('os');
const { resolve } = require('path');
const { SPORT_TOKEN_BUDGETS } = require('./sportTokenBudgets');

// ─── Constants ────────────────────────────────────────────────────────────────

const PERPLEXITY_API_URL = 'api.perplexity.ai';
const PERPLEXITY_API_PATH = '/chat/completions';
const DEFAULT_MODEL = 'sonar';
const DEFAULT_TIMEOUT_MS = 55000;
const DEFAULT_TEMPERATURE = 0.1;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1200;
const KEY_FILE_PATH = resolve(homedir(), '.config', 'cpc', 'perplexity.key');

/**
 * Terms that must never appear in the dynamic event/context payload of any
 * research prompt. Static policy instructions (policyBlock) are stripped
 * before this scan runs — see auditPrompt().
 */
const BANNED_PROMPT_TERMS = [
  'bet', 'betting', 'wager', 'sportsbook', 'odds', 'moneyline', 'prop',
  'pick', 'lean', 'lock', 'fade', 'edge', 'trade', 'buy', 'sell',
  'bankroll', 'stake', 'unit', 'market price', 'bid', 'ask',
  'open interest', 'volume', 'liquidity', 'NOT IN SCORE', 'display-only',
];

// ─── Key helpers ──────────────────────────────────────────────────────────────

/**
 * Read the Perplexity API key from env or ~/.config/cpc/perplexity.key.
 * Returns the key string or null. Never logs the key value.
 * Mirrors the key-load order in scripts/mlb/run-perplexity-research.mjs.
 *
 * @param {object} [env] — defaults to process.env
 * @returns {string|null}
 */
function readPerplexityKey(env = process.env) {
  const fromEnv = (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY || '').replace(/\s+/g, '');
  if (fromEnv) return fromEnv;
  if (existsSync(KEY_FILE_PATH)) {
    const k = readFileSync(KEY_FILE_PATH, 'utf8').replace(/\s+/g, '');
    if (k) return k;
  }
  return null;
}

/**
 * Returns true if a Perplexity key is available in any supported location.
 * @param {object} [env]
 * @returns {boolean}
 */
function hasPerplexityKey(env = process.env) {
  return readPerplexityKey(env) !== null;
}

/**
 * Returns the max_tokens budget for the given sport from SPORT_TOKEN_BUDGETS.
 * @param {string} sport
 * @returns {number}
 */
function maxTokens(sport) {
  return (SPORT_TOKEN_BUDGETS[sport] || SPORT_TOKEN_BUDGETS.default).max_tokens;
}

/**
 * Format a citations array into a compact readable block for audit artifacts.
 * @param {string[]} citations
 * @returns {string}
 */
function formatCitationBlock(citations = []) {
  if (!Array.isArray(citations) || citations.length === 0) return '(no citations)';
  return citations.map((c, i) => `[${i + 1}] ${typeof c === 'string' ? c : (c.url || c.title || JSON.stringify(c))}`).join('\n');
}

// ─── Prompt audit ─────────────────────────────────────────────────────────────

/**
 * Scans a prompt string for banned terms.
 *
 * The optional `policyBlock` argument is a verbatim substring of the prompt
 * that contains the static public-safe policy instructions (e.g. "Respond only
 * with factual, public-safe language. Do not include any personal statistics
 * or commercial references."). This substring is stripped from the prompt
 * before scanning so that legitimate positive-framing instructions do not
 * accidentally match a banned term and self-block the audit.
 *
 * Only the dynamic event/context payload — what varies per game — is scanned.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.policyBlock] — static policy text to exclude from scan
 * @returns {{ safe: boolean, violations: string[] }}
 */
function auditPrompt(prompt, opts = {}) {
  const { policyBlock = '' } = opts;
  const scanTarget = policyBlock
    ? prompt.replace(policyBlock, '')
    : prompt;
  const lower = scanTarget.toLowerCase();
  const violations = BANNED_PROMPT_TERMS.filter(t => lower.includes(t.toLowerCase()));
  return { safe: violations.length === 0, violations };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function postPerplexity(apiKey, body, { timeoutMs = DEFAULT_TIMEOUT_MS, domainAllowlist = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: PERPLEXITY_API_URL,
      path: PERPLEXITY_API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    // Domain allowlist: attach as search_domain_filter if supported
    if (domainAllowlist && Array.isArray(domainAllowlist) && domainAllowlist.length > 0) {
      body = { ...body, search_domain_filter: domainAllowlist };
    }

    const timer = setTimeout(() => reject(new Error(`Perplexity timeout after ${timeoutMs}ms`)), timeoutMs);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve({ status: res.status || res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.status || res.statusCode, body: { raw: data } });
        }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.write(payload);
    req.end();
  });
}

// ─── Safe fallback ────────────────────────────────────────────────────────────

/**
 * Structured safe fallback when Perplexity is unavailable.
 * All research fields are null. Callers treat this as a blocked result.
 * Conforms to the { ok, status, content, citations, cost, error } contract.
 *
 * @param {string} sport
 * @param {string} reason
 * @returns {object}
 */
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

// ─── Core client ──────────────────────────────────────────────────────────────

/**
 * Main Perplexity research call.
 *
 * Returns { ok, status, content, citations, cost, error, _meta, research }.
 *
 * @param {object} opts
 * @param {string}   opts.sport            e.g. 'mlb', 'worldcup', 'ufc', 'nascar'
 * @param {string}   opts.systemPrompt     Must request JSON-only output; null for unknowns
 * @param {string}   opts.userPrompt       Event-specific research query
 * @param {string}   [opts.policyBlock]    Verbatim static policy substring stripped before audit
 * @param {string}   [opts.model]          Override model
 * @param {number}   [opts.temperature]    Default 0.1
 * @param {number}   [opts.timeoutMs]      Default 55000
 * @param {string[]} [opts.domainAllowlist] Optional search domain filter
 * @param {boolean}  [opts.dryRun]         If true, skips API call
 * @param {object}   [opts.env]            Env to read key from
 * @returns {Promise<object>}
 */
async function callPerplexity(opts = {}) {
  const {
    sport = 'unknown',
    systemPrompt = '',
    userPrompt = '',
    policyBlock = '',
    model = DEFAULT_MODEL,
    temperature = DEFAULT_TEMPERATURE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    domainAllowlist = null,
    dryRun = false,
    env = process.env,
  } = opts;

  // ── Prompt audit — scan only dynamic payload, not the static policy block ──
  const sysAudit = auditPrompt(systemPrompt, { policyBlock });
  const userAudit = auditPrompt(userPrompt, { policyBlock });
  if (!sysAudit.safe || !userAudit.safe) {
    const violations = [...new Set([...sysAudit.violations, ...userAudit.violations])];
    console.error('[perplexityClient] BLOCKED — prompt contains banned terms:', violations);
    return buildSafeFallback(sport, `prompt_audit_fail:${violations.join(',')}`);
  }

  // ── No-key safe path ──
  const apiKey = readPerplexityKey(env);
  if (!apiKey || dryRun) {
    const reason = dryRun ? 'dry_run' : 'no_api_key';
    console.warn(`[perplexityClient] Safe fallback — ${reason} for sport=${sport}`);
    return buildSafeFallback(sport, reason);
  }

  // ── Token budget ──
  const budget = SPORT_TOKEN_BUDGETS[sport] || SPORT_TOKEN_BUDGETS.default;
  const body = {
    model,
    max_tokens: budget.max_tokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    return_citations: true,
    return_images: false,
    search_recency_filter: budget.recency_filter || 'day',
  };

  // ── Retry loop ──
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    try {
      const { status, body: respBody } = await postPerplexity(apiKey, body, { timeoutMs, domainAllowlist });

      if (status !== 200) {
        lastError = `http_${status}`;
        console.warn(`[perplexityClient] Attempt ${attempt + 1} failed — HTTP ${status}`);
        continue;
      }

      const content = respBody?.choices?.[0]?.message?.content || '';
      const citations = respBody?.citations || [];
      const usage = respBody?.usage || {};
      const cost = usage.total_tokens ? Number((usage.total_tokens * 0.000001).toFixed(6)) : null;

      let parsed = null;
      let parseStatus = 'ok';
      const missingFields = [];

      try {
        const cleaned = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parseStatus = 'parse_error';
        console.error('[perplexityClient] JSON parse failed — raw content in _meta.raw_content');
      }

      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (v === null || v === undefined) missingFields.push(k);
        }
      }

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
          parse_status: parseStatus,
          missing_fields: missingFields,
          raw_content: parseStatus === 'parse_error' ? content : undefined,
        },
        research: parsed,
      };
    } catch (err) {
      lastError = err.message;
      console.error(`[perplexityClient] Attempt ${attempt + 1} threw:`, err.message);
    }
  }

  return buildSafeFallback(sport, `api_failure:${lastError}`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  callPerplexity,
  auditPrompt,
  buildSafeFallback,
  readPerplexityKey,
  hasPerplexityKey,
  maxTokens,
  formatCitationBlock,
  BANNED_PROMPT_TERMS,
};
