import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildResearchTools } from '../src/researchTools.js'
const LOCAL_PATH_RE = /(?:^|[^\w])\/(?:tmp|home|var|Users)\/[^\s"]+/i

function getTool(name, opts) {
  const tool = buildResearchTools(opts).find((t) => t.name === name)
  assert.ok(tool, `tool ${name} should be registered`)
  return tool
}

test('registers all research tools', () => {
  const names = buildResearchTools().map((t) => t.name)
  assert.deepEqual(names, [
    'analyze_kalshi_market_url',
    'mentions_research',
    'earnings_mention_research',
    'settled_event_history',
    'run_composite_model',
    'mlb_sports_preview',
    'sports_preview',
  ])
})

test('analyze returns full plan by default and short card when compact', async () => {
  const composite = getTool('analyze_kalshi_market_url', {
    marketLinkAnalyzer: async () => ({
      handled: true,
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
          source_summary: 'Kalshi market card',
        },
      },
      full: 'lots',
    }),
  })
  const full = await composite.handler({ url: 'https://kalshi.com/x' })
  assert.equal(full.structuredContent.title, 'Yankees at Red Sox')
  assert.equal(full.structuredContent.ticker, 'KXMLB-TEST')
  assert.match(full.structuredContent.price_context, /display-only/)
  assert.doesNotMatch(full.content[0].text, /lots/)

  const short = await composite.handler({ url: 'https://kalshi.com/x', compact: true })
  assert.equal(short.structuredContent.title, 'Yankees at Red Sox')
  assert.match(short.content[0].text, /Yankees at Red Sox/)
})

// ---- General mentions (all families) ----

test('mentions_research renders the full packet via the daily engine (all families)', async () => {
  const tool = getTool('mentions_research', {
    onlyResolver: async ({ tickers }) => ({
      allEvents: [{ event_ticker: tickers[0] }],
      allPrimeAttempts: [],
    }),
    packetWriter: async () => ({
      items: [{ name: 'KXTRUMP', previewText: 'FULL TRUMP MENTION PACKET\nrow 1' }],
      failedTickers: [],
    }),
  })
  const res = await tool.handler({ event_ticker: 'KXTRUMP' })
  assert.equal(res.isError, undefined)
  assert.match(res.structuredContent.title, /Mentions research for KXTRUMP/)
  assert.equal(res.structuredContent.ticker, 'KXTRUMP')
  assert.match(res.structuredContent.price_context, /display-only/)
  assert.match(res.structuredContent.plain_english, /fresh source-backed mentions research/i)
  assert.match(res.structuredContent.source_summary, /daily dry-run route/i)
  assert.doesNotMatch(JSON.stringify(res.structuredContent), /FULL TRUMP MENTION PACKET/)
  assert.doesNotMatch(res.content[0].text, /FULL TRUMP MENTION PACKET/)
})

test('mentions_research fails closed when no usable packet is produced', async () => {
  const tool = getTool('mentions_research', {
    onlyResolver: async ({ tickers }) => ({ allEvents: [{ event_ticker: tickers[0] }], allPrimeAttempts: [] }),
    packetWriter: async () => ({ items: [], failedTickers: ['KXNOPE'] }),
  })
  const res = await tool.handler({ event_ticker: 'KXNOPE' })
  assert.equal(res.isError, true)
  assert.match(res.structuredContent.blocked_reason, /no app-safe card/i)
  assert.match(res.content[0].text, /Blocked:/)
})

test('mentions_research marks evidence thin when related events are missing source coverage', async () => {
  const tool = getTool('mentions_research', {
    onlyResolver: async ({ tickers }) => ({
      allEvents: [{ event_ticker: tickers[0] }],
      allPrimeAttempts: [],
    }),
    packetWriter: async () => ({
      items: [{ name: 'KXPART', previewText: 'PACKET' }],
      failedTickers: ['KXMISS'],
    }),
  })
  const res = await tool.handler({ event_ticker: 'KXPART' })
  assert.equal(res.isError, undefined)
  assert.equal(res.structuredContent.evidence_status, 'thin')
  assert.match(res.structuredContent.warnings.join(' '), /Missing source coverage for 1 event/i)
  assert.match(res.structuredContent.source_summary, /daily dry-run route/i)
})

