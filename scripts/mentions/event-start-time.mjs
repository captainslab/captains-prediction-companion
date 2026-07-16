import FirecrawlApp from '@mendable/firecrawl-js';
import { buildEventScheduleContract } from '../shared/event-schedule-contract.mjs';

const EVENT_TICKER_RE = /^KX[A-Z0-9]+(?:-[A-Z0-9]+)+$/i;
const CENTRAL_ZONE = 'America/Chicago';
const EVENT_PAGE = (ticker) => `https://kalshi.com/events/${encodeURIComponent(ticker)}`;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})\b/;
const TIMING_FIELD_RE = /(?:event[_-]?start|start[_-]?(?:time|date)|scheduled[_-]?(?:start[_-]?)?time|occurrence[_-]?datetime|event[_-]?time)[^\n]{0,80}?[:=]\s*\\?["']([^"']+)\\?["']/gi;
const DISPLAY_TIME_RE = /(?:(today|tomorrow|(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?)[^\n]{0,20}?(?:@|at)\s*)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(cst|cdt|ct)\b/i;
const BEGINS_TIME_RE = /\bBegins\b[^\n·]*·\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(est|edt|cst|cdt|mst|mdt|pst|pdt|et|ct|mt|pt)\b/i;

function scrapedPayload(result) {
  const data = result?.data ?? result;
  return [data?.markdown, data?.html, data?.rawHtml, data?.raw_html]
    .filter((value) => typeof value === 'string')
    .join('\n');
}

function tickerDate(eventTicker) {
  const match = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})(?:$|-)/i);
  if (!match) return null;
  const month = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  }[match[2].toUpperCase()];
  if (!month) return null;
  return `${2000 + Number(match[1])}-${String(month).padStart(2, '0')}-${match[3]}`;
}

function isoToCentral(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${values.timeZoneName}`;
}

function parseClockToIso(dateYmd, hour24, minute, zone) {
  const candidate = `${dateYmd} ${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${String(zone).toUpperCase()}`;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function displayTimeToCentral(eventTicker, match) {
  const date = tickerDate(eventTicker);
  if (!date) return { value: null, startTimeUtc: null };
  let hour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  const period = match[4].toLowerCase();
  if (period === 'am' && hour === 12) hour = 0;
  if (period === 'pm' && hour !== 12) hour += 12;
  const zone = match[5].toUpperCase();
  return {
    value: `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${zone}`,
    startTimeUtc: parseClockToIso(date, hour, minute, zone),
  };
}

function calendarTimeToCentral(eventTicker, match) {
  const date = tickerDate(eventTicker);
  if (!date) return { value: null, startTimeUtc: null };
  const year = date.slice(0, 4);
  const parsed = new Date(`${match[1]} ${match[2]}, ${year} ${match[3]}:${match[4] ?? '00'} ${match[5].toUpperCase()} ${match[6].toUpperCase()}`);
  if (!Number.isFinite(parsed.getTime())) return { value: null, startTimeUtc: null };
  return { value: isoToCentral(parsed.toISOString()), startTimeUtc: parsed.toISOString() };
}

function milestoneStartDate(content, eventTicker) {
  const normalized = content.replace(/\\"/g, '"');
  const escapedTicker = eventTicker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tickerRe = new RegExp(
    `"(?:related_event_tickers|primary_event_tickers)"\\s*:\\s*\\[[^\\]]*"${escapedTicker}"[^\\]]*\\]`,
    'i',
  );
  const startRe = /"start_date"\s*:\s*"([^"\\]+)"/i;
  for (const record of normalized.split(/(?=\{"id"\s*:)/)) {
    if (!tickerRe.test(record)) continue;
    const start = record.match(startRe)?.[1];
    if (start && ISO_RE.test(start)) return start;
  }
  return null;
}

function findEventTime(eventTicker, content) {
  const milestoneStart = milestoneStartDate(content, eventTicker);
  if (milestoneStart) {
    return {
      value: isoToCentral(milestoneStart),
      startTimeUtc: milestoneStart,
      format: 'central',
      field: milestoneStart,
    };
  }
  for (const match of content.matchAll(TIMING_FIELD_RE)) {
    const value = match[1].trim().replace(/\\\\+$/, '');
    const iso = value.match(ISO_RE)?.[0];
    if (iso) return { value: isoToCentral(iso), startTimeUtc: iso, format: 'central', field: value };
  }
  const begins = content.match(BEGINS_TIME_RE);
  if (begins) {
    const { value, startTimeUtc } = calendarTimeToCentral(eventTicker, begins);
    if (value) return { value, startTimeUtc, format: 'central', field: begins[0] };
  }
  const display = content.match(DISPLAY_TIME_RE);
  if (display) {
    const { value, startTimeUtc } = displayTimeToCentral(eventTicker, display);
    if (value) return { value, startTimeUtc, format: 'central', field: display[0] };
  }
  return null;
}

async function scrape(app, url) {
  if (typeof app.scrape === 'function') {
    return app.scrape(url, { formats: ['markdown', 'html', 'rawHtml'], waitFor: 3000 });
  }
  return app.scrapeUrl(url, { formats: ['markdown', 'html', 'rawHtml'], waitFor: 3000 });
}

/**
 * Fetch the event start time shown by Kalshi's rendered event page.
 * Returns null when Firecrawl cannot retrieve a usable time.
 */
export async function getEventStartTime(eventTicker, { firecrawl = null } = {}) {
  if (!EVENT_TICKER_RE.test(String(eventTicker ?? ''))) return null;
  const ticker = String(eventTicker).toUpperCase();
  const sourceUrl = EVENT_PAGE(ticker);
  const app = firecrawl ?? new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const result = await scrape(app, sourceUrl);
  const found = findEventTime(ticker, scrapedPayload(result));
  if (!found) return null;
  return buildEventScheduleContract({
    eventFamily: 'mentions',
    eventTicker: ticker,
    eventKey: ticker,
    eventStartUtc: found.startTimeUtc,
    authority: 'firecrawl_kalshi_web',
    sourceUrl,
    retrievedAtUtc: new Date().toISOString(),
    status: 'fresh',
    idempotencyKey: `mentions:${ticker}:${found.startTimeUtc}`,
    rawStartField: found.field,
    sourceStatus: 'fresh',
    metadata: {
      value: found.value,
      startTimeUtc: found.startTimeUtc,
      format: found.format,
      field: found.field,
      sourceUrl,
    },
  });
}

export const _test = Object.freeze({
  calendarTimeToCentral,
  displayTimeToCentral,
  findEventTime,
  milestoneStartDate,
  scrapedPayload,
  tickerDate,
});
