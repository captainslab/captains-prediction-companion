export interface EventMarketSummary {
  headline: string
  recommendation: string
  one_line_reason: string
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
  market_view: Record<string, unknown>
}

export interface EventMarketPlanResponse {
  timestamp: string
  user_facing: EventMarketUserFacing
  hidden: {
    plan: Record<string, unknown>
    workflow: Record<string, unknown>
    output_contract: Record<string, unknown>
  }
}

export interface EventMarketPlanRequest {
  venue: string
  domain?: string | null
  market_id?: string | null
  title?: string | null
  question?: string | null
  market_type?: string | null
  market_subtype?: string | null
  url?: string | null
  resolution_source?: string | null
  notes?: string | null
  metadata?: Record<string, unknown>
}
