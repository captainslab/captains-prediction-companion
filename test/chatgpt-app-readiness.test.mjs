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
    notes: { stats: () => ({ count: 0 }) },
    enableNoteTools: false,
  })
  assert.equal(status.structuredContent.readOnlyDefault, true)
  assert.equal(status.structuredContent.noteToolsEnabled, false)
  assert.ok(Array.isArray(status.structuredContent.toolNames))
  assert.doesNotMatch(JSON.stringify(status.structuredContent), /GEMINI_API_KEY|TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|\.env|~\/\.config/i)
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
  for (const tool of buildResearchTools()) {
    assert.equal(tool.config.annotations?.readOnlyHint, true, `${tool.name} must be read-only`)
  }
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

test('MLB and sport packet renderers use human-readable CPC Read language', () => {
  const mlb = buildKalshiGamePacket({
    date: '2026-06-14',
    event: {
      event_ticker: 'KXMLBGAME-TEST',
      title: 'New York Yankees at Boston Red Sox',
      away_full: 'New York Yankees',
      home_full: 'Boston Red Sox',
      start_time_utc: '2026-06-14T20:10:00Z',
      venue: 'Fenway Park',
      markets: [
        { ticker: 'KXMLBGAME-TEST-NYY', title: 'Yankees Win', yes_sub_title: 'Yankees', rules_primary: 'Yankees win', yes_bid_dollars: 0.55, yes_ask_dollars: 0.57 },
      ],
    },
    gamePicks: [
      {
        primary_pick: true,
        market_ticker: 'KXMLBGAME-TEST-NYY',
        contract_title: 'Yankees Win',
        classification: 'LEAN',
        fair_value: 0.58,
        edge_pp: 6.5,
        market_lane: 'moneyline',
        reason: 'Current source-backed model grades this side better.',
      },
    ],
    statsRecord: {
      away_team: 'New York Yankees',
      home_team: 'Boston Red Sox',
      away_pitcher: { name: 'Gerrit Cole' },
      home_pitcher: { name: 'Brayan Bello' },
    },
    leagueRPG: 4.5,
    sourceRefs: {},
  })

  const nascar = buildRacePacket({
    date: '2026-06-14',
    event: {
      event_ticker: 'KXNASCAR-TEST',
      title: 'Michigan 400 Winner',
      product_metadata: { competition: 'NASCAR Cup Series' },
      markets: [{
        ticker: 'KXNASCAR-D1',
        yes_sub_title: 'Driver 1',
        yes_bid_dollars: 0.05,
        yes_ask_dollars: 0.07,
        last_price_dollars: 0.06,
        volume_fp: 1000,
        open_interest_fp: 2000,
        rules_primary: 'Wins the race',
      }],
    },
    sourcePath: '/tmp/test.json',
    artifacts: [],
    workspaceResult: null,
  })

  const ufc = buildUfcKalshiPacket({
    event: {
      event_ticker: 'KXUFC-TEST',
      title: 'UFC 310',
      sub_title: 'Main Card',
      series_ticker: 'KXUFC',
      markets: [
        { ticker: 'KXUFC-TEST-A', title: 'Fighter A', yes_sub_title: 'Fighter A', yes_bid_dollars: 0.60, yes_ask_dollars: 0.62, volume_fp: 500 },
      ],
    },
    dates: ['2026-06-14', '2026-06-15'],
    sourcePath: '/tmp/ufc.json',
  })

  const mlbSlate = buildMlbSlatePacket({
    date: '2026-06-14',
    scoring: {
      picks: [{
        market_ticker: 'KXMLB-TEST',
        game: 'NYY at BOS',
        classification: 'LEAN',
        fair_value: 0.55,
        kalshi_ask: 0.48,
        kalshi_bid: 0.46,
        edge_pp: 7.0,
        gates_passed: ['starters', 'lineups', 'weather'],
        missing_confirmations: [],
        market_lane: 'moneyline',
      }],
      source: '/tmp/picks.json',
      summaryCounts: { lean: 1 },
    },
  })

  const mentionInput = {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-06-14',
    event: {
      title: 'Test Event',
      subtitle: null,
      date_time: '2026-06-14T20:00:00Z',
      settlement_source_link: 'https://kalshi.com/events/TEST',
      rules_primary: 'test rules',
    },
    synthesis_rules: {
      output_style: 'concise',
      research_only: true,
      no_trade: true,
      model_written_final_packet_allowed: false,
      use_full_strike_text_only: true,
      market_context_not_in_score: true,
      all_terms_proximity_only: false,
    },
    summary: { market_count: 2, source_backed_count: 1 },
    terms: [
      {
        full_strike_text: 'Test Event -- Alpha',
        short_term: 'Alpha',
        cpc_score: 65,
        bucket: 'most-likely',
        evidence_status: 'source evidence present: transcript, historical_tendency',
        layers_present: ['transcript', 'historical_tendency'],
        composite_posture: 'LEAN',
        missing_research_layers: ['topic_path'],
        upgrade_trigger: 'confirm exact settlement wording',
        market_context: { implied: 0.35, bid_cents: 33, ask_cents: 37, note: 'NOT IN SCORE' },
      },
    ],
    deterministic_provenance_lines: ['research_route: political_speech'],
  }
  const mentions = renderMentionPacket(mentionInput, { generatedAtUtc: '2026-06-14T12:00:00Z', analystTier: 'none' })
  validateCpcCustomerPacket(mentions)

  for (const output of [mlb.text, nascar.text, ufc.text, mlbSlate.text, mentions]) {
    assert.doesNotMatch(output, BANNED_CUSTOMER_TEXT)
  }
  assert.match(mlb.text, /CPC Read/)
  assert.match(mlb.text, /Model Read/)
  assert.match(mlb.text, /New York Yankees/)
  assert.match(mlb.text, /Boston Red Sox/)
  assert.match(nascar.text, /BLOCKED_MODEL_LAYER_MISSING/)
  assert.match(ufc.text, /Market Context - NOT IN SCORE/)
  assert.match(mentions, /CPC Read|Model Read|Price context/)
})
