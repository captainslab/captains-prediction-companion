// NASCAR race-winner market normalization.
//
// Kalshi event discovery persists one top-level event object with markets[].
// This boundary keeps that production shape intact while adding stable aliases
// for the identity and wording fields used by the NASCAR packet join. Market
// price/liquidity fields are preserved for audit display only; they are never
// consulted when deciding whether a row is a race-winner market.

import { routeNascarMarket } from './router.mjs';

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

export function normalizeNascarMarket(rawMarket = {}, { eventTicker = null } = {}) {
  if (!rawMarket || typeof rawMarket !== 'object' || Array.isArray(rawMarket)) return null;

  return {
    ...rawMarket,
    ticker: textOrNull(rawMarket.ticker ?? rawMarket.market_ticker),
    event_ticker: textOrNull(rawMarket.event_ticker ?? eventTicker),
    title: textOrNull(rawMarket.title ?? rawMarket.market_title),
    subtitle: textOrNull(rawMarket.subtitle ?? rawMarket.sub_title ?? rawMarket.market_subtitle),
    yes_sub_title: textOrNull(
      rawMarket.yes_sub_title
      ?? rawMarket.yes_subtitle
      ?? rawMarket.driver_name,
    ),
    no_sub_title: textOrNull(rawMarket.no_sub_title ?? rawMarket.no_subtitle),
    expiration_value: textOrNull(rawMarket.expiration_value),
    rules_primary: textOrNull(rawMarket.rules_primary ?? rawMarket.rules_summary),
    rules_secondary: textOrNull(rawMarket.rules_secondary),
    occurrence_datetime: textOrNull(rawMarket.occurrence_datetime),
    expected_expiration_time: textOrNull(rawMarket.expected_expiration_time),
    close_time: textOrNull(rawMarket.close_time),
  };
}

export function isNascarWinLaneMarket(market) {
  if (!market || (!market.yes_sub_title && !market.expiration_value)) return false;
  const title = market.title ?? market.yes_sub_title ?? '';
  const rules = market.rules_primary ?? market.rules_summary ?? '';
  if (!title && !rules) return true;

  const route = routeNascarMarket({
    market_title: title,
    rules_summary: rules,
    driver_name: market.yes_sub_title ?? market.expiration_value ?? null,
  });
  const lane = route?.market_lane ?? null;
  return !lane || lane === 'win';
}

export function normalizeNascarWinMarkets(event = {}) {
  const eventTicker = textOrNull(event?.event_ticker ?? event?.ticker);
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  return markets
    .map((market) => normalizeNascarMarket(market, { eventTicker }))
    .filter(Boolean)
    .filter(isNascarWinLaneMarket);
}
