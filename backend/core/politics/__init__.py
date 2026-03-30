"""
Politics prediction market package.

App map (V1):
  mentions_app  — markets that resolve on whether a phrase/word was SAID
  politics_app  — markets that resolve on who wins / what happens / outcomes

Routing rule:
  If resolution criterion is linguistic (exact phrase, said/mentioned in a venue)
    → mentions_app
  If resolution criterion is an event outcome (election result, chamber control,
    policy passage, geopolitical event)
    → politics_app

worldmonitor is the upstream intelligence layer:
  Perplexity-backed ingest → entity clustering → narrative synthesis
  worldmonitor feeds context INTO the alpha engines — it does NOT price or route.
"""
