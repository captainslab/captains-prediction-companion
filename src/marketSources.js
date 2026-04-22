const DEFAULT_CALENDAR_URL = 'https://kalshi.com/calendar';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function absoluteKalshiUrl(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `https://kalshi.com${pathOrUrl}`;
  return null;
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

  return unique(urls);
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

export async function fetchKalshiMarkets(options = {}) {
  const calendarUrl = options.calendarUrl || DEFAULT_CALENDAR_URL;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;

  const html = await fetchHtml(calendarUrl);
  const urls = extractMarketUrlsFromHtml(html);

  return urls.slice(0, limit);
}
