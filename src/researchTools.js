// CPC research tool registry for the MCP server.
//
// Each entry is { name, config, handler } and is registered verbatim onto the
// McpServer in src/server.js. Every handler returns a "full output" envelope:
// the complete human-readable text in `content` and the complete result object
// in `structuredContent`. Pass `compact: true` (or set MCP_COMPACT_DEFAULT=true)
// to fall back to the short card instead.
//
// Hard constraints carried from the project rules:
//   - mentions tools run FRESH research and FAIL CLOSED. They never render from a
//     stale cache; a research failure returns an error envelope.
//   - settled-history stays price-free (the builders run assertNoForbiddenFields).
//   - No sends/deliverables: mentions render in dry-run (no .txt written, no
//     telegram), and sport previews run against an isolated temp state root so a
//     cron sender never sees their output.

import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod/v4'

import { buildFocusedKalshiMarketPlan, buildEventMarketPlanSummary } from './eventMarketTool.js'
import { analyzeCompositeMarketLink } from '../scripts/mlb/link-composite-card.mjs'
import { generateMentionEventPacket, parseEventIdFromUrl } from '../scripts/packets/generate-mention-event.mjs'
import { resolveOnlyMentionEvents, writeKalshiEventPackets } from '../scripts/packets/generate-mentions-daily.mjs'
import { loadHistory, buildSettledHistoryArtifact } from '../scripts/mentions/settled-history.mjs'
import { buildSportsSettledHistory } from '../scripts/mentions/sports-settled-history.mjs'
import { loadEarningsHistory, buildEarningsQuarterLayer } from '../scripts/mentions/earnings-quarter-history.mjs'
import { loadMlbScoring, locateMlbArtifacts, buildMlbSlatePacket } from '../scripts/packets/generate-mlb-daily.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPACT_DEFAULT = process.env.MCP_COMPACT_DEFAULT === 'true'

// Sport verticals → the packet-type subdir their daily cron writes under
// state/packets/<date>/. sports_preview surfaces the latest banked packet
// (read-only); it does not regenerate, so it never writes or sends anything.
const SPORT_PACKET_TYPES = {
  nascar: 'nascar-sunday',
  ufc: 'ufc-weekly',
  worldcup: 'worldcup-matchday',
}

function wantsCompact(arg) {
  return arg === true || (arg === undefined && COMPACT_DEFAULT)
}

function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

// Full output by default: complete text in content + full object in structuredContent.
function envelope({ text, data, compactText, compactData, compact }) {
  const useCompact = wantsCompact(compact)
  const outData = useCompact ? (compactData ?? data) : data
  const outText = useCompact ? asText(compactText ?? compactData ?? text) : asText(text ?? data)
  return {
    content: [{ type: 'text', text: outText }],
    structuredContent: outData,
  }
}

function errorEnvelope(message, extra = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { status: 'error', error: message, ...extra },
  }
}

// America/Chicago is the canonical CPC date anchor (never UTC).
export function chicagoToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

