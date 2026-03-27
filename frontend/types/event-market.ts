export interface EventMarketSummary {
  headline: string
  recommendation: string
  one_line_reason: string
}

export interface EventMarketContractPreview {
  market_ticker: string | null
  label: string | null
  market_yes: number | null
  yes_bid: number | null
  yes_ask: number | null
  last_price: number | null
  market_status: string | null
}

export interface EventMarketTradeView {
  best_side?: string | null
  market_status?: string | null
  market_ticker?: string | null
  market_yes?: number | null
  market_yes_bid?: number | null
  market_yes_ask?: number | null
  last_price?: number | null
  fair_yes?: number | null
  edge_cents?: number | null
  resolved_outcome?: string | null
}

export interface EventMarketUserFacing {
  source: {
    platform: string
    url: string | null
    market_id: string | null
  }
  event_domain: string
  event_type: string
  market_type: string
  status: string
  confidence: 'low' | 'medium' | 'high'
  summary: EventMarketSummary
  next_action: string | null
  context: Record<string, unknown>
  market_view: Record<string, unknown> & {
    available_contracts?: EventMarketContractPreview[]
    trade_view?: EventMarketTradeView
  }
}

export interface EventMarketAnalyzeResponse {
  timestamp: string
  card: EventMarketUserFacing
  raw: Record<string, unknown>
}
