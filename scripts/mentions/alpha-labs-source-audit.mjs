#!/usr/bin/env node
// Alpha-labs source-backed audit for a single Kalshi earnings mention event.
//
// Read-only. No auth. No trades. No model calls. No market pricing in scoring,
// source selection, ranking, or coverage — strike phrases and transcript prose
// only. Produces two local artifacts:
//   state/mentions/alpha-labs/<slug>/source-backed-audit.json
//   state/mentions/alpha-labs/<slug>/source-backed-audit.md
//
// Reuses existing CPC discovery/history/ladder mechanisms; it does NOT rebuild
// discovery:
//   * board capture        -> kalshi-discovery (defaultFetcher / normalizeMarket)
//   * settled/closed counts -> ingest-settled-history.fetchSettledMarketsForSeries
//   * evidence ladder       -> source-ladder.evaluateSourceLadder
//   * price-free guard       -> settled-history.assertNoForbiddenFields
// The new piece is deterministic prior-transcript word coverage
// (transcript-word-coverage.mjs), used because no prior Kalshi board exists.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { KALSHI_API_BASE, defaultFetcher, normalizeMarket } from '../packets/lib/kalshi-discovery.mjs';
import { fetchSettledMarketsForSeries } from './ingest-settled-history.mjs';
import { evaluateSourceLadder, renderSourceLadder } from './source-ladder.mjs';
import { assertNoForbiddenFields } from './settled-history.mjs';
import { buildStrikeCoverage, assertNoPriceFields } from './transcript-word-coverage.mjs';

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const SEC_UA = 'cpc-alpha-labs-research scapecj@gmail.com';
const MAX_DOC_BYTES = 600_000;

// Declared free/official sources (no paid APIs, no private auth). Transcripts
// are the rank-1 prior_transcript_word_match source; SEC 8-K releases are the
// official formal_document_proxy fallback context.
const DEFAULT_SOURCES = [
  { label: 'KR Q4 FY2025 call (Mar 5 2026)', quarter: 'FY2025 Q4', source_type: 'transcript', source_url: 'https://www.fool.com/earnings/call-transcripts/2026/05/21/kroger-kr-q4-2026-earnings-call-transcript/' },
  { label: 'KR Q1 FY2025 call (Jun 20 2025)', quarter: 'FY2025 Q1', source_type: 'transcript', source_url: 'https://www.fool.com/earnings/call-transcripts/2025/06/20/kroger-kr-q1-2025-earnings-call-transcript/' },
  { label: 'KR Q4 FY2024 call (Mar 6 2025)', quarter: 'FY2024 Q4', source_type: 'transcript', source_url: 'https://www.fool.com/earnings/call-transcripts/2025/03/06/kroger-kr-q4-2024-earnings-call-transcript/' },
  { label: 'KR Q3 FY2024 call (Dec 5 2024)', quarter: 'FY2024 Q3', source_type: 'transcript', source_url: 'https://www.fool.com/earnings/call-transcripts/2024/12/05/kroger-kr-q3-2024-earnings-call-transcript/' },
  { label: 'KR Q3 FY2025 8-K release (SEC)', quarter: 'FY2025 Q3', source_type: 'official_release', source_url: 'https://www.sec.gov/Archives/edgar/data/0000056873/000110465925118315/tm2532524d1_ex99-1.htm' },
  { label: 'KR Q4 FY2025 8-K release (SEC)', quarter: 'FY2025 Q4', source_type: 'official_release', source_url: 'https://www.sec.gov/Archives/edgar/data/0000056873/000110465926012061/tm265602d1_ex99-1.htm' },
];

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DOC_BYTES);
}

async function fetchDoc(url) {
  const ua = /(^|\.)sec\.gov/i.test(new URL(url).hostname) ? SEC_UA : BROWSER_UA;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' });
    if (!r.ok) return { ok: false, status: r.status, text: '', error: `HTTP ${r.status}` };
    const text = htmlToText(await r.text());
    return { ok: text.length > 200, status: r.status, text, error: text.length > 200 ? null : 'empty/short body' };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err.message };
  }
}