// Default sport-preview runner: read the latest packet the daily cron already
// generated for this date/sport. Read-only — never regenerates, writes, or sends.
function slugForMatch(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function readLatestSportPacket({ sport, date, match = null, stateRoot = 'state' }) {
  const packetType = SPORT_PACKET_TYPES[sport]
  if (!packetType) throw new Error(`unsupported sport "${sport}" (supported: ${Object.keys(SPORT_PACKET_TYPES).join(', ')})`)
  const dir = resolve(REPO_ROOT, stateRoot, 'packets', date, packetType)
  if (!existsSync(dir)) return { text: null, packetType }
  let txts = readdirSync(dir)
    .filter((f) => f.endsWith('.txt') && !/\.(inventory|model-scores)\.txt$/i.test(f))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  // Optional single-match filter: banked per-match packets are named by team
  // slug (e.g. worldcup-<date>-<stage>-portugal-uzbekistan.txt), so match by slug.
  if (match) {
    const want = slugForMatch(match)
    txts = txts.filter((t) => slugForMatch(t.f).includes(want))
  }
  if (!txts.length) return { text: null, packetType, filtered: Boolean(match) }
  return { text: readFileSync(join(dir, txts[0].f), 'utf8'), file: txts[0].f, packetType }
}

export function buildResearchTools({
  pipelineService = null,
  marketLinkAnalyzer = analyzeCompositeMarketLink,
  // Earnings-only single-event path (fresh Perplexity research).
  earningsMentionRunner = generateMentionEventPacket,
  // General multi-family mentions engine (covers Trump/Fed/sports/earnings).
  onlyResolver = resolveOnlyMentionEvents,
  packetWriter = writeKalshiEventPackets,
  // Sport previews (nascar/ufc/worldcup) — surfaces the latest banked cron packet.
  sportsRunner = readLatestSportPacket,
} = {}) {
  const tools = []

  // 1. Kalshi market URL → full plan.
  tools.push({
    name: 'analyze_kalshi_market_url',
    config: {
      description:
        'Call this immediately when the user pastes a kalshi.com/markets URL. Returns the FULL Captains Prediction Companion plan (complete card + context + market view). Pass compact:true for just the short card.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        url: z.string().min(1).describe('A Kalshi market or event URL'),
        compact: z.boolean().optional().describe('Return the short card instead of the full plan'),
      },
    },
    handler: async ({ url, compact }) => {
      try {
        pipelineService?.recordRecentUrl?.(url)
        const composite = await marketLinkAnalyzer({ url })
        if (composite?.handled) {
          const card = composite?.compact_card ?? composite
          return envelope({ text: composite, data: composite, compactText: card, compactData: card, compact })
        }
        const result = await buildFocusedKalshiMarketPlan({ url, venue: 'Kalshi' }, { pipelineService })
        const card = buildEventMarketPlanSummary(result)
        return envelope({ text: result, data: result, compactText: card, compactData: card, compact })
      } catch (err) {
        return errorEnvelope(`analyze_kalshi_market_url failed: ${err.message}`, { url })
      }
    },
  })

  // 2. General mentions research — ALL families (Trump/Fed/sports/earnings).
  // Runs the real daily engine for a single event in dry-run: fresh research via
  // the gather/prime path, no .txt written, no telegram send. Fails closed.
  tools.push({
    name: 'mentions_research',
    config: {
      description:
        'Run fresh Captains Prediction Companion mentions research for ANY Kalshi mention event (Trump/White House, Fed, sports announcer/rally, earnings, etc.) and return the complete rendered packet. Provide event_ticker (KX...) or event_url. Fresh every call, never cached; fails closed if no usable source-backed research exists.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        event_url: z.string().optional().describe('Kalshi event URL'),
        event_ticker: z.string().optional().describe('Kalshi event ticker (KX...)'),
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return a one-line summary instead of the full packet'),
      },
    },
    handler: async ({ event_url, event_ticker, date, compact }) => {
      const ticker = (event_ticker || parseEventIdFromUrl(event_url ?? '') || '').toUpperCase()
      if (!ticker) {
        return errorEnvelope('mentions_research needs a valid event_ticker (KX...) or event_url')
      }
      const day = date || chicagoToday()
      const runStartedAtUtc = new Date().toISOString()
      try {
        const only = await onlyResolver({
          stateRoot: 'state',
          date: day,
          tickers: [ticker],
          windowDays: 7,
          allowUndated: true,
          runStartedAtUtc,
        })
        const events = (only?.allEvents ?? []).filter((ev) => ev?.event_ticker === ticker)
        if (!events.length) {
          return errorEnvelope(`mentions_research: event ${ticker} not found for ${day} (fail-closed)`, { event_ticker: ticker, date: day })
        }
        const res = await packetWriter({
          events,
          date: day,
          stateRoot: 'state',
          dir: mkdtempSync(join(tmpdir(), 'cpc-mentions-')),
          audit: () => ({ txtPath: null, metaPath: null, chunkCount: 0 }),
          dryRun: true,
          allPrimeAttempts: only?.allPrimeAttempts ?? [],
          runStartedAtUtc,
        })
        const item = (res?.items ?? []).find((i) => i.name === ticker)
        const text = item?.previewText
        if (!text) {
          return errorEnvelope(
            `mentions_research: ${ticker} produced no customer packet (fail-closed — no usable source-backed evidence).`,
            { event_ticker: ticker, date: day, failed: res?.failedTickers ?? [] },
          )
        }
        const compactLine = `mentions ${ticker} @ ${day} — packet rendered (${text.length} chars)`
        return envelope({
          text,
          data: { event_ticker: ticker, date: day, previewText: text, failedTickers: res?.failedTickers ?? [] },
          compactText: compactLine,
          compactData: { summary: compactLine, event_ticker: ticker, date: day },
          compact,
        })
      } catch (err) {
        return errorEnvelope(`mentions_research failed (fail-closed, no cache): ${err.message}`, { event_ticker: ticker, date: day })
      }
    },
  })

  // 3. Earnings-only mention research (manual single-event Perplexity path).
  tools.push({
    name: 'earnings_mention_research',
    config: {
      description:
        'Run the manual EARNINGS-CALL mention research path for a single Kalshi earnings event and return the full rendered packet. Use only for earnings-call mention markets; for other families use mentions_research. Fresh every call, fails closed.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        event_url: z.string().optional().describe('Kalshi event URL'),
        event_id: z.string().optional().describe('Kalshi event id (KX...)'),
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return a short summary line instead of the full packet'),
      },
    },
    handler: async ({ event_url, event_id, date, compact }) => {
      const eventId = event_id || parseEventIdFromUrl(event_url ?? '')
      if (!eventId) {
        return errorEnvelope('earnings_mention_research needs a valid event_id (KX...) or event_url')
      }
      const day = date || chicagoToday()
      try {
        const result = await earningsMentionRunner({ eventUrl: event_url ?? null, eventId, date: day })
        const packetText = readFileSync(result.packetPath, 'utf8')
        const compactLine =
          `earnings mention ${eventId} @ ${day} — route=${result?.route?.route ?? 'n/a'} ` +
          `janitor=${result?.janitor?.verdict ?? 'n/a'} sources=${result?.sanitized?.source_urls?.length ?? 0}`
        return envelope({
          text: packetText,
          data: { packetText, ...result },
          compactText: compactLine,
          compactData: { summary: compactLine, packetPath: result.packetPath },
          compact,
        })
      } catch (err) {
        return errorEnvelope(`earnings_mention_research failed (fail-closed, no cache): ${err.message}`, { event_id: eventId, date: day })
      }
    },
  })

  // 4. Settled-event history (price-free base rates), routed by family.
  tools.push({
    name: 'settled_event_history',
    config: {
      description:
        'Look up settled-event history (price-free base rates) for a Kalshi series. Routes by family: family="sports" uses the sports settled engine, family="earnings" uses the per-company quarter history, otherwise the generic settled-history match. Returns the full artifact (sample size, hit rate, settlement breakdown, match tier).',
      annotations: { readOnlyHint: true },
      inputSchema: {
        series_ticker: z.string().optional().describe('Kalshi series ticker to scope history'),
        family: z.enum(['general', 'sports', 'earnings']).optional().describe('History engine to use (default general)'),
        event_title: z.string().optional().describe('Event title (helps sports team/venue detection)'),
        route: z.string().optional(),
        entity: z.string().optional().describe('Entity/company ticker (earnings) or actor (general/sports)'),
        horizon: z.string().optional(),
        max_samples: z.number().int().positive().optional(),
        compact: z.boolean().optional().describe('Return just the summary note'),
      },
    },
    handler: async ({ series_ticker, family = 'general', event_title, route, entity, horizon, max_samples, compact }) => {
      try {
        if (family === 'sports') {
          const artifact = await buildSportsSettledHistory({
            eventTicker: series_ticker ?? null,
            seriesTicker: series_ticker ?? null,
            eventTitle: event_title ?? null,
            route: route ?? 'sports_announcer',
            entity: entity ?? null,
            horizon: horizon ?? 'event',
          })
          const note = artifact?.note ?? artifact?.settledLayer?.note ?? 'sports settled history'
          return envelope({ text: artifact, data: artifact, compactText: note, compactData: { note }, compact })
        }
        if (family === 'earnings') {
          const ticker = entity ?? series_ticker
          if (!ticker) return errorEnvelope('earnings family needs entity (company ticker)')
          const quarters = await loadEarningsHistory({ ticker })
          const layer = buildEarningsQuarterLayer({ ticker, terms: [], quarters })
          const data = { ticker, quarters, layer }
          const note = `earnings history ${ticker}: ${Array.isArray(quarters) ? quarters.length : 0} quarter(s)`
          return envelope({ text: data, data, compactText: note, compactData: { note }, compact })
        }
        const records = await loadHistory({ seriesTicker: series_ticker ?? null })
        const artifact = buildSettledHistoryArtifact({
          records,
          route: route ?? null,
          entity: entity ?? null,
          horizon: horizon ?? null,
          seriesTicker: series_ticker ?? null,
          maxSamples: max_samples ?? 5,
        })
        return envelope({
          text: artifact,
          data: artifact,
          compactText: artifact.note,
          compactData: { note: artifact.note, hit_rate: artifact.hit_rate, sample_size: artifact.sample_size },
          compact,
        })
      } catch (err) {
        return errorEnvelope(`settled_event_history failed: ${err.message}`, { series_ticker, family })
      }
    },
  })

  // 5. Composite model — run the MLB composite engine explicitly for a market URL.
  tools.push({
    name: 'run_composite_model',
    config: {
      description:
        'Explicitly run the CPC composite model for a Kalshi market URL and return the full composite board (per-team composite scores, routed lane, model output). Use this when the user wants the composite read for an MLB market, even if analyze_kalshi_market_url did not auto-route to it. Pass compact:true for just the card.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        url: z.string().min(1).describe('Kalshi market/event URL to route into the composite model'),
        date: z.string().optional().describe('YYYY-MM-DD slate date (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return the compact card instead of the full board'),
      },
    },
    handler: async ({ url, date, compact }) => {
      const day = date || chicagoToday()
      try {
        const result = await marketLinkAnalyzer({ url, date: day, forceHandle: true })
        const card = result?.compact_card ?? result
        if (result?.ok === false) {
          return {
            isError: false,
            content: [{ type: 'text', text: asText(result) }],
            structuredContent: result,
          }
        }
        return envelope({ text: result, data: result, compactText: card, compactData: card, compact })
      } catch (err) {
        return errorEnvelope(`run_composite_model failed: ${err.message}`, { url, date: day })
      }
    },
  })

  // 6. MLB slate preview → full packet text.
  tools.push({
    name: 'mlb_sports_preview',
    config: {
      description:
        'Return the full Captains Prediction Companion MLB slate preview packet for a date. Requires the daily scoring pipeline to have already produced picks for that date; otherwise fails with guidance. Defaults to America/Chicago today.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return slate counts instead of the full packet'),
      },
    },
    handler: async ({ date, compact }) => {
      const day = date || chicagoToday()
      try {
        const scoring = loadMlbScoring('state', day)
        if (!scoring) {
          return errorEnvelope(`No MLB scoring found for ${day}. Run the daily MLB pipeline first.`, { date: day })
        }
        const artifacts = locateMlbArtifacts('state', day)
        const slate = buildMlbSlatePacket({ date: day, scoring, artifacts })
        if (!slate) {
          return errorEnvelope(`No MLB slate could be built for ${day} (no qualifying picks).`, { date: day })
        }
        return envelope({
          text: slate.text,
          data: slate,
          compactText: `MLB ${day} — ${slate.counts.board}/${slate.counts.total} board picks, ${slate.counts.lineupPending} awaiting lineups`,
          compactData: { date: day, counts: slate.counts },
          compact,
        })
      } catch (err) {
        return errorEnvelope(`mlb_sports_preview failed: ${err.message}`, { date: day })
      }
    },
  })

  // 7. Sport preview (NASCAR / UFC / World Cup). Surfaces the latest packet the
  // daily cron already generated for that date — read-only, never writes or sends.
  tools.push({
    name: 'sports_preview',
    config: {
      description:
        'Return the latest Captains Prediction Companion preview packet for a sport vertical, as generated by its daily cron. sport="nascar" (Sunday race), "ufc" (weekly card), or "worldcup" (matchday board). Optional match filters World Cup to one match by team slug (e.g. "portugal-uzbekistan" or "portugal"). Read-only — surfaces the freshest banked packet; if none exists it fails with guidance. Defaults to America/Chicago today.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        sport: z.enum(['nascar', 'ufc', 'worldcup']).describe('Which sport vertical to preview'),
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        match: z.string().optional().describe('Single-match filter by team slug, e.g. "portugal-uzbekistan" (World Cup)'),
        compact: z.boolean().optional().describe('Return a one-line summary instead of the full packet'),
      },
    },
    handler: async ({ sport, date, match, compact }) => {
      const day = date || chicagoToday()
      try {
        const { text, file } = await sportsRunner({ sport, date: day, match: match ?? null })
        if (!text) {
          const scope = match ? `no ${sport} packet matching "${match}"` : `no ${sport} packet`
          return errorEnvelope(`sports_preview: ${scope} found for ${day}. The daily cron generates these; run it for that date first.`, { sport, date: day, match: match ?? null })
        }
        const compactLine = `${sport} preview @ ${day} — ${file ?? 'packet'} (${text.length} chars)`
        return envelope({
          text,
          data: { sport, date: day, match: match ?? null, file: file ?? null, packetText: text },
          compactText: compactLine,
          compactData: { summary: compactLine, sport, date: day, file: file ?? null },
          compact,
        })
      } catch (err) {
        return errorEnvelope(`sports_preview failed: ${err.message}`, { sport, date: day })
      }
    },
  })

  return tools
}
