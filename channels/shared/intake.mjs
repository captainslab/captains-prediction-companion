// Shared fan-channel intake parser.
// Pure/offline: no credentials, no network, no writes.

const KALSHI_HOST_RE = /(^|\.)kalshi\.com$/i;
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const TICKER_RE = /\bK[A-Z0-9]{2,}(?:-[A-Z0-9]+)*\b/i;

const UNSUPPORTED_SHORT_TEXT = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'thanks',
  'thank you',
  'ok',
]);

function cleanText(value = '') {
  return String(value ?? '')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function stripUrlPunctuation(value = '') {
  return String(value).replace(/[),.;!?]+$/g, '');
}

function parseCommand(text) {
  const m = text.match(/^\/([a-z][a-z0-9_]*)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i);
  if (!m) return null;
  return `/${m[1].toLowerCase()}`;
}

export function extractFirstUrl(text = '') {
  const m = cleanText(text).match(URL_RE);
  return m ? stripUrlPunctuation(m[0]) : null;
}

export function parseKalshiUrl(url = '') {
  const raw = stripUrlPunctuation(cleanText(url));
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!KALSHI_HOST_RE.test(parsed.hostname)) return null;
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const tail = segments.length ? segments[segments.length - 1].toUpperCase() : null;
    return {
      url: raw,
      hostname: parsed.hostname.toLowerCase(),
      path: parsed.pathname,
      segments,
      tail,
    };
  } catch {
    return null;
  }
}

export function extractTicker(text = '') {
  const m = cleanText(text).match(TICKER_RE);
  return m ? m[0].toUpperCase() : null;
}

function marketRequestLooksSupported(text = '') {
  const value = cleanText(text).toLowerCase();
  if (!value) return false;
  if (UNSUPPORTED_SHORT_TEXT.has(value)) return false;
  return /\b(kalshi|market|ticker|contract|price|odds|will|yes|no|over|under|spread|winner|win|mention|mentions|say|says|said|phrase|election|president|senate|mlb|baseball|nascar|ufc|earnings)\b/.test(value);
}

export function inferMarketFamily({ text = '', url = null, ticker = null, kalshi = null } = {}) {
  const haystack = [
    text,
    url,
    ticker,
    kalshi?.path,
    kalshi?.segments?.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/kx?mlb|xmlb|baseball|\bmlb\b/.test(haystack)) return 'kalshi_mlb';
  if (/kx?nascar|nascar|motorsport/.test(haystack)) return 'kalshi_nascar';
  if (/kx?ufc|ufc|mma/.test(haystack)) return 'kalshi_ufc';
  if (/mentions?|phrase|\bword\b|\bsay(s|ing|id)?\b|earnings call|transcript|remarks|speech/.test(haystack)) {
    return 'kalshi_mentions';
  }
  if (/election|president|senate|congress|governor|white house|politic/.test(haystack)) {
    return 'kalshi_politics';
  }
  if (url || ticker || kalshi) return 'kalshi_event';
  if (marketRequestLooksSupported(text)) return 'market_request';
  return 'unsupported';
}

export function parseIntakeText(text = '') {
  const rawText = String(text ?? '');
  const normalizedText = cleanText(rawText);
  const command = parseCommand(normalizedText);

  if (!normalizedText) {
    return {
      inputType: 'unsupported',
      rawText,
      normalizedText,
      marketFamily: 'unsupported',
      unsupportedReason: 'empty_message',
    };
  }

  if (command) {
    return {
      inputType: 'command',
      command,
      rawText,
      normalizedText,
      marketFamily: 'command',
    };
  }

  const url = extractFirstUrl(normalizedText);
  const kalshi = url ? parseKalshiUrl(url) : null;
  if (url && !kalshi) {
    return {
      inputType: 'unsupported_url',
      rawText,
      normalizedText,
      url,
      marketFamily: 'unsupported',
      unsupportedReason: 'non_kalshi_url',
    };
  }

  const ticker = kalshi?.tail ?? extractTicker(normalizedText);
  if (kalshi) {
    return {
      inputType: 'kalshi_url',
      rawText,
      normalizedText,
      url: kalshi.url,
      ticker,
      kalshi,
      marketFamily: inferMarketFamily({ text: normalizedText, url: kalshi.url, ticker, kalshi }),
    };
  }

  if (ticker) {
    return {
      inputType: 'ticker',
      rawText,
      normalizedText,
      ticker,
      marketFamily: inferMarketFamily({ text: normalizedText, ticker }),
    };
  }

  if (marketRequestLooksSupported(normalizedText)) {
    return {
      inputType: 'market_request',
      rawText,
      normalizedText,
      intentText: normalizedText,
      marketFamily: inferMarketFamily({ text: normalizedText }),
    };
  }

  return {
    inputType: 'unsupported',
    rawText,
    normalizedText,
    marketFamily: 'unsupported',
    unsupportedReason: 'not_market_intent',
  };
}
