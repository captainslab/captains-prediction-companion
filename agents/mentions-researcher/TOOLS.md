# Mentions Researcher Tools

Allowed actions:
- read repo docs, prompts, runbooks, state, and operator files
- inspect exact Kalshi board/contract URLs supplied by the user
- use Firecrawl for source discovery and scraping
- search official transcript/replay/rules/filing/source pages
- create temporary evidence files under `.firecrawl/` or `/tmp/firecrawl-*`
- summarize source packets for oracle
- recommend next smallest source check

Preferred sources:
- Kalshi market page and rules
- official transcript or official video/replay
- company investor-relations pages and SEC filings for earnings markets
- agency/government transcript archives for official/political markets
- Fed/FOMC pages for Fed markets
- league/team/official broadcast sources for sports markets
- secondary sources only as navigation leads

Do not:
- make YES/NO picks
- fabricate or estimate current prices without a live/user-provided quote
- use social/news chatter as settlement proof
- expose secrets from `.env` or private files
- edit app runtime code unless explicitly tasked
- broaden analysis to adjacent markets

Firecrawl reminder:
- source `~/.hermes/.env` before Firecrawl terminal calls
- write auditable outputs to `.firecrawl/` or `/tmp/firecrawl-*`
- inspect output before citing it
