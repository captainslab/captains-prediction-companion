import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildResearchTools } from '../src/researchTools.js'

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
    marketLinkAnalyzer: async () => ({ handled: true, compact_card: { headline: 'short' }, full: 'lots' }),
  })
  const full = await composite.handler({ url: 'https://kalshi.com/x' })
  assert.equal(full.structuredContent.handled, true)
  assert.match(full.content[0].text, /lots/)

  const short = await composite.handler({ url: 'https://kalshi.com/x', compact: true })
  assert.deepEqual(short.structuredContent, { headline: 'short' })
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
  assert.match(res.content[0].text, /FULL TRUMP MENTION PACKET/)
  assert.equal(res.structuredContent.event_ticker, 'KXTRUMP')
})

test('mentions_research fails closed when no usable packet is produced', async () => {
  const tool = getTool('mentions_research', {
    onlyResolver: async ({ tickers }) => ({ allEvents: [{ event_ticker: tickers[0] }], allPrimeAttempts: [] }),
    packetWriter: async () => ({ items: [], failedTickers: ['KXNOPE'] }),
  })
  const res = await tool.handler({ event_ticker: 'KXNOPE' })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /fail-closed/)
})

test('mentions_research fails closed when the event is not found', async () => {
  const tool = getTool('mentions_research', {
    onlyResolver: async () => ({ allEvents: [], allPrimeAttempts: [] }),
    packetWriter: async () => ({ items: [], failedTickers: [] }),
  })
  const res = await tool.handler({ event_ticker: 'KXGHOST' })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /not found/)
})

test('mentions_research requires an event id or url', async () => {
  const tool = getTool('mentions_research')
  const res = await tool.handler({})
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /event_ticker|event_url/)
})

// ---- Earnings-only mention path ----

test('earnings_mention_research returns full packet text and fails closed on error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-earn-'))
  const packetPath = join(dir, 'KXEARN.txt')
  writeFileSync(packetPath, 'EARNINGS PACKET BODY', 'utf8')
  const ok = getTool('earnings_mention_research', {
    earningsMentionRunner: async () => ({ packetPath, route: { route: 'earnings_call' }, janitor: { verdict: 'pass' }, sanitized: { source_urls: ['a'] } }),
  })
  const okRes = await ok.handler({ event_id: 'KXEARN' })
  assert.match(okRes.content[0].text, /EARNINGS PACKET BODY/)

  const fail = getTool('earnings_mention_research', {
    earningsMentionRunner: async () => { throw new Error('perplexity unavailable') },
  })
  const failRes = await fail.handler({ event_id: 'KXEARN' })
  assert.equal(failRes.isError, true)
  assert.match(failRes.content[0].text, /fail-closed/)
})

// ---- Settled history family routing ----

test('settled_event_history generic path returns a price-free artifact', async () => {
  const tool = getTool('settled_event_history')
  const res = await tool.handler({ series_ticker: 'KXDOESNOTEXIST' })
  assert.equal(res.isError, undefined)
  assert.equal(res.structuredContent.usable, false)
  assert.doesNotMatch(JSON.stringify(res.structuredContent), /price|bid|ask|volume/i)
})

test('settled_event_history earnings family needs an entity', async () => {
  const tool = getTool('settled_event_history')
  const res = await tool.handler({ family: 'earnings' })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /entity/)
})

// ---- Composite ----

test('run_composite_model returns full board, card when compact, and surfaces blocked', async () => {
  const board = { ok: true, handled: true, compact_card: { headline: 'card only' }, composite: { away_score: 4.1 } }
  const tool = getTool('run_composite_model', { marketLinkAnalyzer: async () => board })
  const full = await tool.handler({ url: 'https://kalshi.com/markets/mlb' })
  assert.equal(full.structuredContent.composite.away_score, 4.1)

  const compact = await tool.handler({ url: 'https://kalshi.com/markets/mlb', compact: true })
  assert.deepEqual(compact.structuredContent, { headline: 'card only' })

  const blocked = getTool('run_composite_model', { marketLinkAnalyzer: async () => ({ ok: false, reason: 'game_context_missing' }) })
  const res = await blocked.handler({ url: 'https://kalshi.com/markets/mlb' })
  assert.equal(res.isError, false)
  assert.match(res.content[0].text, /game_context_missing/)
})

// ---- Sport previews ----

test('sports_preview returns the banked packet and fails closed when none exists', async () => {
  const ok = getTool('sports_preview', { sportsRunner: () => ({ text: 'UFC WEEKLY PACKET', file: '2026-06-20-ufc.txt' }) })
  const okRes = await ok.handler({ sport: 'ufc' })
  assert.match(okRes.content[0].text, /UFC WEEKLY PACKET/)
  assert.equal(okRes.structuredContent.file, '2026-06-20-ufc.txt')

  const none = getTool('sports_preview', { sportsRunner: () => ({ text: null }) })
  const noneRes = await none.handler({ sport: 'worldcup' })
  assert.equal(noneRes.isError, true)
  assert.match(noneRes.content[0].text, /no worldcup packet found/)
})

test('sports_preview reads a real banked World Cup matchday packet', async () => {
  // The WC cron has banked matchday boards under state/packets/<date>/worldcup-matchday/.
  const tool = getTool('sports_preview')
  const res = await tool.handler({ sport: 'worldcup', date: '2026-06-23' })
  assert.equal(res.isError, undefined, res.content?.[0]?.text)
  assert.ok(res.content[0].text.length > 50)
  assert.equal(res.structuredContent.sport, 'worldcup')
})

test('sports_preview match filter selects a single banked World Cup match packet', async () => {
  const tool = getTool('sports_preview')
  const res = await tool.handler({ sport: 'worldcup', date: '2026-06-23', match: 'portugal-uzbekistan' })
  assert.equal(res.isError, undefined, res.content?.[0]?.text)
  assert.match(res.structuredContent.file, /portugal-uzbekistan/)

  const miss = await tool.handler({ sport: 'worldcup', date: '2026-06-23', match: 'nonexistent-match' })
  assert.equal(miss.isError, true)
  assert.match(miss.content[0].text, /matching "nonexistent-match"/)
})
