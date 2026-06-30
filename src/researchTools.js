// CPC research tool registry for the MCP server.
//
// Each entry is { name, config, handler } and is registered verbatim onto the
// McpServer in src/server.js. Every handler returns a compact, app-safe card by
// default: a short human-readable summary in `content` and a structured card in
// `structuredContent`. Pass `compact: true` (or set MCP_COMPACT_DEFAULT=true)
// for the shortest one-line content version.
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

import { buildFocusedKalshiMarketPlan } from './eventMarketTool.js'
import { analyzeCompositeMarketLink } from '../scripts/mlb/link-composite-card.mjs'
import { generateMentionEventPacket, parseEventIdFromUrl } from '../scripts/packets/generate-mention-event.mjs'
import { resolveOnlyMentionEvents, writeKalshiEventPackets } from '../scripts/packets/generate-mentions-daily.mjs'
import { loadHistory, buildSettledHistoryArtifact } from '../scripts/mentions/settled-history.mjs'
import { buildSportsSettledHistory } from '../scripts/mentions/sports-settled-history.mjs'
import { loadEarningsHistory, buildEarningsQuarterLayer } from '../scripts/mentions/earnings-quarter-history.mjs'
import { loadMlbScoring, locateMlbArtifacts, buildMlbSlatePacket } from '../scripts/packets/generate-mlb-daily.mjs'
import { buildAppCardSummary, renderAppCardText, PRICE_CONTEXT_DISPLAY_ONLY } from '../scripts/shared/cpc-card-summary.mjs'

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

function buildToolCardResponse(cardInput = {}, { compact = false, content = null, warnings = [], blockedReason = null, sourceSummary = null } = {}) {
  const card = buildAppCardSummary({
    ...cardInput,
    sourceSummary: sourceSummary ?? cardInput.sourceSummary ?? 'Source summary unavailable.',
    warnings,
    blockedReason: blockedReason ?? cardInput.blockedReason ?? cardInput.blocked_reason ?? null,
    modelRead: cardInput.modelRead ?? cardInput.model_read ?? null,
  })
  const text = content ?? (wantsCompact(compact)
    ? `${card.title}. ${card.plain_english} Price context is display-only.`
    : renderAppCardText(card))
  return {
    content: [{ type: 'text', text }],
    structuredContent: card,
  }
}

function buildBlockedToolCard(message, cardInput = {}, { compact = false, sourceSummary = null, warnings = [] } = {}) {
  return {
    isError: true,
    ...buildToolCardResponse({
      title: cardInput.title ?? 'Blocked',
      plainEnglish: cardInput.plainEnglish ?? message,
      settlement: cardInput.settlement ?? 'No output was produced.',
      route: cardInput.route ?? 'tool/blocked',
      cpcRead: cardInput.cpcRead ?? 'BLOCKED',
      modelRead: cardInput.modelRead ?? cardInput.model_read ?? message,
      evidenceStatus: cardInput.evidenceStatus ?? 'blocked',
      baseRate: cardInput.baseRate ?? 'unavailable',
      priceContext: cardInput.priceContext ?? PRICE_CONTEXT_DISPLAY_ONLY,
      ticker: cardInput.ticker ?? null,
      marketId: cardInput.marketId ?? null,
      eventId: cardInput.eventId ?? null,
    }, {
      compact,
      sourceSummary: sourceSummary ?? 'The tool could not produce an app-safe result.',
      warnings: [...warnings, message],
      blockedReason: message,
      content: `Blocked: ${message}`,
    }),
  }
}

