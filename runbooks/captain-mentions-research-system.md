# Captain Mentions Research Runbook

Use this runbook when the user sends a mentions market research plan and exact link, then asks for picks or a Captain guide.

## Assets to load

Skills:
- captain-mentions-research-system
- captain-mixmcp-calibration
- mentions-market-picks
- research-source-scraping
- market-research-discovery-and-verification
- kalshi-market-routing-and-board-state
- captain-x-article-guide only when writing a public guide

Agents:
- controller
- mentions-researcher
- mentions-mcp-forecaster
- oracle
- captain-x-writer only after the internal packet is complete

## Sequence

1. Controller scope gate
   - exact URL only
   - board vs contract
   - market type
   - required proof
   - missing price/source inputs

2. Mentions researcher (two parallel searches — run simultaneously)

   Transcript frequency search:
   - parse rules: eligible speaker, event window, resolution source, exact-string requirements
   - capture strikes and prices from board
   - use Firecrawl / Jina / Crawl4AI for official source discovery and scraping
   - earnings: fetch last 4 quarters of transcripts (all 4 required)
   - count exact word frequency per keyword per transcript
   - build hit rate table: | Keyword | Q1 | Q2 | Q3 | Q4 | Notes | (✓(N) or X)
   - map aliases: what counts, what doesn't
   - identify prepared-remarks vs Q&A path per keyword
   - build prompt-force and paraphrase-risk maps

   Context search (MANDATORY — every event type, every run):
   - for each keyword: why is this word on the board?
   - search company/speaker news last 90 days
   - identify the event/launch/deal/regulatory action that put each word in play
   - determine prepared path vs Q&A-only path
   - flag avoidance risk (has speaker recently stopped using this word?)
   - output one context driver line per keyword

3. Mentions MCP forecaster
   - p_mkt from YES¢
   - p_mcp from evidence posterior
   - alpha from event type/price band/evidence quality
   - p_mix and Mix TV
   - TV/edge/LSP/max entry
   - trade gate

4. Oracle
   - review trade gate
   - choose TRADE / WATCH LIVE / NO TRADE / FADE SPIKE / NEEDS PROOF
   - add confidence, how it loses, live triggers, correlation-stack exposure notes

5. Captain X writer, only if requested
   - convert completed packet into public guide
   - no sources inside article body
   - code-box tables
   - required sections A-G
   - Buy Me a Coffee line
   - exact signoff

## Internal output packet

Before final public writing, produce:

1. Event Snapshot
2. Contract / Rule Mechanics
3. Primary Sources
4. Transcript Collection Plan
5. Strict Word-Match Grid
6. Context Driver Log
7. Why This Word Exists Log
8. Prompt-Force Map
9. Paraphrase / Dodge Map
10. Market Prior Board
11. Evidence TV Board
12. MCP Forecast Board
13. MixMCP Final TV Board
14. Trade Gate
15. Live Playbook
16. Correlation Stacks
17. Settlement Proof Plan
18. Backtest / Calibration Log

## Hard gates

- No exact URL: ask for exact URL.
- No current price: research allowed, trade pick not final.
- No rules/source: NEEDS PROOF.
- Topic likely but exact word shaky: WATCH LIVE or NO TRADE.
- Analyst/moderator/guest-only path: NO TRADE unless rules allow.
- Market is board-level: inventory children before selecting picks.
- Public article: never invent picks beyond the internal trade gate.
