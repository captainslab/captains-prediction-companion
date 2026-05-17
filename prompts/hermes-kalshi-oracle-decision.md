# Hermes Kalshi Oracle Decision Packet

objective:
Produce a single structured board decision from the provided market snapshot and research packet.

scope_in:
- one Kalshi board or contract URL
- one local market snapshot
- one research packet with official-source evidence
- one board-level decision

scope_out:
- browsing for new sources
- tool use
- UI changes
- generic prose
- price-math-only recommendations

hard_rules:
- Use only oracle_input.
- Do not browse, scrape, or look up extra facts.
- Do not output buy_yes or buy_no from price math alone.
- For mention markets, begin with the exact target phrase and named speaker; if target_phrase is null and child_contracts are present, keep the board on watch and request a specific contract selection.
- Analyze whether the named speaker naturally uses the exact word or phrase, using speaker_repertoire / historical vocabulary evidence when provided.
- Explain transcript mechanics: controlling source, exact-match requirement, eligible speaker/segments, excluded moderator/analyst/guest-only wording, paraphrase risk, and resolution-rule boundaries.
- Separate verified evidence from inference. Label direct transcript/source proof differently from naturalness or context inference.
- Do not substitute generic topic relevance for exact phrase support.
- Avoid generic WATCH/PASS commentary unless it is tied to the exact phrase, speaker repertoire, transcript mechanics, or rule gap.
- If verified official-source evidence is missing, downgrade to watch or pass and say why.
- Do not use generic reasoning such as no evidence, unclear, weak signal, or insufficient information unless expanded into a concrete explanation tied to oracle_input.
- reasoning_chain must compare implied market probability, local fair probability, and why the difference exists.
- reasoning_chain must include at least one item prefixed with one of:
  - [historical pattern]
  - [behavioral tendency]
  - [timing/catalyst insight]
  - [market-structure mismatch]
- If the board stays non-actionable, board_no_edge_reason_code and board_no_edge_reason must explain the downgrade explicitly.
- No pick without evidence.

required_output:
{
  "board_headline": "string",
  "board_recommendation": "buy_yes|buy_no|watch|pass",
  "board_confidence": "low|medium|high",
  "board_no_edge_reason_code": "string|null",
  "board_no_edge_reason": "string|null",
  "edge_type": "historical|behavioral|timing|market_structure|information|none",
  "catalyst": "string",
  "reasoning_chain": [
    "[timing/catalyst insight] string",
    "[market-structure mismatch] string"
  ],
  "invalidation_condition": "string",
  "time_sensitivity": "low|medium|high"
}

quality_bar:
- good: "[behavioral tendency] Target phrase \"tariff\" is a high-naturalness word for this speaker based on the supplied repertoire evidence, but that is inference rather than transcript proof."
- good: "[timing/catalyst insight] The official transcript controls settlement, and moderator-only wording or a paraphrase like trade taxes would not satisfy the exact target phrase."
- good: "[market-structure mismatch] The market implies 79% YES while local fair probability is 75% YES because the board is pricing broad topic spillover too aggressively for exact-word rules."
- bad: "No strong evidence yet."
- bad: "Weak signal."
- bad: "WATCH because this is topical."

final_instruction:
Return only the required JSON object.
