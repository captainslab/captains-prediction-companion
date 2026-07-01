// World Cup advances-market classifier (KXWCADVANCE series).
//
// A match is a knockout "advances" market when the Kalshi KXWCADVANCE series has
// an event for it. Classification is cached once per day to
// state/worldcup/<date>/discovery/advances_markets.json (no live fetch here) so
// FIFA-feed stage gaps (missing stage on some knockout fixtures) do not hide the
// advances read. No price/odds data is read into the model — this only sets the
// settlement semantics + knockout flag.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ADVANCES_SERIES = 'KXWCADVANCE';

export function loadCachedAdvancesMarkets(stateRoot, date) {
  const path = resolve(stateRoot, 'worldcup', date, 'discovery', 'advances_markets.json');
  if (!existsSync(path)) return { ok: false, matches: {}, path };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, series: parsed.series ?? ADVANCES_SERIES, retrieved_at: parsed.retrieved_at ?? null, matches: parsed.matches ?? {}, path };
  } catch (error) {
    return { ok: false, error: error.message, matches: {}, path };
  }
}

// Returns a shallow-cloned match with advances/knockout classification applied
// when the KXWCADVANCE cache lists it. Leaves the match untouched otherwise.
export function applyAdvancesClassification(match, advancesMarkets) {
  const rec = advancesMarkets?.matches?.[String(match?.match_id)];
  if (!rec) return match;
  return {
    ...match,
    stage: match.stage || rec.inferred_stage || 'knockout',
    is_advances: true,
    advances_market: {
      series: rec.series ?? ADVANCES_SERIES,
      event_ticker: rec.event_ticker ?? null,
      market_tickers: rec.market_tickers ?? [],
      settlement_scope: rec.settlement_scope ?? 'team_advances_to_next_round',
      includes_extra_time: rec.includes_extra_time !== false,
      includes_penalties: rec.includes_penalties !== false,
      source: rec.source ?? null,
    },
  };
}
