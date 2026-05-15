// Read-only Kalshi market liquidity adapter.
// Fixture mode returns placeholder records.
// Live-readonly tries public Kalshi endpoints; marks degraded/blocked if unavailable.
// No credentials. No order placement. No account state.

export const KALSHI_TRADE_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function makeEnvelope({ status, checkedAtUtc, cachePath, records = [], warnings = [], errors = [], sourceUrls = [] }) {
  return {
    source_id: 'liquidity',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `liquidity_${checkedAtUtc}`,
    cache_path: cachePath,
    required: false,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function fixtureRecords({ checkedAtUtc }) {
  return [
    {
      query_type: 'market_liquidity',
      market_ticker: 'KXMLB-ALP-BET-WINNER',
      event_ticker: 'KXMLB-ALP-BET',
      checked_at_utc: checkedAtUtc,
      best_bid: 0.48,
      best_ask: 0.52,
      spread: 0.04,
      volume: null,
      open_interest: null,
      liquidity_status: 'fixture',
      source_urls: [],
      warnings: ['Fixture record only; no live Kalshi liquidity endpoint was called.'],
    },
  ];
}

export function fixtureLiquidityEnvelope({ checkedAtUtc = '2026-05-15T14:00:00.000Z', outputDir }) {
  return makeEnvelope({
    status: 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/liquidity_adapter.json`,
    records: fixtureRecords({ checkedAtUtc }),
    warnings: ['Fixture mode: no live liquidity source was called.'],
    sourceUrls: [KALSHI_TRADE_API_BASE],
  });
}

function normalizeLiquidityRecord({ checkedAtUtc, ticker, marketData }) {
  const yesBid = typeof marketData?.yes_bid === 'number' ? marketData.yes_bid / 100 : null;
  const yesAsk = typeof marketData?.yes_ask === 'number' ? marketData.yes_ask / 100 : null;
  const spread =
    yesBid !== null && yesAsk !== null ? Math.round((yesAsk - yesBid) * 100) / 100 : null;
  return {
    query_type: 'market_liquidity',
    market_ticker: ticker,
    event_ticker: marketData?.event_ticker ?? null,
    checked_at_utc: checkedAtUtc,
    best_bid: yesBid,
    best_ask: yesAsk,
    spread,
    volume: marketData?.volume ?? null,
    open_interest: marketData?.open_interest ?? null,
    liquidity_status: yesBid !== null && yesAsk !== null ? 'live' : 'degraded',
    source_urls: [`${KALSHI_TRADE_API_BASE}/markets/${ticker}`],
    warnings: [],
  };
}

export async function fetchLiquidityReadonly({
  runDate,
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  kalshiTickers = [],
} = {}) {
  const checkedAtUtc = isoNow(now);

  if (fixturesOnly) {
    return fixtureLiquidityEnvelope({ checkedAtUtc, outputDir });
  }

  const warnings = [];
  const errors = [];
  const records = [];
  const sourceUrls = [KALSHI_TRADE_API_BASE];
  const tickers = safeArray(kalshiTickers).filter(Boolean);

  if (tickers.length === 0) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/liquidity_adapter.json`,
      warnings: ['No Kalshi market tickers provided; cannot fetch liquidity.'],
      errors,
      sourceUrls,
    });
  }

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/liquidity_adapter.json`,
      warnings,
      errors: ['No fetch implementation available for live-readonly liquidity request.'],
      sourceUrls,
    });
  }

  for (const ticker of tickers.slice(0, 10)) {
    const marketUrl = `${KALSHI_TRADE_API_BASE}/markets/${ticker}`;
    sourceUrls.push(marketUrl);
    try {
      const response = await fetchImpl(marketUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
        },
      });
      if (response.status === 401 || response.status === 403) {
        warnings.push(
          `Kalshi market endpoint ${marketUrl} returned HTTP ${response.status}; public access not available without credentials.`,
        );
        continue;
      }
      if (!response.ok) {
        warnings.push(`Kalshi market endpoint ${marketUrl} returned HTTP ${response.status}.`);
        continue;
      }
      const payload = await response.json();
      const marketData = payload?.market ?? payload;
      records.push(normalizeLiquidityRecord({ checkedAtUtc, ticker, marketData }));
    } catch (error) {
      warnings.push(
        `Liquidity fetch failed for ${ticker}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (records.length === 0) {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath: `${outputDir}/liquidity_adapter.json`,
      warnings: [...warnings, 'No usable live liquidity records returned.'],
      errors,
      sourceUrls,
    });
  }

  return makeEnvelope({
    status: warnings.length > 0 ? 'degraded' : 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/liquidity_adapter.json`,
    records,
    warnings: [
      ...warnings,
      'Live read-only liquidity records are order book inputs only, not final recommendations.',
    ],
    errors,
    sourceUrls,
  });
}
