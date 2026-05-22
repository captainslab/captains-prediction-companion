// Live Kalshi fetcher for politics-market swarm.
// Pure node:fetch, no SDK. Public elections endpoint only.
//
// Two surface functions:
//   fetchEventMarkets(eventTicker)  -> raw {markets:[...]}
//   buildMarketBranches(eventTicker, opts) -> { market, settlement, marketStructure }
//
// Notes:
// - `_dollars` fields are decimal dollars; we convert to integer cents.
// - `open_interest_fp` / `volume*_fp` are fractional and may be floats.
// - Acting/Interim exclusion is parsed verbatim from rules_secondary.

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function toCents(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export async function fetchEventMarkets(eventTicker, { fetchImpl = fetch } = {}) {
  if (!eventTicker) throw new Error('eventTicker required');
  const url = `${BASE}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kalshi fetch failed ${res.status} ${url} :: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.markets)) {
    throw new Error(`Kalshi fetch returned no markets array: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

export function normalizeMarket(m) {
  return {
    ticker:    m.ticker,
    candidate: m.yes_sub_title || m.title || m.ticker,
    yesBidCents: toCents(m.yes_bid_dollars),
    yesAskCents: toCents(m.yes_ask_dollars),
    noBidCents:  toCents(m.no_bid_dollars),
    noAskCents:  toCents(m.no_ask_dollars),
    lastCents:   toCents(m.last_price_dollars),
    oi:          m.open_interest_fp ?? m.open_interest ?? null,
    vol24h:      m.volume_24h_fp ?? m.volume_24h ?? null,
    status:      m.status,
    close_time:  m.close_time,
  };
}

export function buildMarketBranches(raw, { eventTicker, eventUrl, title } = {}) {
  const ms = (raw.markets || []).map(normalizeMarket);
  // Sort descending by yesBidCents (null last).
  ms.sort((a, b) => (b.yesBidCents ?? -1) - (a.yesBidCents ?? -1));

  const first = raw.markets?.[0] || {};
  const rules_primary = first.rules_primary || '';
  const rules_secondary = first.rules_secondary || '';

  // Acting/interim exclusion: look in secondary rules.
  const actingInterim = /acting/i.test(rules_secondary) && /interim/i.test(rules_secondary)
    ? `excluded — per rules: "${rules_secondary.replace(/\s+/g, ' ').trim()}"`
    : '(not detected in rules text — inspect manually)';

  // Settlement rules text. Each contract has its own rules_primary like
  // "If the first new person to be Attorney General is X before Y, …". We
  // strip the X-specific part to recover the shared market spec.
  const sharedRule = rules_primary
    .replace(/is [A-Z][^,]+ before/, 'is <CANDIDATE> before')
    .trim();

  const board = ms.slice(0, 12).map((x) => ({
    candidate: x.candidate,
    yesCents:  x.yesBidCents,
    noCents:   x.noAskCents ?? (x.yesBidCents != null ? 100 - x.yesBidCents : null),
    vol:       x.vol24h,
    oi:        x.oi,
    ticker:    x.ticker,
  }));

  const totalOi = ms.reduce((s, x) => s + (x.oi || 0), 0);
  const totalVol = ms.reduce((s, x) => s + (x.vol24h || 0), 0);

  const market = {
    id:    eventTicker,
    url:   eventUrl ?? `https://kalshi.com/markets/${eventTicker.toLowerCase()}`,
    title: title ?? (rules_primary ? rules_primary.split(' is ')[0].replace(/^If the first new person to be /, '') : eventTicker),
    asOf:  new Date().toISOString(),
  };

  const settlement = {
    rules: sharedRule || '(rules_primary missing from Kalshi response)',
    rulesSecondary: rules_secondary,
    actingInterim,
    ambiguities: [],
    source: `${BASE}/markets?event_ticker=${eventTicker}`,
  };

  const marketStructure = {
    board,
    totalOpenInterest: totalOi,
    totalVolume24h: totalVol,
    contractCount: ms.length,
    notes: [
      `Top contract: ${board[0]?.candidate ?? '?'} at ${board[0]?.yesCents ?? '?'}¢ YES.`,
      `Total OI across ${ms.length} contracts: ${Math.round(totalOi)}.`,
      'Price alone is not a pick — see Sections 4, 7, 8 for context.',
    ],
    source: `${BASE}/markets?event_ticker=${eventTicker}`,
  };

  return { market, settlement, marketStructure };
}
