import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAppStatusPayload,
  buildAppStatusToolResult,
  createHttpRequestHandler,
  getExpectedMcpToolNames,
} from '../src/server.js'
import { buildResearchTools } from '../src/researchTools.js'
import {
  buildCpcCardSummary,
  buildCpcStackItem,
  renderCpcCardText,
  renderCpcStackText,
} from '../scripts/shared/cpc-card-summary.mjs'
import { buildKalshiGamePacket } from '../scripts/packets/generate-mlb-daily.mjs'
import { buildRacePacket } from '../scripts/packets/generate-nascar-sunday.mjs'
import { buildKalshiEventPacket as buildUfcKalshiPacket } from '../scripts/packets/generate-ufc-weekly.mjs'
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs'
import { buildMlbSlatePacket } from '../scripts/packets/generate-mlb-daily.mjs'
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs'

const BANNED_CUSTOMER_TEXT = /(?:EVIDENCE LEAN|non-market evidence only|Side \/ market|Market board|Call:|NO CLEAR PICK|cover probability|betting edge|wager|bankroll|stake|\blean\b|\bleans\b|\bLEAN\b|projected lean|\bpick\b|\bfade\b|\bbest bet\b)/i
const LOCAL_PATH_RE = /(?:^|[^\w])\/(?:tmp|home|var|Users)\/[^\s"]+/i

function textPayload(result) {
  return [
    result?.content?.map((item) => item?.text ?? '').join('\n') ?? '',
    JSON.stringify(result?.structuredContent ?? {}),
  ].join('\n')
}

function captureJsonResponse() {
  let statusCode = null
  let payload = null
  return {
    res: {
      writeHead(code) {
        statusCode = code
      },
      end(body) {
        payload = body ? JSON.parse(String(body)) : null
      },
    },
    get statusCode() {
      return statusCode
    },
    get payload() {
      return payload
    },
  }
}

test('healthz returns ok and app_status stays structured and secret-free', async () => {
  const handler = createHttpRequestHandler()
  const capture = captureJsonResponse()
  await handler({ url: '/healthz', method: 'GET' }, capture.res)
  assert.equal(capture.statusCode, 200)
  assert.deepEqual(capture.payload.ok, true)

  const status = buildAppStatusToolResult({
    enableNoteTools: false,
  })
  assert.equal(status.structuredContent.appName, 'Captains Prediction Companion')
  assert.equal(status.structuredContent.endpoint.mcp, '/mcp')
  assert.deepEqual(status.structuredContent.toolList, getExpectedMcpToolNames({ enableNoteTools: false }))
  assert.equal(status.structuredContent.readOnlyDefault, true)
  assert.equal(status.structuredContent.noteToolsEnabled, false)
  assert.equal(status.structuredContent.posture.noTrade, true)
  assert.equal(status.structuredContent.posture.noSend, true)
  assert.equal(status.structuredContent.posture.noPublicWrite, true)
  assert.match(status.content[0].text, /read-only by default/i)
  assert.match(status.content[0].text, /price context is display-only/i)
  assert.doesNotMatch(textPayload(status), /GEMINI_API_KEY|TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|\.env|~\/\.config/i)
})

test('tool manifest matches the documented default surface', () => {
  const expected = [
    'app_status',
    'analyze_kalshi_market_url',
    'mentions_research',
    'earnings_mention_research',
    'settled_event_history',
    'run_composite_model',
    'mlb_sports_preview',
    'sports_preview',
  ]
  assert.deepEqual(getExpectedMcpToolNames({ enableNoteTools: false }), expected)
  assert.deepEqual(
    buildResearchTools().map((tool) => tool.name),
    expected.slice(1),
  )
  assert.deepEqual(getExpectedMcpToolNames({ enableNoteTools: true }).slice(0, 2), ['app_status', 'remember_note'])
  assert.ok(getExpectedMcpToolNames({ enableNoteTools: true }).includes('remember_note'))
  assert.ok(!getExpectedMcpToolNames({ enableNoteTools: false }).includes('remember_note'))
  assert.ok(!getExpectedMcpToolNames({ enableNoteTools: false }).some((name) => /(?:send|trade|write)/i.test(name)))
  for (const tool of buildResearchTools()) {
    assert.equal(tool.config.annotations?.readOnlyHint, true, `${tool.name} must be read-only`)
  }
})

test('default MCP tool outputs are concise, app-safe, and card-first', async () => {
  const tools = buildResearchTools({
    marketLinkAnalyzer: async ({ url, forceHandle }) => {
      return {
        handled: true,
        ok: true,
        compact_card: {
          card: {
            title: 'Yankees at Red Sox',
            plain_english: 'This card asks which team grades higher.',
            settlement: 'YES settles if the selected side wins.',
            route: 'mlb_composite/moneyline',
            cpc_read: 'WATCH',
            model_read: 'Yankees rate higher than Red Sox.',
            evidence_status: 'complete',
            base_rate: { summary: 'n=48' },
            price_context: 'Price is display-only and was not used in CPC posture or scoring.',
            ticker: 'KXMLB-TEST',
            market_id: 'KXMLB-TEST',
            event_id: 'KXMLBGAME-TEST',
            source_summary: 'MLB composite card',
          },
        },
      }
    },
    onlyResolver: async ({ tickers }) => ({
      allEvents: [{ event_ticker: tickers[0] }],
      allPrimeAttempts: [],
    }),
    packetWriter: async () => ({
      items: [{
        name: 'KXTRUMP',
        previewText: 'REDACTED PACKET TEXT',
      }],
      failedTickers: [],
    }),
    sportsRunner: async () => ({ text: 'UFC WEEKLY PACKET', file: '2026-06-20-ufc.txt' }),
    earningsMentionRunner: async () => ({
      packetPath: '/tmp/cpc-earn/KXEARN.txt',
      route: { route: 'earnings_call' },
      janitor: { verdict: 'pass' },
      sanitized: { source_urls: ['https://example.com'] },
    }),
  })

  const appStatus = buildAppStatusToolResult({ enableNoteTools: false })
  assert.match(textPayload(appStatus), /Price context is display-only/)
  assert.doesNotMatch(textPayload(appStatus), BANNED_CUSTOMER_TEXT)
  assert.doesNotMatch(textPayload(appStatus), LOCAL_PATH_RE)

  const analyze = tools.find((tool) => tool.name === 'analyze_kalshi_market_url')
  const analyzeResult = await analyze.handler({ url: 'https://kalshi.com/markets/x' })
  assert.equal(analyzeResult.structuredContent.title, 'Yankees at Red Sox')
  assert.equal(analyzeResult.structuredContent.ticker, 'KXMLB-TEST')
  assert.match(analyzeResult.structuredContent.price_context, /display-only/)
  assert.match(analyzeResult.structuredContent.model_read, /rate higher/i)
  assert.doesNotMatch(textPayload(analyzeResult), BANNED_CUSTOMER_TEXT)
  assert.doesNotMatch(textPayload(analyzeResult), LOCAL_PATH_RE)

  const mentions = tools.find((tool) => tool.name === 'mentions_research')
  const mentionsResult = await mentions.handler({ event_ticker: 'KXTRUMP' })
  assert.match(mentionsResult.structuredContent.title, /Mentions research for KXTRUMP/)
  assert.equal(mentionsResult.structuredContent.ticker, 'KXTRUMP')
  assert.match(mentionsResult.structuredContent.price_context, /display-only/)
  assert.doesNotMatch(textPayload(mentionsResult), BANNED_CUSTOMER_TEXT)
  assert.doesNotMatch(textPayload(mentionsResult), LOCAL_PATH_RE)

  const composite = tools.find((tool) => tool.name === 'run_composite_model')
  const compositeResult = await composite.handler({ url: 'https://kalshi.com/markets/mlb' })
  assert.equal(compositeResult.structuredContent.title, 'Yankees at Red Sox')
  assert.match(compositeResult.structuredContent.price_context, /display-only/)
  assert.doesNotMatch(textPayload(compositeResult), BANNED_CUSTOMER_TEXT)
  assert.doesNotMatch(textPayload(compositeResult), LOCAL_PATH_RE)

  const sports = tools.find((tool) => tool.name === 'sports_preview')
  const sportsResult = await sports.handler({ sport: 'ufc', date: '2026-06-20' })
  assert.match(sportsResult.structuredContent.title, /UFC preview/)
  assert.match(sportsResult.structuredContent.price_context, /display-only/)
  assert.doesNotMatch(textPayload(sportsResult), BANNED_CUSTOMER_TEXT)
  assert.doesNotMatch(textPayload(sportsResult), LOCAL_PATH_RE)

  const earnings = tools.find((tool) => tool.name === 'earnings_mention_research')
  const earningsResult = await earnings.handler({ event_id: 'KXEARN' })
  assert.match(earningsResult.structuredContent.title, /Earnings mention research for KXEARN/)
  assert.match(earningsResult.structuredContent.price_context, /display-only/)
  assert.doesNotMatch(textPayload(earningsResult), LOCAL_PATH_RE)
})

test('card helper renders human-readable fields before ids', () => {
  const card = buildCpcCardSummary({
    title: 'Yankees at Red Sox - CPC rates Yankees higher',
    subtitle: 'New York vs Boston moneyline',
    plainEnglish: 'This card asks whether New York or Boston should be treated as the primary side.',
    settlement: 'YES settles if the selected team wins the game.',
    route: 'mlb_composite/moneyline',
    cpcRead: 'LEAN',
    cpcReadText: 'Yankees rate higher than Red Sox.',
    evidenceStatus: 'provisional',
    baseRate: { sample_size: 48, hit_rate: 0.58, tier: 'A' },
    priceContext: 'Price context: display-only and not used in scoring.',
    ticker: 'KXMLB-2026-NYY',
    marketId: 'KXMLB-2026-NYY',
    eventId: 'KXMLBGAME-2026',
  })
  const text = renderCpcCardText(card)
  assert.match(text, /Big title: Yankees at Red Sox - CPC rates Yankees higher/)
  assert.match(text, /Plain English:/)
  assert.match(text, /Settlement:/)
  assert.match(text, /Route: mlb_composite\/moneyline/)
  assert.match(text, /CPC Read: Yankees rate higher than Red Sox\./)
  assert.match(text, /Evidence status: provisional/)
  assert.match(text, /Base rate: n=48, hit_rate=0.58, tier=A/)
  assert.match(text, /Price context: Price context: display-only and not used in scoring\./)
  assert.match(text, /Ticker\/market ID: KXMLB-2026-NYY/)
  assert.doesNotMatch(text, /Big title: KXMLB-2026-NYY/)
})

test('stack helper renders rank, meaning, posture, and price context', () => {
  const item = buildCpcStackItem({
    rank: 1,
    title: 'Yankees at Red Sox - CPC rates Yankees higher',
    plainEnglish: 'The model prefers New York.',
    route: 'mlb_composite/moneyline',
    cpcRead: 'LEAN',
    cpcReadText: 'Yankees rate higher than Red Sox.',
    evidenceStatus: 'provisional',
    baseRate: { sample_size: 48, hit_rate: 0.58, tier: 'A' },
    priceContext: 'Price context: display-only and not used in scoring.',
    ticker: 'KXMLB-2026-NYY',
    reason: 'Starter matchup and form support the side.',
  })
  const text = renderCpcStackText([item])
  assert.match(text, /#1 Yankees at Red Sox - CPC rates Yankees higher/)
  assert.match(text, /Plain English: The model prefers New York\./)
  assert.match(text, /Route: mlb_composite\/moneyline/)
  assert.match(text, /Base rate: n=48, hit_rate=0.58, tier=A/)
  assert.match(text, /Evidence status: provisional/)
  assert.match(text, /CPC Read: Yankees rate higher than Red Sox\./)
  assert.match(text, /Reason: Starter matchup and form support the side\./)
  assert.match(text, /Price context: Price context: display-only and not used in scoring\./)
})

test('price context remains display-only in card formatting', () => {
  const a = buildCpcCardSummary({
    title: 'Yankees at Red Sox - CPC rates Yankees higher',
    plainEnglish: 'This card asks whether New York or Boston should be treated as the primary side.',
    settlement: 'YES settles if the selected team wins the game.',
    route: 'mlb_composite/moneyline',
    cpcRead: 'LEAN',
    cpcReadText: 'Yankees rate higher than Red Sox.',
    evidenceStatus: 'provisional',
    priceContext: 'Price context: display-only and not used in scoring.',
  })
  const b = buildCpcCardSummary({
    title: 'Yankees at Red Sox - CPC rates Yankees higher',
    plainEnglish: 'This card asks whether New York or Boston should be treated as the primary side.',
    settlement: 'YES settles if the selected team wins the game.',
    route: 'mlb_composite/moneyline',
    cpcRead: 'LEAN',
    cpcReadText: 'Yankees rate higher than Red Sox.',
    evidenceStatus: 'provisional',
    priceContext: 'Price context: display-only and not used in scoring. Alternate display note.',
  })
  assert.equal(a.cpc_read, b.cpc_read)
  assert.equal(a.evidence_status, b.evidence_status)
  assert.notEqual(a.price_context, b.price_context)
})

test('shared card helpers keep plain-English meaning, price display-only, and ids secondary', () => {
  const card = buildCpcCardSummary({
    title: 'Yankees at Red Sox - CPC rates Yankees higher',
    subtitle: 'New York vs Boston moneyline',
    plainEnglish: 'This card asks whether New York or Boston should be treated as the primary side.',
    settlement: 'YES settles if the selected team wins the game.',
    route: 'mlb_composite/moneyline',
    cpcRead: 'LEAN',
    cpcReadText: 'Yankees rate higher than Red Sox.',
    evidenceStatus: 'provisional',
    baseRate: { sample_size: 48, hit_rate: 0.58, tier: 'A' },
    priceContext: 'Price context: display-only and not used in scoring.',
    ticker: 'KXMLB-2026-NYY',
    marketId: 'KXMLB-2026-NYY',
    eventId: 'KXMLBGAME-2026',
    reason: 'Starter matchup and form support the side.',
  })
  const stack = buildCpcStackItem({
    rank: 1,
    title: 'Yankees at Red Sox - CPC rates Yankees higher',
    plainEnglish: 'The model prefers New York.',
    route: 'mlb_composite/moneyline',
    cpcRead: 'LEAN',
    cpcReadText: 'Yankees rate higher than Red Sox.',
    evidenceStatus: 'provisional',
    priceContext: 'Price context: display-only and not used in scoring.',
    ticker: 'KXMLB-2026-NYY',
    reason: 'Starter matchup and form support the side.',
  })
  const outputs = [renderCpcCardText(card), renderCpcStackText([stack])]

  for (const output of outputs) {
    assert.match(output, /Plain English:/)
    assert.match(output, /CPC Read:/)
    assert.match(output, /Price context:/)
    assert.match(output, /Ticker\/market ID:/)
    assert.doesNotMatch(output, LOCAL_PATH_RE)
  }
})
