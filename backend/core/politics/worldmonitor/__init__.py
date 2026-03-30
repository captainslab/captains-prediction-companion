"""
worldmonitor — upstream intelligence ingest layer for politics markets.

Role: research, entity detection, narrative synthesis, polling aggregation.
NOT responsible for: routing, pricing, EV calculation, Kelly sizing.

Data flow:
  PoliticsIntelIngest.fetch(market_id, title, description)
    → Perplexity search queries (research layer)
    → EntityClusterer.cluster(raw_results)
    → NarrativeEngine.synthesize(entities, results)
    → PoliticsIntelReport
"""