async function captureBoard(seriesTicker, eventTicker) {
  // Series feed (no status filter) — the only feed that returns the live board.
  const res = await defaultFetcher(`${KALSHI_API_BASE}/events?series_ticker=${encodeURIComponent(seriesTicker)}&limit=200&with_nested_markets=true`);
  const events = Array.isArray(res.json?.events) ? res.json.events : [];
  const target = events.find((e) => e.event_ticker === eventTicker) ?? null;
  const markets = Array.isArray(target?.markets) ? target.markets : [];
  // Strike phrases ONLY — never copy price/volume/OI fields out of the market.
  const strikes = markets.map((m) => {
    const n = normalizeMarket(m);
    return { ticker: m.ticker ?? n.ticker, strike: m.yes_sub_title || n.full_strike_display || n.title || 'MISSING' };
  });
  return {
    fetch_ok: res.ok,
    fetch_status: res.status,
    event_found: Boolean(target),
    event_ticker: target?.event_ticker ?? null,
    event_title: target?.title ?? null,
    close_time: target?.close_time ?? markets[0]?.close_time ?? null,
    sibling_events: events.filter((e) => e.series_ticker === seriesTicker).map((e) => ({ event_ticker: e.event_ticker, markets: (e.markets || []).length })),
    strikes,
  };
}

async function captureHistory(seriesTicker) {
  const out = { settled_count: 0, closed_count: 0, errors: [] };
  try {
    const settled = await fetchSettledMarketsForSeries(seriesTicker, { limit: 200 });
    out.settled_count = settled.length;
  } catch (err) { out.errors.push(`settled: ${err.message}`); }
  try {
    const res = await defaultFetcher(`${KALSHI_API_BASE}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=closed&limit=200`);
    out.closed_count = Array.isArray(res.json?.markets) ? res.json.markets.length : 0;
    if (!res.ok) out.errors.push(`closed: HTTP ${res.status}`);
  } catch (err) { out.errors.push(`closed: ${err.message}`); }
  return out;
}

export async function runAudit({
  seriesTicker = 'KXEARNINGSMENTIONKR',
  eventTicker = 'KXEARNINGSMENTIONKR-26JUN18',
  slug = 'kroger-2026-06-18',
  stateRoot = 'state',
  sources = DEFAULT_SOURCES,
} = {}) {
  const outDir = resolve(stateRoot, 'mentions', 'alpha-labs', slug);
  const researchDir = resolve(outDir, 'research');
  mkdirSync(researchDir, { recursive: true });

  const board = await captureBoard(seriesTicker, eventTicker);
  if (!board.event_found || board.strikes.length === 0) {
    throw new Error(`BLOCKED: current board not fetchable for ${eventTicker} (fetch_ok=${board.fetch_ok} status=${board.fetch_status})`);
  }
  const history = await captureHistory(seriesTicker);

  // Fetch declared sources, cache raw text locally, attach text for matching.
  const fetchedSources = [];
  for (const s of sources) {
    const doc = await fetchDoc(s.source_url);
    const safe = s.label.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
    if (doc.ok) {
      writeFileSync(resolve(researchDir, `${safe}.txt`), doc.text, 'utf8');
    }
    fetchedSources.push({ ...s, fetch_status: doc.status, fetch_ok: doc.ok, fetch_error: doc.error, bytes: doc.text.length, text: doc.ok ? doc.text : '' });
  }

  const usableTranscripts = fetchedSources.filter((s) => s.source_type === 'transcript' && s.fetch_ok);
  const usableOfficial = fetchedSources.filter((s) => s.source_type === 'official_release' && s.fetch_ok);

  const coverage = buildStrikeCoverage({ strikes: board.strikes, sources: fetchedSources.filter((s) => s.fetch_ok) });

  // Reuse the source ladder to classify evidence trust for the event.
  const ladder = evaluateSourceLadder({
    profile: 'earnings_mentions',
    inputs: {
      prior_transcript_word_match: {
        status: usableTranscripts.length ? 'used' : 'blocked',
        note: `${usableTranscripts.length} prior Kroger earnings-call transcript(s) word-matched`,
        hits: usableTranscripts.length,
      },
      recent_direct_quote_match: {
        status: usableTranscripts.length ? 'used' : 'missing',
        note: 'most recent transcript is within ~3 months of the event',
      },
      formal_document_proxy: {
        status: usableOfficial.length ? 'used' : 'missing',
        note: `${usableOfficial.length} official SEC 8-K earnings release(s)`,
      },
      qualification_risk: {
        status: 'used',
        note: 'event qualifies only if Kroger holds the earnings call as scheduled',
        detail: { level: 'low' },
      },
    },
  });

  const determination = coverage.summary.source_backed_strikes > 0 ? 'PASS' : 'BLOCKED';

  const artifact = {
    schema: 'alpha_labs_source_backed_audit_v1',
    generated_utc: new Date().toISOString(),
    determination,
    target: {
      series_ticker: seriesTicker,
      event_ticker: eventTicker,
      event_title: board.event_title,
      market_url: `https://kalshi.com/markets/kxearningsmentionkr/kroger/${eventTicker}`,
      close_time: board.close_time,
    },
    board: {
      fetch_ok: board.fetch_ok,
      current_strike_count: board.strikes.length,
      sibling_events: board.sibling_events,
      strikes: board.strikes,
    },
    history: {
      settled_count: history.settled_count,
      closed_count: history.closed_count,
      prior_board_count: history.settled_count + history.closed_count,
      errors: history.errors,
      note: 'No prior settled/closed Kalshi board exists for this series; stored-history coverage is structurally unavailable.',
    },
    sources: fetchedSources.map(({ text, ...rest }) => rest),
    source_ladder: {
      profile: ladder.profile,
      used: ladder.used,
      proxy: ladder.proxy,
      undercounted: ladder.undercounted,
      blocked: ladder.blocked,
      missing: ladder.missing,
      qualification_status: ladder.qualification_status,
      posture_cap: ladder.posture_cap,
      market_context_excluded: true,
    },
    coverage_summary: coverage.summary,
    coverage: coverage.rows,
    isolation_note: 'No market price / bid / ask / volume / open-interest field is read into coverage, source selection, or ranking. Output scanned by assertNoForbiddenFields + assertNoPriceFields.',
  };

  // Defense in depth: nothing price-shaped may appear in the emitted artifact.
  assertNoForbiddenFields(artifact, 'alpha-labs source-backed audit');
  assertNoPriceFields(artifact, 'alpha-labs source-backed audit');

  const jsonPath = resolve(outDir, 'source-backed-audit.json');
  const mdPath = resolve(outDir, 'source-backed-audit.md');
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderMarkdown(artifact, ladder), 'utf8');

  return { artifact, jsonPath, mdPath };
}

