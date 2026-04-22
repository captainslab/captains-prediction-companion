# Hermes Kalshi Mention Research Packet

objective:
Run a Hermes-backed research pass for a single Kalshi mention board and return a board-first evidence record.

scope_in:
- one Kalshi board URL
- one selected child contract at a time
- official source discovery
- transcript or video verification
- proof-backed recommendation

scope_out:
- UI changes
- pricing-only analysis without evidence
- social/news commentary as settlement proof
- guessing when the official source is missing

controller_rules:
- Treat the Kalshi board, rules, and official source as the source of truth.
- If the URL is a board URL, identify the loaded child contracts before selecting one contract to inspect.
- Do not finalize a recommendation until the researcher returns direct source proof.
- Do not accept summaries without an official source URL and exact excerpt.
- One exploration round only.
- Reject any answer that is not backed by file evidence or source evidence.

researcher_rules:
- Find the official Kalshi board/rules page first.
- Identify the exact child contract ticker and phrase being tested.
- Locate the controlling official source named by the rules.
- Extract the exact transcript/video excerpt that supports or falsifies the phrase.
- Note speaker-scope risk, excluded-segment risk, and any rule ambiguity.
- Use secondary sources only to locate the official source, never as settlement proof.
- Return facts first, no fake certainty, no market commentary masquerading as evidence.

required_output:
{
  "board_url": "string",
  "board_headline": "string",
  "board_recommendation": "buy_yes|buy_no|pass|watch",
  "board_confidence": "low|medium|high",
  "child_contracts": [
    {
      "ticker": "string",
      "label": "string",
      "yes_bid": "number|null",
      "yes_ask": "number|null",
      "last_price": "number|null",
      "source_url": "string|null",
      "transcript_excerpt": "string|null",
      "phrase_found": "true|false|null",
      "evidence": ["string"]
    }
  ],
  "board_no_edge_reason_code": "string|null",
  "board_no_edge_reason": "string|null"
}

proof_requirements:
- official source URL
- exact transcript/video excerpt or a clear statement that the phrase was not found
- selected child contract ticker
- the board URL used for research
- file paths if the result is written back into the repo

execution_notes:
- If the board contains multiple child contracts, the controller must choose one contract to drill into before the final report.
- If evidence is incomplete, the result should be pass or watch rather than a fabricated edge.
- Keep the report board-first and nest child contracts beneath the board record.
