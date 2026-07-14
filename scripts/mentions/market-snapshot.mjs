// Post-score display-only market snapshot adapter.
// This module must stay out of route resolution, research, history, and scoring.

import { createHash } from 'node:crypto';

const QUOTE_KEYS = new Set([
  'yes_bid', 'yes_ask', 'yes_bid_cents', 'yes_ask_cents',
  'no_bid', 'no_ask', 'last_price', 'last_price_cents', 'last_trade_price',
  'last_trade_price_cents', 'volume', 'volume_fp', 'open_interest',
  'open_interest_fp', 'liquidity', 'spread', 'spread_cents',
  'implied_probability', 'model_market_gap_points', 'market_snapshot',
  'quote_status',
]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function centsFromQuote(quote, centsKey, dollarsKey, plainKey) {
  const cents = numberOrNull(quote?.[centsKey]);
  if (cents !== null) return cents;
  const dollars = numberOrNull(quote?.[dollarsKey]);
  if (dollars !== null) return Math.round(dollars * 100);
  return numberOrNull(quote?.[plainKey]);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stripQuoteFields(value) {
  if (Array.isArray(value)) return value.map(stripQuoteFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !QUOTE_KEYS.has(key))
    .map(([key, child]) => [key, stripQuoteFields(child)]));
}

export function hashModelDecisionRows(rows = []) {
  return createHash('sha256').update(stable(stripQuoteFields(Array.isArray(rows) ? rows : []))).digest('hex');
}

export function validateQuoteSnapshot(quote = {}, { ticker = null, nowUtc = null, maxAgeMs = 300_000 } = {}) {
  if (!quote || typeof quote !== 'object') return { ok: false, reason: 'MIDPOINT_UNAVAILABLE' };
  const actualTicker = String(quote.ticker ?? quote.market_ticker ?? '').trim();
  if (!actualTicker) return { ok: false, reason: 'MIDPOINT_UNAVAILABLE' };
  if (!ticker || actualTicker !== String(ticker).trim()) return { ok: false, reason: 'TICKER_MISMATCH' };
  const bid = centsFromQuote(quote, 'yes_bid_cents', 'yes_bid_dollars', 'yes_bid');
  const ask = centsFromQuote(quote, 'yes_ask_cents', 'yes_ask_dollars', 'yes_ask');
  if (bid === null || ask === null) return { ok: false, reason: 'MIDPOINT_UNAVAILABLE' };
  if (![bid, ask].every((n) => n >= 0 && n <= 100)) return { ok: false, reason: 'INVALID_QUOTE' };
  if (bid > ask) return { ok: false, reason: 'CROSSED_QUOTE' };
  const captured = Date.parse(quote.captured_at_utc ?? quote.market_snapshot_utc ?? quote.updated_at ?? '');
  const now = Date.parse(nowUtc ?? '');
  if (!Number.isFinite(captured) || !Number.isFinite(now)) return { ok: false, reason: 'STALE_QUOTE' };
  if (captured > now || now - captured > maxAgeMs) return { ok: false, reason: 'STALE_QUOTE' };
  return { ok: true, bid, ask, captured_at_utc: new Date(captured).toISOString() };
}

function centralStamp(iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: '2-digit',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}

function unavailable(ticker, status) {
  return {
    ticker, yes_bid_cents: null, yes_ask_cents: null, yes_midpoint_cents: null,
    bid_ask_spread_cents: null, market_snapshot_utc: null, market_snapshot_central: null,
    model_market_gap_points: null, quote_status: status,
  };
}

export function freezeModelDecisionRows(rows = []) {
  const clean = (Array.isArray(rows) ? rows : []).map(stripQuoteFields);
  return Object.freeze(clean.map((row) => Object.freeze(row)));
}

export function attachMarketSnapshots({ modelRows = [], quotes = [], nowUtc = null, maxAgeMs = 300_000 } = {}) {
  const frozen = freezeModelDecisionRows(modelRows);
  const before = hashModelDecisionRows(frozen);
  const quoteMap = new Map((Array.isArray(quotes) ? quotes : [])
    .map((quote) => [String(quote?.ticker ?? quote?.market_ticker ?? ''), quote]));
  const rows = frozen.map((row) => {
    const ticker = String(row?.market_ticker ?? '').trim();
    const valid = validateQuoteSnapshot(quoteMap.get(ticker), { ticker, nowUtc, maxAgeMs });
    if (!valid.ok) return { ...row, market_snapshot: unavailable(ticker, valid.reason) };
    const midpoint = (valid.bid + valid.ask) / 2;
    const score = numberOrNull(row?.cpc_score ?? row?.composite_score ?? row?.cpc_yes_score);
    return {
      ...row,
      market_snapshot: {
        ticker, yes_bid_cents: valid.bid, yes_ask_cents: valid.ask,
        yes_midpoint_cents: midpoint, bid_ask_spread_cents: valid.ask - valid.bid,
        market_snapshot_utc: valid.captured_at_utc,
        market_snapshot_central: centralStamp(valid.captured_at_utc),
        model_market_gap_points: score === null ? null : score - midpoint,
        quote_status: 'VALID',
      },
    };
  });
  const after = hashModelDecisionRows(rows);
  return { rows, model_hash_before: before, model_hash_after: after, hash_unchanged: before === after };
}
