// World Cup market context adapter.
// Normalizes Kalshi (or other market) data as REFERENCE ONLY.
//
// HARD RULE: market data is NEVER a composite input.
// This adapter attaches market context AFTER the model score is complete.
//
// Fields:
//   - ticker, title, yes_bid, yes_ask, last, volume, open_interest
//   - implied_probability (computed from bid/ask or last)
//   - edge_vs_model (computed AFTER model probability exists)
//
// If market data is missing, all fields are null — never fabricated.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseMarketContract } from '../lib/market-parser.mjs';

function nowIso() { return new Date().toISOString(); }

function toProbability(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1.5) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

export function impliedProbability(market = {}) {
  const yesBid = toProbability(market.yes_bid ?? market.yesBid);
  const yesAsk = toProbability(market.yes_ask ?? market.yesAsk);
  const last = toProbability(market.last_price ?? market.lastPrice);
  if (yesBid !== null && yesAsk !== null) return (yesBid + yesAsk) / 2;
  if (last !== null) return last;
  if (yesAsk !== null) return yesAsk;
  if (yesBid !== null) return yesBid;
  return null;
}

export function computeEdge(modelProbability, marketImplied) {
  if (modelProbability === null || marketImplied === null) return null;
  return Math.round((modelProbability - marketImplied) * 1000) / 10; // percentage points, 1 decimal
}

export function normalizeMarketContext(raw, { homeTeam = null, awayTeam = null } = {}) {
  if (!raw || !raw.ticker) return null;
  const imp = impliedProbability(raw);
  // Contract TEXT parsing only — prices never reach the parser.
  const parsed = parseMarketContract({
    ticker: raw.ticker,
    title: raw.title ?? '',
    rules: raw.rules ?? raw.rules_primary ?? '',
    homeTeam,
    awayTeam,
  });
  return {
    ticker: raw.ticker,
    title: raw.title ?? null,
    market_type: raw.market_type ?? parsed.market_type ?? 'match_winner',
    market_family: parsed.market_family,
    period: parsed.period,
    side: parsed.side,
    line: parsed.line,
    settlement: parsed.settlement,
    normalized_target: parsed.normalized_target,
    parse_confidence: parsed.parse_confidence,
    implied_probability: imp,
    source_url: raw.source_url ?? null,
    fetched_at: nowIso(),
  };
}

export async function fetchKalshiWorldCupMarkets() {
  // Kalshi API requires auth; this adapter reads from a cached/market-map file
  // produced by a separate Kalshi discovery step (scripts/packets/lib/kalshi-discovery.mjs).
  return {
    ok: false,
    source_id: 'kalshi',
    fetched_at: nowIso(),
    confidence: 'none',
    error: 'Kalshi World Cup markets must be pre-fetched via kalshi-discovery.mjs and stored in state/worldcup/market/',
    markets: [],
  };
}

export function loadCachedMarketContext(stateRoot, date, matchId) {
  const p = resolve(stateRoot, 'worldcup', date, 'market', `${matchId}.json`);
  if (!existsSync(p)) return { ok: false, error: 'cache miss' };
  try {
    return { ok: true, cached: true, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