function getAppCard(result = {}) {
  return result?.compact_card?.card
    ?? result?.user_facing?.card
    ?? result?.card
    ?? null
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
        'Call this immediately when the user pastes a kalshi.com/markets URL. Returns a concise CPC card with plain-English meaning, settlement, model read, and display-only price context.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        url: z.string().min(1).describe('A Kalshi market or event URL'),
        compact: z.boolean().optional().describe('Return the shortest card text instead of the default concise card'),
      },
    },
    handler: async ({ url, compact }) => {
      try {
        pipelineService?.recordRecentUrl?.(url)
        const composite = await marketLinkAnalyzer({ url })
        if (composite?.handled) {
          const card = getAppCard(composite) ?? composite?.compact_card?.card ?? composite?.compact_card ?? composite
          return buildToolCardResponse(card, {
            compact,
            sourceSummary: 'Kalshi market page and CPC market route.',
            warnings: ['Price context is display-only and not used in scoring.'],
            content: wantsCompact(compact)
              ? `${card?.title ?? 'Kalshi market'}. ${card?.plain_english ?? 'This card explains the market in plain English.'}`
              : null,
          })
        }
        const result = await buildFocusedKalshiMarketPlan({ url, venue: 'Kalshi' }, { pipelineService })
        const card = getAppCard(result) ?? result?.user_facing?.card ?? result?.user_facing ?? result
        return buildToolCardResponse(card, {
          compact,
          sourceSummary: 'Kalshi market page and CPC market route.',
          warnings: ['Price context is display-only and not used in scoring.'],
        })
      } catch (err) {
        return buildBlockedToolCard(`analyze_kalshi_market_url could not build a card.`, {
          title: 'Kalshi market card blocked',
          plainEnglish: 'The market card could not be built from the current input.',
          route: 'analyze_kalshi_market_url',
          modelRead: err.message,
          ticker: null,
          marketId: null,
          eventId: null,
        }, {
          compact,
          sourceSummary: 'Kalshi market page and CPC market route.',
          warnings: [String(err.message ?? 'Unknown error')],
        })
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
        'Run fresh Captains Prediction Companion mentions research for any Kalshi mention event and return a concise card with the event meaning, model read, and source-backed status. Provide event_ticker (KX...) or event_url. Fresh every call, never cached; fails closed if no usable source-backed research exists.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        event_url: z.string().optional().describe('Kalshi event URL'),
        event_ticker: z.string().optional().describe('Kalshi event ticker (KX...)'),
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return the shortest card text instead of the default concise card'),
      },
    },
    handler: async ({ event_url, event_ticker, date, compact }) => {
      const ticker = (event_ticker || parseEventIdFromUrl(event_url ?? '') || '').toUpperCase()
      if (!ticker) {
        return buildBlockedToolCard('mentions_research needs a valid event_ticker (KX...) or event_url', {
          title: 'Mentions research blocked',
          plainEnglish: 'The tool needs a Kalshi event ticker or event URL.',
          route: 'mentions_research',
          evidenceStatus: 'blocked',
          cpcRead: 'BLOCKED',
          modelRead: 'No event identifier was provided.',
        }, { compact, sourceSummary: 'Fresh mentions research was not started.' })
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
          return buildBlockedToolCard(`mentions_research: event ${ticker} not found for ${day}.`, {
            title: `Mentions research blocked for ${ticker}`,
            plainEnglish: 'The requested event was not found for the selected date.',
            route: 'mentions_research',
            ticker,
            eventId: ticker,
            evidenceStatus: 'blocked',
            cpcRead: 'BLOCKED',
            modelRead: `No event found for ${day}.`,
          }, { compact, sourceSummary: 'Fresh mentions research did not find a matching event.' })
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
        if (!item?.previewText) {
          return buildBlockedToolCard(
            `mentions_research: ${ticker} produced no app-safe card for ${day}.`,
            {
              title: `Mentions research blocked for ${ticker}`,
              plainEnglish: 'The research ran, but no customer-safe card was produced.',
              route: 'mentions_research',
              ticker,
              eventId: ticker,
              evidenceStatus: 'blocked',
              cpcRead: 'BLOCKED',
              modelRead: 'No usable source-backed evidence was available.',
            },
            {
              compact,
              sourceSummary: 'Fresh mentions research did not produce a usable packet.',
              warnings: (res?.failedTickers ?? []).map((failed) => `Missing source coverage for ${failed}.`),
            },
          )
        }
        const warnings = []
        if (Array.isArray(res?.failedTickers) && res.failedTickers.length) {
          warnings.push(`Missing source coverage for ${res.failedTickers.length} event${res.failedTickers.length === 1 ? '' : 's'}.`)
        }
        return buildToolCardResponse({
          title: `Mentions research for ${ticker}`,
          plainEnglish: 'Fresh source-backed mentions research was rendered for the requested event.',
          settlement: 'Settlement follows the exact wording rules in the market.',
          route: 'mentions_research',
          cpcRead: 'WATCH',
          modelRead: `Fresh mentions research for ${ticker} is ready.`,
          evidenceStatus: warnings.length === 0 ? 'complete' : 'thin',
          baseRate: 'unavailable',
          ticker,
          marketId: ticker,
          eventId: ticker,
        }, {
          compact,
          sourceSummary: 'Fresh mentions research card from the daily dry-run route.',
          warnings: ['Price context is display-only and not used in scoring.', ...warnings],
        })
      } catch (err) {
        return buildBlockedToolCard(`mentions_research failed: ${err.message}`, {
          title: `Mentions research blocked for ${ticker}`,
          plainEnglish: 'The research could not complete.',
          route: 'mentions_research',
          ticker,
          eventId: ticker,
          evidenceStatus: 'blocked',
          cpcRead: 'BLOCKED',
          modelRead: String(err.message ?? 'Unknown error'),
        }, {
          compact,
          sourceSummary: 'Fresh mentions research failed before a card could be built.',
        })
      }
    },
  })

  // 3. Earnings-only mention research (manual single-event Perplexity path).
  tools.push({
    name: 'earnings_mention_research',
    config: {
      description:
        'Run the manual earnings-call mention research path for a single Kalshi earnings event and return a concise card with the event meaning, model read, and source-backed status. Use only for earnings-call mention markets; for other families use mentions_research. Fresh every call, fails closed.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        event_url: z.string().optional().describe('Kalshi event URL'),
        event_id: z.string().optional().describe('Kalshi event id (KX...)'),
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return the shortest card text instead of the default concise card'),
      },
    },
    handler: async ({ event_url, event_id, date, compact }) => {
      const eventId = event_id || parseEventIdFromUrl(event_url ?? '')
      if (!eventId) {
        return buildBlockedToolCard('earnings_mention_research needs a valid event_id (KX...) or event_url', {
          title: 'Earnings mention research blocked',
          plainEnglish: 'The tool needs a Kalshi event id or event URL.',
          route: 'earnings_mention_research',
          evidenceStatus: 'blocked',
          cpcRead: 'BLOCKED',
          modelRead: 'No event identifier was provided.',
        }, { compact, sourceSummary: 'Fresh earnings mention research was not started.' })
      }
      const day = date || chicagoToday()
      try {
        const result = await earningsMentionRunner({ eventUrl: event_url ?? null, eventId, date: day })
        const sourceCount = Array.isArray(result?.sanitized?.source_urls) ? result.sanitized.source_urls.length : 0
        if (sourceCount <= 0) {
          return buildBlockedToolCard(`earnings_mention_research: ${eventId} has no declared source URLs for ${day}.`, {
            title: 'Earnings mention research blocked',
            plainEnglish: 'The research ran, but no declared source URLs were available for the event.',
            route: 'earnings_mention_research',
            eventId,
            ticker: eventId,
            evidenceStatus: 'blocked',
            cpcRead: 'BLOCKED',
            modelRead: 'No usable source-backed event evidence was available.',
          }, {
            compact,
            sourceSummary: 'Fresh earnings research did not produce declared source URLs.',
          })
        }
        return buildToolCardResponse({
          title: `Earnings mention research for ${eventId}`,
          plainEnglish: 'Fresh source-backed research was rendered for the earnings mention event.',
          settlement: 'Settlement follows the market rules for the exact earnings wording.',
          route: 'earnings_mention_research',
          cpcRead: 'WATCH',
          modelRead: `Fresh earnings research for ${eventId} is ready.`,
          evidenceStatus: 'complete',
          baseRate: 'unavailable',
          ticker: eventId,
          marketId: eventId,
          eventId,
        }, {
          compact,
          sourceSummary: `Fresh earnings research card with ${sourceCount} declared source URL${sourceCount === 1 ? '' : 's'}.`,
          warnings: ['Price context is display-only and not used in scoring.'],
        })
      } catch (err) {
        return buildBlockedToolCard(`earnings_mention_research failed: ${err.message}`, {
          title: 'Earnings mention research blocked',
          plainEnglish: 'The research could not complete.',
          route: 'earnings_mention_research',
          eventId,
          ticker: eventId,
          evidenceStatus: 'blocked',
          cpcRead: 'BLOCKED',
          modelRead: String(err.message ?? 'Unknown error'),
        }, {
          compact,
          sourceSummary: 'Fresh earnings research failed before a card could be built.',
        })
      }
    },
  })

  // 4. Settled-event history (price-free base rates), routed by family.
  tools.push({
    name: 'settled_event_history',
    config: {
      description:
        'Look up settled-event history (price-free base rates) for a Kalshi series and return a concise card with the sample size, hit rate, and settlement summary. Routes by family: family="sports" uses the sports settled engine, family="earnings" uses the per-company quarter history, otherwise the generic settled-history match.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        series_ticker: z.string().optional().describe('Kalshi series ticker to scope history'),
        family: z.enum(['general', 'sports', 'earnings']).optional().describe('History engine to use (default general)'),
        event_title: z.string().optional().describe('Event title (helps sports team/venue detection)'),
        route: z.string().optional(),
        entity: z.string().optional().describe('Entity/company ticker (earnings) or actor (general/sports)'),
        horizon: z.string().optional(),
        max_samples: z.number().int().positive().optional(),
        compact: z.boolean().optional().describe('Return the shortest card text instead of the default concise card'),
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
          const sampleSize = artifact?.sample_size ?? artifact?.settledLayer?.sample_size ?? null
          const hitRate = artifact?.hit_rate ?? artifact?.settledLayer?.hit_rate ?? null
          return buildToolCardResponse({
            title: `Settled history for ${series_ticker ?? 'the requested sports series'}`,
            plainEnglish: 'This card shows price-free settled history for the sports family.',
            settlement: 'No price is used here. It is a historical reference card only.',
            route: `settled_event_history/${family}`,
            cpcRead: 'WATCH',
            modelRead: artifact?.note ?? 'Sports settled history is ready.',
            evidenceStatus: artifact?.usable === false ? 'unavailable' : 'complete',
            baseRate: {
              sample_size: sampleSize,
              hit_rate: hitRate,
              tier: artifact?.match_tier ?? artifact?.settledLayer?.match_tier ?? null,
              summary: artifact?.note ?? 'sports settled history',
            },
            priceContext: PRICE_CONTEXT_DISPLAY_ONLY,
            ticker: series_ticker ?? null,
            marketId: series_ticker ?? null,
            eventId: series_ticker ?? null,
          }, {
            compact,
            sourceSummary: 'Price-free settled history sample for the sports family.',
            warnings: artifact?.usable === false ? ['No settled samples were available.'] : [],
          })
        }
        if (family === 'earnings') {
          const ticker = entity ?? series_ticker
          if (!ticker) {
            return buildBlockedToolCard('earnings family needs entity (company ticker)', {
              title: 'Earnings settled history blocked',
              plainEnglish: 'The earnings history tool needs a company ticker.',
              route: 'settled_event_history/earnings',
              evidenceStatus: 'blocked',
              cpcRead: 'BLOCKED',
              modelRead: 'No company ticker was provided.',
            }, { compact, sourceSummary: 'Price-free earnings settled history could not be started.' })
          }
          const quarters = await loadEarningsHistory({ ticker })
          const layer = buildEarningsQuarterLayer({ ticker, terms: [], quarters })
          return buildToolCardResponse({
            title: `Earnings settled history for ${ticker}`,
            plainEnglish: 'This card shows price-free settled history for the earnings family.',
            settlement: 'No price is used here. It is a historical reference card only.',
            route: 'settled_event_history/earnings',
            cpcRead: 'WATCH',
            modelRead: `Earnings settled history for ${ticker} is ready.`,
            evidenceStatus: Array.isArray(quarters) && quarters.length > 0 ? 'complete' : 'unavailable',
            baseRate: {
              sample_size: Array.isArray(quarters) ? quarters.length : 0,
              summary: `quarters=${Array.isArray(quarters) ? quarters.length : 0}`,
            },
            priceContext: PRICE_CONTEXT_DISPLAY_ONLY,
            ticker,
            marketId: ticker,
            eventId: ticker,
          }, {
            compact,
            sourceSummary: 'Price-free settled history sample for the earnings family.',
          })
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
        return buildToolCardResponse({
          title: `Settled history for ${series_ticker ?? 'the requested series'}`,
          plainEnglish: 'This card shows price-free settled history for the requested series.',
          settlement: 'No price is used here. It is a historical reference card only.',
          route: `settled_event_history/${family}`,
          cpcRead: 'WATCH',
          modelRead: artifact?.note ?? 'Settled history is ready.',
          evidenceStatus: artifact?.usable === false ? 'unavailable' : 'complete',
          baseRate: {
            sample_size: artifact?.sample_size ?? null,
            hit_rate: artifact?.hit_rate ?? null,
            tier: artifact?.match_tier ?? null,
            summary: artifact?.note ?? 'unavailable',
          },
          priceContext: PRICE_CONTEXT_DISPLAY_ONLY,
          ticker: series_ticker ?? null,
          marketId: series_ticker ?? null,
          eventId: series_ticker ?? null,
        }, {
          compact,
          sourceSummary: 'Price-free settled history sample.',
          warnings: artifact?.usable === false ? ['No settled samples were available.'] : [],
        })
      } catch (err) {
        return buildBlockedToolCard(`settled_event_history failed: ${err.message}`, {
          title: 'Settled history blocked',
          plainEnglish: 'The settled history card could not be built.',
          route: `settled_event_history/${family}`,
          evidenceStatus: 'blocked',
          cpcRead: 'BLOCKED',
          modelRead: String(err.message ?? 'Unknown error'),
          ticker: series_ticker ?? null,
          marketId: series_ticker ?? null,
          eventId: series_ticker ?? null,
        }, {
          compact,
          sourceSummary: 'Price-free settled history could not be built.',
        })
      }
    },
  })

  // 5. Composite model — run the MLB composite engine explicitly for a market URL.
  tools.push({
    name: 'run_composite_model',
    config: {
      description:
        'Explicitly run the CPC composite model for a Kalshi market URL and return a concise MLB card with the routed lane, plain-English meaning, model read, and display-only price context. Use this when the user wants the composite read for an MLB market.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        url: z.string().min(1).describe('Kalshi market/event URL to route into the composite model'),
        date: z.string().optional().describe('YYYY-MM-DD slate date (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return the shortest card text instead of the default concise card'),
      },
    },
    handler: async ({ url, date, compact }) => {
      const day = date || chicagoToday()
      try {
        const result = await marketLinkAnalyzer({ url, date: day, forceHandle: true })
        const card = getAppCard(result) ?? result?.compact_card?.card ?? result?.compact_card ?? result
        if (result?.ok === false) {
          return buildBlockedToolCard(result?.reason ?? 'run_composite_model could not build a card.', {
            title: 'MLB composite blocked',
            plainEnglish: 'The MLB composite card could not be built from the current input.',
            route: 'run_composite_model',
            modelRead: result?.reason ?? 'Blocked by route or source availability.',
          }, {
            compact,
            sourceSummary: 'Kalshi market page and MLB composite route.',
            warnings: [result?.reason_code ?? result?.reason ?? 'Blocked result.'],
          })
        }
        return buildToolCardResponse(card, {
          compact,
          sourceSummary: 'Kalshi market page and MLB composite model.',
          warnings: ['Price context is display-only and not used in scoring.'],
        })
      } catch (err) {
        return buildBlockedToolCard(`run_composite_model failed: ${err.message}`, {
          title: 'MLB composite blocked',
          plainEnglish: 'The MLB composite card could not be built.',
          route: 'run_composite_model',
          modelRead: String(err.message ?? 'Unknown error'),
        }, {
          compact,
          sourceSummary: 'Kalshi market page and MLB composite route.',
        })
      }
    },
  })

  // 6. MLB slate preview → full packet text.
  tools.push({
    name: 'mlb_sports_preview',
    config: {
      description:
        'Return a concise Captains Prediction Companion MLB slate preview card for a date. Requires the daily scoring pipeline to have already produced picks for that date; otherwise fails with guidance. Defaults to America/Chicago today.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        compact: z.boolean().optional().describe('Return the shortest card text instead of the default concise card'),
      },
    },
    handler: async ({ date, compact }) => {
      const day = date || chicagoToday()
      try {
        const scoring = loadMlbScoring('state', day)
        if (!scoring) {
          return buildBlockedToolCard(`No MLB scoring found for ${day}. Run the daily MLB pipeline first.`, {
            title: 'MLB preview blocked',
            plainEnglish: 'The daily MLB pipeline has not produced scoring for this date.',
            route: 'mlb_sports_preview',
            evidenceStatus: 'blocked',
            cpcRead: 'BLOCKED',
            modelRead: `No MLB scoring found for ${day}.`,
            eventId: day,
          }, { compact, sourceSummary: 'Latest MLB slate packet was not available.' })
        }
        const artifacts = locateMlbArtifacts('state', day)
        const slate = buildMlbSlatePacket({ date: day, scoring, artifacts })
        if (!slate) {
          return buildBlockedToolCard(`No MLB slate could be built for ${day} (no qualifying picks).`, {
            title: 'MLB preview blocked',
            plainEnglish: 'The daily MLB pipeline did not produce a qualifying slate.',
            route: 'mlb_sports_preview',
            evidenceStatus: 'blocked',
            cpcRead: 'BLOCKED',
            modelRead: `No qualifying picks were available for ${day}.`,
            eventId: day,
          }, { compact, sourceSummary: 'Latest MLB slate packet was not available.' })
        }
        return buildToolCardResponse({
          title: `MLB slate preview for ${day}`,
          plainEnglish: 'This card summarizes the latest MLB slate packet for the selected date.',
          settlement: 'Preview only. No settlement is attached to the preview itself.',
          route: 'mlb_sports_preview',
          cpcRead: 'WATCH',
          modelRead: `MLB slate packet for ${day} is ready.`,
          evidenceStatus: 'complete',
          baseRate: {
            summary: `${slate.counts.board}/${slate.counts.total} board picks, ${slate.counts.lineupPending} awaiting lineups`,
          },
          priceContext: PRICE_CONTEXT_DISPLAY_ONLY,
          eventId: day,
        }, {
          compact,
          sourceSummary: 'Latest MLB slate packet generated by the daily pipeline.',
          warnings: [
            `${slate.counts.board}/${slate.counts.total} board picks.`,
            `${slate.counts.lineupPending} awaiting lineups.`,
          ],
        })
      } catch (err) {
        return buildBlockedToolCard(`mlb_sports_preview failed: ${err.message}`, {
          title: 'MLB preview blocked',
          plainEnglish: 'The MLB preview card could not be built.',
          route: 'mlb_sports_preview',
          evidenceStatus: 'blocked',
          cpcRead: 'BLOCKED',
          modelRead: String(err.message ?? 'Unknown error'),
          eventId: day,
        }, { compact, sourceSummary: 'Latest MLB slate packet could not be built.' })
      }
    },
  })

  // 7. Sport preview (NASCAR / UFC / World Cup). Surfaces the latest packet the
  // daily cron already generated for that date — read-only, never writes or sends.
  tools.push({
    name: 'sports_preview',
    config: {
      description:
        'Return the latest Captains Prediction Companion preview card for a sport vertical, as generated by its daily cron. sport="nascar" (Sunday race), "ufc" (weekly card), or "worldcup" (matchday board). Optional match filters World Cup to one match by team slug (e.g. "portugal-uzbekistan" or "portugal"). Read-only — surfaces the freshest banked packet; if none exists it fails with guidance. Defaults to America/Chicago today.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        sport: z.enum(['nascar', 'ufc', 'worldcup']).describe('Which sport vertical to preview'),
        date: z.string().optional().describe('YYYY-MM-DD (defaults to America/Chicago today)'),
        match: z.string().optional().describe('Single-match filter by team slug, e.g. "portugal-uzbekistan" (World Cup)'),
        compact: z.boolean().optional().describe('Return the shortest card text instead of the default concise card'),
      },
    },
    handler: async ({ sport, date, match, compact }) => {
      const day = date || chicagoToday()
      try {
        const { text } = await sportsRunner({ sport, date: day, match: match ?? null })
        if (!text) {
          const scope = match ? `no ${sport} packet matching "${match}"` : `no ${sport} packet`
          return buildBlockedToolCard(`sports_preview: ${scope} found for ${day}. The daily cron generates these; run it for that date first.`, {
            title: `${sport.toUpperCase()} preview blocked`,
            plainEnglish: 'The latest banked preview packet was not available.',
            route: `sports_preview/${sport}`,
            evidenceStatus: 'blocked',
            cpcRead: 'BLOCKED',
            modelRead: `No ${sport} packet was available for ${day}.`,
            eventId: day,
          }, {
            compact,
            sourceSummary: 'Latest banked sport preview packet was not available.',
          })
        }
        return buildToolCardResponse({
          title: `${sport.toUpperCase()} preview for ${day}`,
          plainEnglish: 'This card summarizes the latest banked preview packet for the selected sport.',
          settlement: 'Preview only. No settlement is attached to the preview itself.',
          route: `sports_preview/${sport}`,
          cpcRead: 'WATCH',
          modelRead: `${sport.toUpperCase()} preview packet for ${day} is ready.`,
          evidenceStatus: 'complete',
          baseRate: {
            summary: `${text.length} characters of preview text`,
          },
          priceContext: PRICE_CONTEXT_DISPLAY_ONLY,
          eventId: day,
        }, {
          compact,
          sourceSummary: 'Latest banked sport preview packet generated by the daily pipeline.',
          warnings: match ? [`Filtered to ${match}.`] : [],
        })
      } catch (err) {
        return buildBlockedToolCard(`sports_preview failed: ${err.message}`, {
          title: `${sport.toUpperCase()} preview blocked`,
          plainEnglish: 'The sport preview card could not be built.',
          route: `sports_preview/${sport}`,
          evidenceStatus: 'blocked',
          cpcRead: 'BLOCKED',
          modelRead: String(err.message ?? 'Unknown error'),
          eventId: day,
        }, {
          compact,
          sourceSummary: 'Latest banked sport preview packet could not be built.',
        })
      }
    },
  })

  return tools
}