function renderMarkdown(a, ladder) {
  const L = [];
  L.push(`# Source-Backed Audit — ${a.target.event_ticker}`);
  L.push('');
  L.push(`- **Determination:** ${a.determination}`);
  L.push(`- **Generated (UTC):** ${a.generated_utc}`);
  L.push(`- **Event:** ${a.target.event_title}`);
  L.push(`- **Market:** ${a.target.market_url}`);
  L.push(`- **Current board strikes:** ${a.board.current_strike_count}`);
  L.push(`- **Prior Kalshi boards retrievable:** ${a.history.prior_board_count} (settled=${a.history.settled_count}, closed=${a.history.closed_count})`);
  L.push(`- **Source-backed strikes:** ${a.coverage_summary.source_backed_strikes}/${a.coverage_summary.strike_count}; low-source: ${a.coverage_summary.low_source_strikes}`);
  L.push(`- **Transcript sources word-matched:** ${a.coverage_summary.transcript_sources}`);
  L.push('');
  L.push('> Price isolation: market price/bid/ask/volume/open-interest never enter coverage, source selection, or ranking. They are not read by this audit at all.');
  L.push('');
  L.push('## History note');
  L.push('');
  L.push(a.history.note);
  L.push('');
  L.push('## Sources');
  L.push('');
  L.push('| label | quarter | type | status | bytes | url |');
  L.push('|---|---|---|---|---|---|');
  for (const s of a.sources) {
    L.push(`| ${s.label} | ${s.quarter} | ${s.source_type} | ${s.fetch_ok ? 'OK ' + s.fetch_status : 'FAIL ' + (s.fetch_error || s.fetch_status)} | ${s.bytes} | ${s.source_url} |`);
  }
  L.push('');
  L.push('## Strike coverage table');
  L.push('');
  L.push('| # | ticker | strike | prior board | resolved Y/N/ednq/amb/unres | last-4q transcript hits | official hit | needs fresh fetch | source-backed |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  a.coverage.forEach((r, i) => {
    L.push(`| ${i + 1} | ${r.ticker} | ${r.strike} | ${r.prior_board_seen ? 'yes' : 'no'} | ${r.resolved_yes}/${r.resolved_no}/${r.ednq}/${r.ambiguous}/${r.unresolved} | ${r.last_4q_transcript_hits}/${r.last_4q_transcript_quarters} | ${r.official_document_hit ? 'yes' : 'no'} | ${r.needs_fresh_source_fetch ? 'yes' : 'no'} | ${r.source_backed ? 'YES' : 'low'} |`);
  });
  L.push('');
  L.push('## Per-strike transcript evidence (first verbatim hit per source)');
  L.push('');
  for (const r of a.coverage) {
    L.push(`### ${r.strike} (${r.ticker})`);
    const hits = r.per_source.filter((p) => p.hit);
    if (!hits.length) {
      L.push('- No source hit (recorded miss).');
    } else {
      for (const p of hits) {
        L.push(`- **${p.source_label}** [${p.source_type}] matched "${p.matched_alternative}": "${p.quote}"`);
      }
    }
    L.push('');
  }
  L.push('## Source ladder');
  L.push('');
  L.push('```');
  L.push(...renderSourceLadder(ladder));
  L.push('```');
  L.push('');
  return L.join('\n');
}

