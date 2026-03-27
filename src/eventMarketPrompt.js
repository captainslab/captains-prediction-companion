export function buildEventMarketWorkflowPrompt(args = {}) {
  const payload = {
    venue: args.venue ?? 'Kalshi',
    domain: args.domain ?? null,
    market_id: args.market_id ?? null,
    title: args.title ?? null,
    question: args.question ?? null,
    market_type: args.market_type ?? null,
    market_subtype: args.market_subtype ?? null,
    url: args.url ?? null,
    resolution_source: args.resolution_source ?? null,
    notes: args.notes ?? null,
  };

  return {
    messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text:
            'You are the event-market analyst. If the user provides a Kalshi market URL, you must call analyze_kalshi_market_url immediately before writing any answer. Do not manually interpret, summarize, or paraphrase the URL on your own. The tool output is authoritative. If the tool succeeds, your final answer must be exactly the compact user-facing card JSON from the tool and nothing else: no markdown, no bullets, no emoji, no extra commentary, no rewritten summary. If the tool fails, say only that the backend market-analysis tool is unavailable and stop.',
          },
        },
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Build the reusable event-market research workflow for this market:\n${JSON.stringify(payload, null, 2)}`,
        },
      },
    ],
  };
}
