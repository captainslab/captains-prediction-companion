const DEFAULT_CALENDAR_URL = 'https://kalshi.com/calendar';
const DEFAULT_API_URL = 'https://api.elections.kalshi.com/trade-api/v2/markets';
const CACHE_TTL_MS = 60_000;

let memoryCache = {
  ts: 0,
  key: '',
  urls: [],
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function absoluteKalshiUrl(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `https://kalshi.com${pathOrUrl}`;
  return null;
}

function normalizeMarketUrl(url) {
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

function extractMarketUrlsFromHtml(html) {
  const urls = [];

  const marketHrefRegex = /href=["'](\/markets\/[^"'?#\s]+(?:\?[^"'#\s]*)?)["']/gi;
  for (const match of html.matchAll(marketHrefRegex)) {
    urls.push(absoluteKalshiUrl(match[1]));
  }

  const absoluteMarketRegex = /https:\/\/kalshi\.com\/markets\/[^"'?#\s<]+(?:\?[^"'#\s<]*)?/gi;
  for (const match of html.matchAll(absoluteMarketRegex)) {
    urls.push(match[0]);
  }

  return unique(urls.map(normalizeMarketUrl));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    },
  });

  if (!res.ok) {
    throw new Error(`Calendar fetch failed: ${res.status} ${res.statusText}`);
  }

  return await res.text();
}

async function fetchMarketsFromApi(apiUrl, limit) {
  const res = await fetch(apiUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept': 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    },
  });

  if (!res.ok) {
    throw new Error(`API fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const markets = Array.isArray(data?.markets) ? data.markets : [];

  return unique(
    markets
      .filter(m => m && String(m.status || '').toLowerCase() === 'open')
      .map(m => {
        if (m.url && /^https?:\/\//.test(m.url)) return normalizeMarketUrl(m.url);
        if (m.ticker) return `https://kalshi.com/markets/${m.ticker}`;
        return null;
      })
      .filter(Boolean)
  ).slice(0, limit);
}

async function fetchMarketsFromCalendar(calendarUrl, limit) {
  const html = await fetchHtml(calendarUrl);
  return extractMarketUrlsFromHtml(html).slice(0, limit);
}

export async function fetchKalshiMarkets(options = {}) {
  const calendarUrl = options.calendarUrl || DEFAULT_CALENDAR_URL;
  const apiUrl = options.apiUrl || DEFAULT_API_URL;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
  const cacheKey = JSON.stringify({ calendarUrl, apiUrl, limit });

  if (memoryCache.key === cacheKey && (Date.now() - memoryCache.ts) < CACHE_TTL_MS) {
    return memoryCache.urls;
  }

  let urls = [];
  try {
    urls = await fetchMarketsFromApi(apiUrl, limit);
  } catch (apiErr) {
    try {
      urls = await fetchMarketsFromCalendar(calendarUrl, limit);
    } catch (calendarErr) {
      throw new Error(`API and calendar fetch both failed. API: ${apiErr.message}; Calendar: ${calendarErr.message}`);
    }
  }

  memoryCache = {
    ts: Date.now(),
    key: cacheKey,
    urls,
  };

  return urls;
}
