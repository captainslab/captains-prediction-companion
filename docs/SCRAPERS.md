# SCRAPERS.md — Web Scraping Tools

Firecrawl is the primary scraper. When it's unavailable (credits exhausted, API down), fall through this stack in order.

---

## Scraper Stack (priority order)

| # | Tool | Best for | JS rendering | Cost |
|---|------|----------|-------------|------|
| 1 | **Firecrawl** | Everything — LLM-optimized markdown, SPAs | ✅ Full | Credits-based |
| 2 | **Jina AI Reader** | Quick scrapes, news articles, transcripts | ⚠️ Partial | Free (20 req/min) |
| 3 | **Crawl4AI** | JS-heavy pages, structured extraction | ✅ Full (Playwright) | Free, local |
| 4 | **trafilatura** | News articles, clean article body extraction | ❌ No | Free, local |
| 5 | **html2text** | Simple HTML pages, last resort | ❌ No | Free, local |

---

## Commands

### 1. Firecrawl (primary)
```bash
firecrawl scrape "<URL>" --only-main-content -o .firecrawl/output.md
firecrawl scrape "<URL>" --wait-for 3000 -o .firecrawl/output.md   # for JS pages
```

### 2. Jina AI Reader (first fallback — no install, just curl)
```bash
curl -s "https://r.jina.ai/<URL>" -o .firecrawl/output.md

# With API key for higher rate limit (500 req/min):
curl -s -H "Authorization: Bearer $JINA_API_KEY" "https://r.jina.ai/<URL>" -o .firecrawl/output.md
```
Returns clean markdown. No setup needed. Works immediately.

### 3. Crawl4AI (second fallback — handles JS)
```bash
python3 -c "
import asyncio, sys
from crawl4ai import AsyncWebCrawler

async def scrape(url):
    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(url)
        print(result.markdown)

asyncio.run(scrape(sys.argv[1]))
" "<URL>" > .firecrawl/output.md
```
Full Playwright browser — handles SPAs and JS-rendered pages like Kalshi.

### 4. trafilatura (article extraction)
```bash
trafilatura -u "<URL>" --markdown -o .firecrawl/output.md

# Or pipe from curl (for pages that need custom headers):
curl -s "<URL>" | trafilatura --markdown
```
Best for news articles and earnings transcripts. No JS support — use on static pages.

### 5. html2text (last resort)
```bash
curl -s "<URL>" | html2text > .firecrawl/output.md

# Save directly:
curl -s "<URL>" | python3 -m html2text > .firecrawl/output.md
```

---

## Google Docs Export (no scraper needed)

```bash
# Get document ID from the URL, then:
curl -L "https://docs.google.com/document/d/<DOC_ID>/export?format=txt" -o .firecrawl/doc.txt
curl -L "https://docs.google.com/document/d/<DOC_ID>/export?format=md"  -o .firecrawl/doc.md
```
Follows the redirect automatically with `-L`. No auth needed for public docs.

---

## Kalshi Market Pages

Kalshi renders via JS. Use tools with JS support:
- **Firecrawl** with `--wait-for 3000`
- **Jina** (partial — gets most content)
- **Crawl4AI** (full — best fallback for Kalshi)

```bash
# Kalshi with Jina:
curl -s "https://r.jina.ai/https://kalshi.com/markets/event/MARKET_ID" -o .firecrawl/market.md

# Kalshi with Crawl4AI:
python3 -c "
import asyncio
from crawl4ai import AsyncWebCrawler
async def scrape():
    async with AsyncWebCrawler() as c:
        r = await c.arun('https://kalshi.com/markets/event/MARKET_ID')
        print(r.markdown)
asyncio.run(scrape())
" > .firecrawl/market.md
```

---

## Installed on This VPS

```
firecrawl    — npm global (check credits: firecrawl --status)
jina         — curl only, no install needed
crawl4ai     — pip, version 0.8.6 (~/.local/lib/python3.12/)
trafilatura  — pip, CLI: trafilatura
html2text    — pip, CLI: html2text or python3 -m html2text
```

---

## Naming Convention

Always save to `.firecrawl/` regardless of which tool scraped it:
```
.firecrawl/{site}-{descriptor}.md
```
Examples: `.firecrawl/kalshi-hims-q1.md`, `.firecrawl/seekingalpha-delta-transcript.md`