// --- CLI parameterization (earnings-family generalization) ---------------
// Defaults to the Kroger canary so the morning command stays unchanged. Any
// other earnings-mention event runs through the SAME pure coverage path by
// passing --series-ticker/--event-ticker/--slug (or --event-url) plus a
// declared --sources-file (JSON array of {label,quarter,source_type,source_url}).
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// Parse a Kalshi market URL into { eventTicker, seriesTicker }. The event
// ticker is the final path segment; the series ticker is its date-prefixed
// stem (KXEARNINGSMENTIONKR-26JUN18 -> KXEARNINGSMENTIONKR).
function parseEventUrl(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const eventTicker = segs[segs.length - 1] || null;
    const seriesTicker = eventTicker ? eventTicker.split('-')[0] : null;
    return { eventTicker, seriesTicker };
  } catch {
    return { eventTicker: null, seriesTicker: null };
  }
}

function loadSourcesFile(path) {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`--sources-file ${path} must contain a non-empty JSON array of source objects`);
  }
  for (const s of list) {
    if (!s || !s.source_url || !s.source_type) {
      throw new Error(`--sources-file ${path} entries require source_url and source_type`);
    }
  }
  return list;
}

function parseCliOptions(argv) {
  const args = argv.slice(2);
  const fromUrl = argValue(args, '--event-url');
  const urlParts = fromUrl ? parseEventUrl(fromUrl) : { eventTicker: null, seriesTicker: null };
  const opts = {};
  const eventTicker = argValue(args, '--event-ticker') ?? urlParts.eventTicker;
  const seriesTicker = argValue(args, '--series-ticker') ?? urlParts.seriesTicker;
  const slug = argValue(args, '--slug') ?? (eventTicker ? eventTicker.toLowerCase() : null);
  const stateRoot = argValue(args, '--state-root');
  const sourcesFile = argValue(args, '--sources-file');
  if (eventTicker) opts.eventTicker = eventTicker;
  if (seriesTicker) opts.seriesTicker = seriesTicker;
  if (slug) opts.slug = slug;
  if (stateRoot) opts.stateRoot = stateRoot;
  if (sourcesFile) opts.sources = loadSourcesFile(sourcesFile);
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/mentions/alpha-labs-source-audit.mjs [--event-url URL | --series-ticker S --event-ticker E] [--slug SLUG] [--sources-file sources.json] [--state-root state]');
    console.log('Defaults to the Kroger canary (KXEARNINGSMENTIONKR-26JUN18) when no flags are given.');
    process.exit(0);
  }
  runAudit(parseCliOptions(process.argv))
    .then(({ jsonPath, mdPath, artifact }) => {
      console.log(`[alpha-labs] ${artifact.determination}: ${artifact.coverage_summary.source_backed_strikes}/${artifact.coverage_summary.strike_count} source-backed`);
      console.log(`[alpha-labs] json: ${jsonPath}`);
      console.log(`[alpha-labs] md:   ${mdPath}`);
    })
    .catch((err) => {
      console.error(`[alpha-labs] ${err.message}`);
      process.exit(1);
    });
}
