// World Cup advances-market discovery — Kalshi KXWCADVANCE series.
//
// Read-only public Kalshi API (no auth, no orders, no trades). Discovers which of
// today's fixtures are knockout "advances" markets (settle on reaching the next
// round, incl. extra time + penalties) and maps them to FIFA match_ids so the
// model can render an advances read even when the FIFA feed leaves `stage` null.
// NO price/odds/volume data is persisted into the model path — only the
// classification + ticker identifiers.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { teamKey } from '../lib/elo-baseline.mjs';

export const ADVANCES_SERIES = 'KXWCADVANCE';
export const KALSHI_EVENTS_URL =
  'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXWCADVANCE&status=open&with_nested_markets=true&limit=200';

// Kalshi event tickers embed the date as e.g. KXWCADVANCE-26JUN30CIVNOR.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export function dateToTickerToken(date) {
  const [y, m, d] = String(date).split('-');
  if (!y || !m || !d) return null;
  return `${y.slice(2)}${MONTHS[Number(m) - 1]}${d}`;
}

export function mapEventsToMatches(events, structureMatches, { dateToken = null, retrievedAt = null } = {}) {
  const out = {};
  for (const ev of events) {
    if (dateToken && !String(ev.event_ticker || '').includes(dateToken)) continue;
    const parts = String(ev.title || '').split(/\s+vs\.?\s+/i);
    if (parts.length !== 2) continue;
    const [evH, evA] = parts.map(teamKey);
    const match = structureMatches.find((sm) => {
      const h = teamKey(sm.home_team);
      const a = teamKey(sm.away_team);
      return (h === evH && a === evA) || (h === evA && a === evH);
    });
    if (!match) continue;
    out[String(match.match_id)] = {
      match_id: String(match.match_id),
      home_team: match.home_team,
      away_team: match.away_team,
      market_type: 'worldcup_advances',
      settlement_scope: 'team_advances_to_next_round',
      includes_extra_time: true,
      includes_penalties: true,
      regulation_only: false,
      is_knockout: true,
      inferred_stage: match.stage || 'round_of_32',
      series: ADVANCES_SERIES,
      event_ticker: ev.event_ticker,
      market_tickers: (ev.markets || []).map((mk) => mk.ticker),
      source: 'Kalshi public series KXWCADVANCE',
      source_url: KALSHI_EVENTS_URL,
      retrieved_at: retrievedAt,
    };
  }
  return out;
}

export async function fetchAdvancesMarkets({ date, structureMatches = [], retrievedAt = null, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(KALSHI_EVENTS_URL);
  } catch (error) {
    return { ok: false, error: `fetch failed: ${error.message}` };
  }
  if (!res.ok) return { ok: false, error: `KXWCADVANCE HTTP ${res.status}` };
  const body = await res.json();
  const events = Array.isArray(body?.events) ? body.events : [];
  const matches = mapEventsToMatches(events, structureMatches, { dateToken: dateToTickerToken(date), retrievedAt });
  return { ok: true, series: ADVANCES_SERIES, retrieved_at: retrievedAt, matches };
}

export async function writeAdvancesMarkets(stateRoot, date, structureMatches, { retrievedAt = null } = {}) {
  const result = await fetchAdvancesMarkets({ date, structureMatches, retrievedAt });
  if (!result.ok) return result;
  const path = resolve(stateRoot, 'worldcup', date, 'discovery', 'advances_markets.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ date, series: ADVANCES_SERIES, retrieved_at: retrievedAt, matches: result.matches }, null, 2));
  return { ok: true, path, count: Object.keys(result.matches).length };
}