test('mentions_research fails closed when the event is not found', async () => {
  const tool = getTool('mentions_research', {
    onlyResolver: async () => ({ allEvents: [], allPrimeAttempts: [] }),
    packetWriter: async () => ({ items: [], failedTickers: [] }),
  })
  const res = await tool.handler({ event_ticker: 'KXGHOST' })
  assert.equal(res.isError, true)
  assert.match(res.structuredContent.blocked_reason, /not found/)
  assert.doesNotMatch(JSON.stringify(res.structuredContent), LOCAL_PATH_RE)
})

test('mentions_research requires an event id or url', async () => {
  const tool = getTool('mentions_research')
  const res = await tool.handler({})
  assert.equal(res.isError, true)
  assert.match(res.structuredContent.blocked_reason, /event_ticker|event_url/)
})

// ---- Earnings-only mention path ----

test('earnings_mention_research returns full packet text and fails closed on error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-earn-'))
  const packetPath = join(dir, 'KXEARN.txt')
  writeFileSync(packetPath, 'EARNINGS PACKET BODY', 'utf8')
  const ok = getTool('earnings_mention_research', {
    earningsMentionRunner: async () => ({
      packetPath,
      route: { route: 'earnings_call' },
      janitor: { verdict: 'pass' },
      sanitized: { source_urls: ['a'] },
    }),
  })
  const okRes = await ok.handler({ event_id: 'KXEARN' })
  assert.equal(okRes.isError, undefined)
  assert.equal(okRes.structuredContent.ticker, 'KXEARN')
  assert.match(okRes.structuredContent.price_context, /display-only/)
  assert.match(okRes.structuredContent.source_summary, /1 declared source URL/i)
  assert.doesNotMatch(JSON.stringify(okRes.structuredContent), LOCAL_PATH_RE)
  assert.doesNotMatch(okRes.content[0].text, /EARNINGS PACKET BODY/)

  const missing = getTool('earnings_mention_research', {
    earningsMentionRunner: async () => ({
      packetPath,
      route: { route: 'earnings_call' },
      janitor: { verdict: 'pass' },
      sanitized: { source_urls: [] },
    }),
  })
  const missingRes = await missing.handler({ event_id: 'KXEARN' })
  assert.equal(missingRes.isError, true)
  assert.match(missingRes.structuredContent.blocked_reason, /no declared source URLs/i)

  const fail = getTool('earnings_mention_research', {
    earningsMentionRunner: async () => { throw new Error('perplexity unavailable') },
  })
  const failRes = await fail.handler({ event_id: 'KXEARN' })
  assert.equal(failRes.isError, true)
  assert.match(failRes.structuredContent.blocked_reason, /perplexity unavailable/)
})

// ---- Settled history family routing ----

test('settled_event_history generic path returns a price-free artifact', async () => {
  const tool = getTool('settled_event_history')
  const res = await tool.handler({ series_ticker: 'KXDOESNOTEXIST' })
  assert.equal(res.isError, undefined)
  assert.match(res.structuredContent.title, /Settled history/)
  assert.match(res.structuredContent.plain_english, /price-free/i)
  assert.match(res.structuredContent.price_context, /display-only/i)
  assert.doesNotMatch(JSON.stringify(res.structuredContent), /\b(bid|ask|volume)\b/i)
})

test('settled_event_history earnings family needs an entity', async () => {
  const tool = getTool('settled_event_history')
  const res = await tool.handler({ family: 'earnings' })
  assert.equal(res.isError, true)
  assert.match(res.structuredContent.blocked_reason, /entity/)
})

