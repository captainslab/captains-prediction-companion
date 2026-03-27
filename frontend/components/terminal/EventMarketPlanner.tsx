'use client'

import { FormEvent, useMemo, useState } from 'react'
import type {
  EventMarketAnalyzeResponse,
  EventMarketContractPreview,
  EventMarketTradeView,
  EventMarketUserFacing,
} from '@/types/event-market'

const EXAMPLE_BOARD_URL =
  'https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26MAR27?utm_source=kalshiapp_eventpage'

function labelize(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item)).join(', ')
  }
  return JSON.stringify(value)
}

function formatProbability(value: number | null | undefined) {
  if (value == null) return '--'
  const percent = value * 100
  const decimals = percent >= 90 || percent <= 10 ? 1 : 0
  return `${percent.toFixed(decimals)}%`
}

function formatPrice(value: number | null | undefined) {
  if (value == null) return '--'
  return `${Math.round(value * 100)}c`
}

function recommendationTone(recommendation: string) {
  switch (recommendation) {
    case 'buy_yes':
    case 'home':
    case 'home_cover':
    case 'over':
      return 'border-emerald/35 bg-emerald/12 text-emerald'
    case 'buy_no':
    case 'away':
    case 'away_cover':
    case 'under':
      return 'border-rose/35 bg-rose/12 text-rose'
    case 'pass':
      return 'border-border bg-surface-elevated text-text-secondary'
    default:
      return 'border-amber/35 bg-amber/12 text-amber'
  }
}

function statusTone(status: string) {
  switch (status) {
    case 'ready':
      return 'text-emerald'
    case 'needs_pricing':
      return 'text-cyan'
    case 'waiting':
      return 'text-amber'
    default:
      return 'text-rose'
  }
}

function compactJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function getContextEntries(context: Record<string, unknown>) {
  return Object.entries(context).filter(([, value]) => {
    if (value == null) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object')
      return Object.keys(asRecord(value)).length > 0
    return true
  })
}

function getWatchForItems(card: EventMarketUserFacing | null) {
  const marketView = asRecord(card?.market_view)
  const watchFor = marketView.watch_for
  if (!Array.isArray(watchFor)) return []
  return watchFor.filter((item): item is string => typeof item === 'string')
}

function getMentionPaths(card: EventMarketUserFacing | null) {
  const mentionPaths = asRecord(asRecord(card?.market_view).mention_paths)
  return Object.entries(mentionPaths).filter(([, value]) => {
    const record = asRecord(value)
    return Object.keys(record).length > 0
  })
}

function getAvailableContracts(
  card: EventMarketUserFacing | null
): EventMarketContractPreview[] {
  const contracts = asRecord(card?.market_view).available_contracts
  if (!Array.isArray(contracts)) return []
  return contracts.filter((item): item is EventMarketContractPreview => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    return true
  })
}

function getTradeView(
  card: EventMarketUserFacing | null
): EventMarketTradeView {
  return asRecord(
    asRecord(card?.market_view).trade_view
  ) as EventMarketTradeView
}

function getMarketDetails(card: EventMarketUserFacing | null) {
  const marketView = asRecord(card?.market_view)
  const details: Array<{ label: string; value: string }> = []

  const targetPhrase = marketView.target_phrase
  if (typeof targetPhrase === 'string' && targetPhrase.trim()) {
    details.push({ label: 'Target phrase', value: targetPhrase })
  }

  const rulesSummary = marketView.rules_summary
  if (typeof rulesSummary === 'string' && rulesSummary.trim()) {
    details.push({ label: 'Rules summary', value: rulesSummary })
  }

  const tradeView = getTradeView(card)
  if (tradeView.market_ticker) {
    details.push({ label: 'Market ticker', value: tradeView.market_ticker })
  }
  if (tradeView.market_status) {
    details.push({ label: 'Market status', value: tradeView.market_status })
  }
  if (tradeView.resolved_outcome) {
    details.push({
      label: 'Resolved outcome',
      value: tradeView.resolved_outcome,
    })
  }

  return details
}

function deriveContractUrl(
  baseUrl: string | null,
  marketTicker: string | null
) {
  if (!baseUrl || !marketTicker) return null

  try {
    const parsed = new URL(baseUrl)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length === 0) return null
    segments[segments.length - 1] = marketTicker
    parsed.pathname = `/${segments.join('/')}`
    return parsed.toString()
  } catch {
    return null
  }
}

