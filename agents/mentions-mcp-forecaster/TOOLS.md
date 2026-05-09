# Mentions MCP Forecaster Tools

Allowed actions:
- read completed mentions research packets
- inspect current prices when available
- calculate p_mkt, p_mcp, alpha, Mix TV, edge, LSP, and max entry
- maintain forecast/backtest rows in operator files when asked
- return trade gate outputs to oracle/controller

Preferred inputs:
- evidence packet from agents/mentions-researcher
- rules/source status
- current bid/ask or user-provided price
- event type and evidence quality

Do not:
- use Firecrawl directly unless asked to fill a missing source gap
- make claims about transcripts not present in the evidence packet
- fabricate missing prices
- output public guide copy
- ignore edge thresholds
