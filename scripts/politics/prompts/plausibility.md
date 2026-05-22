# Political Plausibility Analyst — {{market_id}}

For each top contract, evaluate political/process plausibility. Label every claim as INFERENCE.

Top contracts:
{{boardSummary}}

Return JSON to `plausibility.json`:
```json
{
  "candidates": [
    {
      "name": "Todd Blanche",
      "strengths":  ["<inference>"],
      "weaknesses": ["<inference>"],
      "processObstacles": ["<inference>"]
    }
  ]
}
```
Do not pretend inference is fact. Do not invoke X chatter as evidence here.