function Metric({
  label,
  value,
  emphasis = false,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="border-l border-border pl-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
        {label}
      </div>
      <div
        className={`mt-1 ${emphasis ? 'text-lg font-semibold text-text-primary' : 'text-sm text-text-secondary'}`}
      >
        {value}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan/60 to-transparent" />
      <div className="max-w-2xl">
        <div className="text-[10px] uppercase tracking-[0.24em] text-cyan">
          MCP deterministic view
        </div>
        <h2 className="mt-3 font-display text-3xl text-text-primary">
          Paste a Kalshi board or contract URL to render the exact tool card.
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-6 text-text-secondary">
          This panel uses the same MCP tool path as the ChatGPT app, but it
          renders the structured payload directly instead of letting the chat
          layer rewrite it into prose.
        </p>
        <div className="mt-6 grid gap-3 text-xs text-text-muted sm:grid-cols-3">
          <div className="border-l border-border pl-4">
            <div className="uppercase tracking-[0.18em]">Board mode</div>
            <p className="mt-1 leading-5">
              Shows the event-level card and contract strip when the URL points
              to a phrase board.
            </p>
          </div>
          <div className="border-l border-border pl-4">
            <div className="uppercase tracking-[0.18em]">Contract mode</div>
            <p className="mt-1 leading-5">
              Resolves the phrase, market ticker, and live YES pricing for one
              specific contract.
            </p>
          </div>
          <div className="border-l border-border pl-4">
            <div className="uppercase tracking-[0.18em]">Debug path</div>
            <p className="mt-1 leading-5">
              The raw tool payload stays available in a drawer so you can audit
              the renderer.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function EventMarketPlanner() {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState<EventMarketAnalyzeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [lastAnalyzedUrl, setLastAnalyzedUrl] = useState<string | null>(null)

  const card = result?.card ?? null
  const tradeView = useMemo(() => getTradeView(card), [card])
  const contracts = useMemo(() => getAvailableContracts(card), [card])
  const contextEntries = useMemo(
    () => getContextEntries(card?.context ?? {}),
    [card]
  )
  const marketDetails = useMemo(() => getMarketDetails(card), [card])
  const watchForItems = useMemo(() => getWatchForItems(card), [card])
  const mentionPaths = useMemo(() => getMentionPaths(card), [card])

  async function fetchAnalysis(nextUrl: string) {
    const response = await fetch('/api/mcp/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: nextUrl }),
    })

    const payload = (await response.json()) as EventMarketAnalyzeResponse & {
      error?: string
    }

    if (!response.ok) {
      throw new Error(payload.error || `Request failed with ${response.status}`)
    }

    return payload
  }

  async function analyzeMarket(nextUrl: string) {
    setLoading(true)
    setError(null)
    setInfo(null)

    try {
      const payload = await fetchAnalysis(nextUrl)
      setResult(payload)
      setInfo(payload.focus?.message ?? null)
      setLastAnalyzedUrl(payload.card.source.url ?? nextUrl)
      setUrl(nextUrl)
    } catch (requestError) {
      console.error('Failed to analyze Kalshi market URL:', requestError)
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Failed to analyze Kalshi market URL.'
      )
      setInfo(null)
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) {
      setError('Paste a Kalshi market URL first.')
      return
    }
    await analyzeMarket(trimmed)
  }

  async function handleContractSelect(contract: EventMarketContractPreview) {
    const contractUrl = deriveContractUrl(
      card?.source.url ?? lastAnalyzedUrl,
      contract.market_ticker
    )
    if (!contractUrl) {
      setError('Could not derive a contract URL from the current board.')
      return
    }
    await analyzeMarket(contractUrl)
  }

  const activeTicker = tradeView.market_ticker ?? card?.source.market_id ?? null

  return (
    <section className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="relative overflow-hidden rounded-2xl border border-border bg-surface p-5">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan/60 to-transparent" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.24em] text-cyan">
              Companion
            </div>
            <h2 className="mt-2 text-xl font-semibold text-text-primary">
              Kalshi market card
            </h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              Deterministic renderer for the MCP tool output. Paste a board or
              contract URL and drill into one phrase contract without relying on
              chat prose.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setUrl(EXAMPLE_BOARD_URL)
              setError(null)
              setInfo(null)
            }}
            className="rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11px] text-text-secondary transition-colors hover:border-cyan/35 hover:text-text-primary"
          >
            Load example
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <label className="block">
            <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
              Kalshi URL
            </span>
            <textarea
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              rows={4}
              placeholder="https://kalshi.com/markets/..."
              className="mt-2 w-full rounded-xl border border-border bg-void/40 px-3 py-3 text-sm text-text-primary placeholder:text-text-muted focus:border-cyan/50 focus:outline-none"
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={loading}
              className="rounded-full border border-cyan/35 bg-cyan/12 px-4 py-2 text-sm font-medium text-cyan transition-colors hover:bg-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Analyzing...' : 'Render card'}
            </button>
            {lastAnalyzedUrl && (
              <a
                href={lastAnalyzedUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-text-muted transition-colors hover:text-text-primary"
              >
                Open source market
              </a>
            )}
          </div>
        </form>

        {error && (
          <div className="mt-4 rounded-xl border border-rose/35 bg-rose/10 px-3 py-3 text-sm text-rose">
            {error}
          </div>
        )}

        {info && !error && (
          <div className="mt-4 rounded-xl border border-cyan/30 bg-cyan/10 px-3 py-3 text-sm text-cyan">
            {info}
          </div>
        )}

        <div className="mt-6 grid gap-3 text-xs sm:grid-cols-3 xl:grid-cols-1">
          <Metric
            label="Tool status"
            value={card ? labelize(card.status) : 'Waiting for input'}
            emphasis
          />
          <Metric
            label="Recommendation"
            value={card ? labelize(card.summary.recommendation) : 'None'}
            emphasis
          />
          <Metric
            label="Confidence"
            value={card ? labelize(card.confidence) : '--'}
            emphasis
          />
        </div>

        <div className="mt-6 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                Board contracts
              </div>
              <div className="mt-1 text-sm text-text-secondary">
                Select one contract to lock the card to a phrase market.
              </div>
            </div>
            {contracts.length > 0 && (
              <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                {contracts.length} loaded
              </span>
            )}
          </div>

          {contracts.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-border bg-void/25 px-3 py-5 text-sm text-text-muted">
              The contract strip appears when the URL resolves to a Kalshi
              board.
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {contracts.map((contract) => {
                const isActive =
                  Boolean(activeTicker) &&
                  activeTicker === contract.market_ticker
                return (
                  <button
                    key={
                      contract.market_ticker ??
                      `${contract.label ?? 'contract'}-${contract.market_yes ?? 'na'}`
                    }
                    type="button"
                    onClick={() => handleContractSelect(contract)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                      isActive
                        ? 'border-cyan/45 bg-cyan/10'
                        : 'border-border bg-surface-elevated hover:border-border-glow hover:bg-surface-hover/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-text-primary">
                          {contract.label ??
                            contract.market_ticker ??
                            'Unnamed contract'}
                        </div>
                        <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-text-muted">
                          {contract.market_ticker ?? 'No ticker'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-text-primary">
                          {formatProbability(contract.market_yes)} YES
                        </div>
                        <div className="mt-1 text-[11px] text-text-muted">
                          Bid {formatPrice(contract.yes_bid)} / Ask{' '}
                          {formatPrice(contract.yes_ask)}
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </aside>

      {!card ? (
        <EmptyState />
      ) : (
        <div className="space-y-4">
          <div className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.14),transparent_38%)]" />
            <div className="relative">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${recommendationTone(
                    card.summary.recommendation
                  )}`}
                >
                  {labelize(card.summary.recommendation)}
                </span>
                <span
                  className={`text-[11px] font-medium uppercase tracking-[0.18em] ${statusTone(
                    card.status
                  )}`}
                >
                  {labelize(card.status)}
                </span>
                <span className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
                  {labelize(card.event_domain)} / {labelize(card.event_type)} /{' '}
                  {labelize(card.market_type)}
                </span>
              </div>

              <h3 className="mt-4 max-w-3xl font-display text-3xl leading-tight text-text-primary">
                {card.summary.headline}
              </h3>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary">
                {card.summary.one_line_reason}
              </p>

              <div className="mt-6 grid gap-4 border-t border-border pt-4 md:grid-cols-4">
                <Metric
                  label="Platform"
                  value={card.source.platform}
                  emphasis={false}
                />
                <Metric
                  label="Next action"
                  value={
                    card.next_action
                      ? labelize(card.next_action)
                      : 'No follow-up'
                  }
                  emphasis={false}
                />
                <Metric
                  label="YES midpoint"
                  value={formatProbability(tradeView.market_yes)}
                  emphasis
                />
                <Metric
                  label="Bid / ask"
                  value={`${formatPrice(tradeView.market_yes_bid)} / ${formatPrice(
                    tradeView.market_yes_ask
                  )}`}
                  emphasis
                />
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <section className="rounded-2xl border border-border bg-surface p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                    Event context
                  </div>
                  <h4 className="mt-1 text-lg font-semibold text-text-primary">
                    Structured facts
                  </h4>
                </div>
                {result && (
                  <div className="text-[11px] text-text-muted">
                    {new Date(result.timestamp).toLocaleTimeString()}
                  </div>
                )}
              </div>

              <div className="mt-4 grid gap-3">
                {contextEntries.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-void/25 px-3 py-4 text-sm text-text-muted">
                    No event context extracted yet.
                  </div>
                ) : (
                  contextEntries.map(([key, value]) => (
                    <div key={key} className="border-l border-border pl-4">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                        {labelize(key)}
                      </div>
                      <div className="mt-1 text-sm leading-6 text-text-primary">
                        {renderValue(value)}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="mt-6 border-t border-border pt-4">
                <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                  Market specifics
                </div>
                <div className="mt-3 grid gap-3">
                  {marketDetails.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border bg-void/25 px-3 py-4 text-sm text-text-muted">
                      No market-specific detail extracted yet.
                    </div>
                  ) : (
                    marketDetails.map((detail) => (
                      <div
                        key={`${detail.label}-${detail.value}`}
                        className="border-l border-border pl-4"
                      >
                        <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                          {detail.label}
                        </div>
                        <div className="mt-1 text-sm leading-6 text-text-primary">
                          {detail.value}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-surface p-5">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                Decision support
              </div>
              <h4 className="mt-1 text-lg font-semibold text-text-primary">
                Phrase path and monitoring hooks
              </h4>

              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                <div className="space-y-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                      Watch for
                    </div>
                    {watchForItems.length === 0 ? (
                      <div className="mt-3 rounded-xl border border-dashed border-border bg-void/25 px-3 py-4 text-sm text-text-muted">
                        No watchlist hooks extracted yet.
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {watchForItems.map((item) => (
                          <span
                            key={item}
                            className="rounded-full border border-border bg-surface-elevated px-3 py-2 text-xs text-text-secondary"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                      Price snapshot
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-border bg-surface-elevated px-4 py-3">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                          Midpoint
                        </div>
                        <div className="mt-1 text-lg font-semibold text-text-primary">
                          {formatProbability(tradeView.market_yes)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-border bg-surface-elevated px-4 py-3">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                          Last trade
                        </div>
                        <div className="mt-1 text-lg font-semibold text-text-primary">
                          {formatPrice(tradeView.last_price)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                    Mention paths
                  </div>
                  {mentionPaths.length === 0 ? (
                    <div className="mt-3 rounded-xl border border-dashed border-border bg-void/25 px-3 py-4 text-sm text-text-muted">
                      No mention-path breakdown extracted yet.
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {mentionPaths.map(([key, value]) => {
                        const pathValue = asRecord(value)
                        const strength =
                          typeof pathValue.strength === 'string'
                            ? pathValue.strength
                            : typeof pathValue.level === 'string'
                              ? pathValue.level
                              : 'unknown'
                        const reason =
                          typeof pathValue.reason === 'string'
                            ? pathValue.reason
                            : 'No reason provided.'

                        return (
                          <div
                            key={key}
                            className="rounded-xl border border-border bg-surface-elevated px-4 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm font-medium text-text-primary">
                                {labelize(key)}
                              </div>
                              <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
                                {labelize(strength)}
                              </span>
                            </div>
                            <p className="mt-2 text-sm leading-6 text-text-secondary">
                              {reason}
                            </p>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>

          <details
            open={showRaw}
            className="rounded-2xl border border-border bg-surface p-5"
          >
            <summary
              onClick={(event) => {
                event.preventDefault()
                setShowRaw((prev) => !prev)
              }}
              className="cursor-pointer list-none text-sm font-medium text-text-primary"
            >
              Raw MCP payload
              <span className="ml-2 text-xs text-text-muted">
                {showRaw ? 'Hide' : 'Show'}
              </span>
            </summary>
            <p className="mt-2 text-xs text-text-muted">
              This stays outside the primary UI. Use it to verify what the MCP
              tool returned before the renderer shaped it.
            </p>
            <pre className="mt-4 max-h-80 overflow-auto rounded-xl border border-border bg-void/70 p-4 text-[11px] text-text-secondary">
              {compactJson(result?.raw ?? result)}
            </pre>
          </details>
        </div>
      )}
    </section>
  )
}