// ---- Composite ----

test('run_composite_model returns full board, card when compact, and surfaces blocked', async () => {
  const board = {
    ok: true,
    handled: true,
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
    composite: { away_score: 4.1 },
  }
  const tool = getTool('run_composite_model', { marketLinkAnalyzer: async () => board })
  const full = await tool.handler({ url: 'https://kalshi.com/markets/mlb' })
  assert.equal(full.structuredContent.title, 'Yankees at Red Sox')
  assert.match(full.structuredContent.price_context, /display-only/)

  const compact = await tool.handler({ url: 'https://kalshi.com/markets/mlb', compact: true })
  assert.equal(compact.structuredContent.title, 'Yankees at Red Sox')
  assert.match(compact.content[0].text, /Yankees at Red Sox/)

  const blocked = getTool('run_composite_model', { marketLinkAnalyzer: async () => ({ ok: false, reason: 'game_context_missing' }) })
  const res = await blocked.handler({ url: 'https://kalshi.com/markets/mlb' })
  assert.equal(res.isError, true)
  assert.match(res.structuredContent.blocked_reason, /game_context_missing/)
  assert.match(res.content[0].text, /Blocked:/)
})

// ---- Sport previews ----

test('sports_preview returns the banked packet and fails closed when none exists', async () => {
  const ok = getTool('sports_preview', { sportsRunner: () => ({ text: 'UFC WEEKLY PACKET', file: '2026-06-20-ufc.txt' }) })
  const okRes = await ok.handler({ sport: 'ufc', date: '2026-06-20' })
  assert.equal(okRes.isError, undefined)
  assert.match(okRes.structuredContent.title, /UFC preview/)
  assert.match(okRes.structuredContent.price_context, /display-only/)
  assert.doesNotMatch(JSON.stringify(okRes.structuredContent), /2026-06-20-ufc\.txt/)
  assert.doesNotMatch(okRes.content[0].text, /2026-06-20-ufc\.txt/)

  const none = getTool('sports_preview', { sportsRunner: () => ({ text: null }) })
  const noneRes = await none.handler({ sport: 'worldcup', date: '2026-06-20' })
  assert.equal(noneRes.isError, true)
  assert.match(noneRes.structuredContent.blocked_reason, /no worldcup packet/i)
})

test('sports_preview returns a structured World Cup preview card', async () => {
  const tool = getTool('sports_preview', {
    sportsRunner: async () => ({ text: 'WORLD CUP MATCHDAY PACKET' }),
  })
  const res = await tool.handler({ sport: 'worldcup', date: '2026-06-23' })
  assert.equal(res.isError, undefined, res.content?.[0]?.text)
  assert.match(res.structuredContent.title, /WORLDCUP preview/i)
  assert.match(res.structuredContent.source_summary, /latest banked sport preview packet/i)
  assert.match(res.structuredContent.price_context, /display-only/i)
})

test('sports_preview match filter stays scoped and fails cleanly on a miss', async () => {
  const tool = getTool('sports_preview', {
    sportsRunner: async ({ match }) => (
      match === 'portugal-uzbekistan'
        ? { text: 'PORTUGAL UZBEKISTAN PACKET' }
        : { text: null }
    ),
  })
  const res = await tool.handler({ sport: 'worldcup', date: '2026-06-23', match: 'portugal-uzbekistan' })
  assert.equal(res.isError, undefined, res.content?.[0]?.text)
  assert.match(res.structuredContent.title, /WORLDCUP preview/i)
  assert.match(res.structuredContent.warnings.join(' '), /Filtered to portugal-uzbekistan/i)

  const miss = await tool.handler({ sport: 'worldcup', date: '2026-06-23', match: 'nonexistent-match' })
  assert.equal(miss.isError, true)
  assert.match(miss.structuredContent.blocked_reason, /matching "nonexistent-match"/)
})
