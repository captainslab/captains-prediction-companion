const DEFAULT_BASE_URL = process.env.KALSHI_API_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeMetadata(input, extraMetadata) {
  return {
    ...(isObject(input.metadata) ? input.metadata : {}),
    ...extraMetadata,
  };
}

function normalizeString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeTicker(value) {
  const cleaned = normalizeString(value);
  return cleaned ? cleaned.toUpperCase() : null;
}

function extractPhraseCandidate(...values) {
  const cleanCandidate = candidate => {
    const text = normalizeComparableText(candidate);
    if (!text) return null;
    if (/^(during|at|on|in|as|for|to)\b/.test(text)) return null;
    return normalizeString(candidate) || null;
  };

  for (const value of values) {
    const text = normalizeString(value);
    if (!text) continue;
    const quoted = text.match(/"([^"]+)"/) ?? text.match(/'([^']+)'/);
    if (quoted?.[1]) return cleanCandidate(quoted[1]);
    const sayMatch = text.match(/\bsay\s+([A-Za-z0-9 .&/-]+?)(?:\?|$)/i);
    if (sayMatch?.[1]) {
      const cleaned = cleanCandidate(sayMatch[1]);
      if (cleaned) return cleaned;
    }
    const mentionMatch = text.match(/\bmention(?:ing|ed)?\s+([A-Za-z0-9 .&/-]+?)(?:\?|$)/i);
    if (mentionMatch?.[1]) {
      const cleaned = cleanCandidate(mentionMatch[1]);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function normalizeComparableText(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parsePrice(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function midpoint(a, b) {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return Number(((a + b) / 2).toFixed(4));
}

function summarizeRules(primary, secondary) {
  const combined = [normalizeString(primary), normalizeString(secondary)].filter(Boolean).join(' ');
  if (!combined) return null;
  return combined.length <= 220 ? combined : `${combined.slice(0, 217)}...`;
}

function buildPriceSnapshot(market = {}) {
  const yesBid = parsePrice(market.yes_bid_dollars);
  const yesAsk = parsePrice(market.yes_ask_dollars);
  const noBid = parsePrice(market.no_bid_dollars);
  const noAsk = parsePrice(market.no_ask_dollars);
  const lastPrice = parsePrice(market.last_price_dollars);
  const spread = yesBid != null && yesAsk != null ? yesAsk - yesBid : null;
  const syntheticMidpoint =
    spread != null && spread <= 0.4 ? midpoint(yesBid, yesAsk) : null;
  return {
    yes_bid: yesBid,
    yes_ask: yesAsk,
    no_bid: noBid,
    no_ask: noAsk,
    last_price: lastPrice,
    market_yes: syntheticMidpoint ?? lastPrice ?? midpoint(yesBid, yesAsk),
  };
}

function looksLikeKalshiHost(hostname) {
  return hostname === 'kalshi.com' || hostname.endsWith('.kalshi.com');
}

function parseKalshiUrl(url) {
  const raw = normalizeString(url);
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!looksLikeKalshiHost(parsed.hostname.toLowerCase())) return null;
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map(segment => decodeURIComponent(segment));
    const tail = segments.length > 0 ? normalizeTicker(segments[segments.length - 1]) : null;
    return {
      url: raw,
      hostname: parsed.hostname.toLowerCase(),
      segments,
      tail,
    };
  } catch {
    return null;
  }
}

function buildBoardPreview(markets = []) {
  return markets
    .map(market => {
      const prices = buildPriceSnapshot(market);
      const phrase = normalizeString(market?.custom_strike?.Word) || normalizeString(market?.yes_sub_title) || null;
      return {
        market_ticker: normalizeTicker(market.ticker),
        label: phrase,
        market_yes: prices.market_yes,
        yes_bid: prices.yes_bid,
        yes_ask: prices.yes_ask,
        last_price: prices.last_price,
        market_status: normalizeString(market.status) || null,
      };
    })
    .sort((left, right) => {
      const rightYes = right.market_yes ?? -1;
      const leftYes = left.market_yes ?? -1;
      return rightYes - leftYes;
    });
}

function selectMatchingMarket(markets, input) {
  const explicitTicker =
    normalizeTicker(input.market_ticker) ??
    normalizeTicker(isObject(input.metadata) ? input.metadata.market_ticker : null) ??
    normalizeTicker(input.market_id);
  if (explicitTicker && explicitTicker.includes('-') && !/\d{2}[A-Z]{3}\d{2}$/.test(explicitTicker)) {
    const exact = markets.find(market => normalizeTicker(market.ticker) === explicitTicker);
    if (exact) return exact;
  }

  const targetPhrase = extractPhraseCandidate(
    isObject(input.metadata) ? input.metadata.target_phrase : null,
    input.question,
    input.title,
    input.notes
  );
  if (targetPhrase) {
    const comparablePhrase = normalizeComparableText(targetPhrase);
    const match = markets.find(market => {
      const candidates = [
        normalizeComparableText(market?.custom_strike?.Word),
        normalizeComparableText(market?.yes_sub_title),
      ].filter(Boolean);
      return candidates.includes(comparablePhrase);
    });
    if (match) return match;
  }

  if (markets.length === 1) return markets[0];
  return null;
}

function parseMentionEventDetails(event = {}) {
  const title = normalizeString(event.title);
  const subtitle = normalizeString(event.sub_title);

  const sayMatch = title.match(/^What will\s+(.+?)\s+say during\s+(.+?)\?$/i);
  if (sayMatch) {
    let speaker = sayMatch[1].trim();
    let eventName = subtitle || sayMatch[2].trim();
    const subtitleParts = subtitle.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
    if (subtitleParts.length >= 2) {
      const [subtitleSpeaker, ...rest] = subtitleParts;
      if (subtitleSpeaker.toLowerCase().includes(speaker.toLowerCase())) {
        speaker = subtitleSpeaker;
        eventName = rest.join(' - ').trim() || eventName;
      }
    } else if (subtitle.toLowerCase().startsWith(`${speaker.toLowerCase()} - `)) {
      eventName = subtitle.slice(speaker.length + 3).trim();
    }
    return {
      speaker,
      event_name: eventName,
    };
  }

  return {
    speaker: null,
    event_name: subtitle || title || null,
  };
}

async function fetchKalshiJson(path, fetchImpl) {
  if (typeof fetchImpl !== 'function') return null;

  let response;
  try {
    response = await fetchImpl(`${DEFAULT_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch {
    return null;
  }

  if (!response?.ok) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchKalshiMarket(ticker, fetchImpl) {
  const normalized = normalizeTicker(ticker);
  if (!normalized) return null;
  const payload = await fetchKalshiJson(`/markets/${normalized}`, fetchImpl);
  return isObject(payload?.market) ? payload.market : null;
}

async function fetchKalshiEvent(ticker, fetchImpl) {
  const normalized = normalizeTicker(ticker);
  if (!normalized) return null;
  const payload = await fetchKalshiJson(`/events/${normalized}`, fetchImpl);
  if (!isObject(payload?.event)) return null;
  return {
    event: payload.event,
    markets: Array.isArray(payload.markets) ? payload.markets : [],
  };
}

async function fetchKalshiOrderbook(ticker, fetchImpl) {
  const normalized = normalizeTicker(ticker);
  if (!normalized) return null;
  const payload = await fetchKalshiJson(`/markets/${normalized}/orderbook`, fetchImpl);
  return isObject(payload?.orderbook_fp) ? payload.orderbook_fp : null;
}

export async function enrichEventMarketInput(input = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const urlContext = parseKalshiUrl(input.url);
  const explicitMarketTicker = normalizeTicker(input.market_ticker) ?? normalizeTicker(isObject(input.metadata) ? input.metadata.market_ticker : null);
  const providedMarketId = normalizeTicker(input.market_id);

  if (!urlContext && !explicitMarketTicker && !providedMarketId) {
    return input;
  }

  const candidateTicker = explicitMarketTicker ?? providedMarketId ?? urlContext?.tail;
  let market = null;
  let eventBundle = null;

  if (explicitMarketTicker) {
    market = await fetchKalshiMarket(explicitMarketTicker, fetchImpl);
  } else if (providedMarketId && !/\d{2}[A-Z]{3}\d{2}$/.test(providedMarketId)) {
    market = await fetchKalshiMarket(providedMarketId, fetchImpl);
  }

  if (market?.event_ticker) {
    eventBundle = await fetchKalshiEvent(market.event_ticker, fetchImpl);
  }

  if (!eventBundle && candidateTicker) {
    eventBundle = await fetchKalshiEvent(candidateTicker, fetchImpl);
  }

  if (!market && eventBundle) {
    market = selectMatchingMarket(eventBundle.markets, input);
  }

  let orderbook = null;
  if (market?.ticker) {
    orderbook = await fetchKalshiOrderbook(market.ticker, fetchImpl);
  }

  const event = eventBundle?.event ?? null;
  const eventDetails = event ? parseMentionEventDetails(event) : { speaker: null, event_name: null };
  const prices = market ? buildPriceSnapshot(market) : null;
  const boardPreview = eventBundle ? buildBoardPreview(eventBundle.markets).slice(0, 5) : [];

  const extraMetadata = {
    kalshi_event_ticker: normalizeTicker(event?.event_ticker) ?? normalizeTicker(market?.event_ticker) ?? urlContext?.tail ?? null,
    kalshi_series_ticker: normalizeTicker(event?.series_ticker) ?? null,
    kalshi_category: normalizeString(event?.category) || null,
    event_name: eventDetails.event_name,
    speaker: eventDetails.speaker,
    market_ticker: normalizeTicker(market?.ticker) ?? explicitMarketTicker ?? null,
    target_phrase:
      normalizeString(market?.custom_strike?.Word) ||
      normalizeString(market?.yes_sub_title) ||
      normalizeString(isObject(input.metadata) ? input.metadata.target_phrase : null) ||
      null,
    rules_summary:
      summarizeRules(market?.rules_primary, market?.rules_secondary) ||
      normalizeString(isObject(input.metadata) ? input.metadata.rules_summary : null) ||
      null,
    market_status: normalizeString(market?.status) || null,
    resolved_outcome: normalizeString(market?.result) || normalizeString(market?.expiration_value) || null,
    market_yes: prices?.market_yes ?? null,
    market_yes_bid: prices?.yes_bid ?? null,
    market_yes_ask: prices?.yes_ask ?? null,
    market_last_price: prices?.last_price ?? null,
    orderbook,
    available_contracts: boardPreview,
    board_contract_count: eventBundle?.markets?.length ?? 0,
  };

  return {
    ...input,
    domain: input.domain ?? (normalizeComparableText(event?.category) === 'mentions' ? 'mention' : input.domain),
    title: input.title ?? event?.title ?? market?.title ?? null,
    question: input.question ?? event?.title ?? market?.title ?? null,
    market_type: input.market_type ?? 'event market',
    market_subtype: input.market_subtype ?? (normalizeComparableText(event?.category) === 'mentions' ? 'mention' : input.market_subtype ?? null),
    market_id: input.market_id ?? normalizeTicker(market?.ticker) ?? extraMetadata.kalshi_event_ticker,
    metadata: mergeMetadata(input, extraMetadata),
  };
}
