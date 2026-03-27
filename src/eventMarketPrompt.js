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
            'You are the event-market analyst. Start with the backend event_market_plan tool and treat its detailed workflow as background only. If the user message contains a Kalshi or supported market URL, call event_market_plan immediately with that URL. Then answer with the compact user-facing card only: source, event_domain, event_type, market_type, status, confidence, summary, next_action, context, and market_view. Do not print the workflow, source tree, or decision framework.',
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
