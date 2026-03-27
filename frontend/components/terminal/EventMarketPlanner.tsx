'use client'

import { FormEvent, useMemo, useState } from 'react'
import { getApiBaseUrl } from '@/config/api-config'
import type {
  EventMarketPlanRequest,
  EventMarketPlanResponse,
} from '@/types/event-market'

type FormState = {
  venue: string
  domain: string
  marketId: string
  title: string
  question: string
  marketType: string
  marketSubtype: string
  url: string
  resolutionSource: string
  notes: string
  metadataJson: string
}

const DEFAULT_FORM: FormState = {
  venue: 'Kalshi',
  domain: '',
  marketId: '',
  title: '',
  question: '',
  marketType: '',
  marketSubtype: '',
  url: '',
  resolutionSource: '',
  notes: '',
  metadataJson: '',
}

function labelize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function compactJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function buildRequestPayload(state: FormState): EventMarketPlanRequest {
  const metadata = state.metadataJson.trim()
    ? (JSON.parse(state.metadataJson) as Record<string, unknown>)
    : {}

  return {
    venue: state.venue.trim() || 'Kalshi',
    domain: state.domain.trim() || null,
    market_id: state.marketId.trim() || null,
    title: state.title.trim() || null,
    question: state.question.trim() || null,
    market_type: state.marketType.trim() || null,
    market_subtype: state.marketSubtype.trim() || null,
    url: state.url.trim() || null,
    resolution_source: state.resolutionSource.trim() || null,
    notes: state.notes.trim() || null,
    metadata,
  }
}

function recommendationTone(recommendation: string) {
  switch (recommendation) {
    case 'buy_yes':
    case 'home':
    case 'home_cover':
    case 'over':
      return 'text-emerald border-emerald/30 bg-emerald/10'
    case 'buy_no':
    case 'away':
    case 'away_cover':
    case 'under':
      return 'text-rose border-rose/30 bg-rose/10'
    default:
      return 'text-amber border-amber/30 bg-amber/10'
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

function getContextEntries(context: Record<string, unknown>) {
  return Object.entries(context).filter(([, value]) => {
    if (value == null) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object') return Object.keys(value as object).length > 0
    return true
  })
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

function buildMarketViewHighlights(marketView: Record<string, unknown>) {
  const highlights: Array<{ label: string; value: string }> = []

  const targetPhrase = marketView.target_phrase
  if (typeof targetPhrase === 'string' && targetPhrase.trim()) {
    highlights.push({ label: 'Target phrase', value: targetPhrase })
  }

  const tradeView = marketView.trade_view
  if (
    tradeView &&
    typeof tradeView === 'object' &&
    'best_side' in tradeView &&
    typeof tradeView.best_side === 'string'
  ) {
    highlights.push({ label: 'Best side', value: tradeView.best_side })
  }

  const moneyline = marketView.moneyline
  if (
    moneyline &&
    typeof moneyline === 'object' &&
    'lean' in moneyline &&
    typeof moneyline.lean === 'string'
  ) {
    highlights.push({ label: 'Lean', value: moneyline.lean })
  }

  const spread = marketView.spread
  if (
    spread &&
    typeof spread === 'object' &&
    'lean' in spread &&
    typeof spread.lean === 'string'
  ) {
    highlights.push({ label: 'Spread lean', value: spread.lean })
  }

  const total = marketView.total
  if (
    total &&
    typeof total === 'object' &&
    'lean' in total &&
    typeof total.lean === 'string'
  ) {
    highlights.push({ label: 'Total lean', value: total.lean })
  }

  const playerProp = marketView.player_prop
  if (
    playerProp &&
    typeof playerProp === 'object' &&
    'lean' in playerProp &&
    typeof playerProp.lean === 'string'
  ) {
    highlights.push({ label: 'Prop lean', value: playerProp.lean })
  }

  return highlights
}

function getWatchForItems(marketView: Record<string, unknown>): string[] {
  const watchFor = marketView.watch_for
  if (!Array.isArray(watchFor)) return []
  return watchFor.filter((item): item is string => typeof item === 'string')
}

export function EventMarketPlanner() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [result, setResult] = useState<EventMarketPlanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

  const contextEntries = useMemo(
    () => getContextEntries(result?.user_facing.context || {}),
    [result]
  )
  const marketHighlights = useMemo(
    () =>
      result ? buildMarketViewHighlights(result.user_facing.market_view || {}) : [],
    [result]
  )
  const watchForItems = useMemo(
    () => (result ? getWatchForItems(result.user_facing.market_view || {}) : []),
    [result]
  )

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)

    let payload: EventMarketPlanRequest
    try {
      payload = buildRequestPayload(form)
    } catch (parseError) {
      setLoading(false)
      setError('Metadata JSON is invalid. Fix it or leave it blank.')
      return
    }

    try {
      const response = await fetch(`${getApiBaseUrl()}/pipeline/event-markets/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(body || `Request failed with ${response.status}`)
      }

      const data = (await response.json()) as EventMarketPlanResponse
      setResult(data)
    } catch (requestError) {
      console.error('Failed to plan event market:', requestError)
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Failed to build event-market card.'
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(360px,460px)_minmax(0,1fr)]">
      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-border bg-surface p-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              Event Market Planner
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              Build the compact app card from market context before pricing is wired.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setForm(DEFAULT_FORM)
              setResult(null)
              setError(null)
            }}
            className="text-[11px] text-text-muted hover:text-text-primary transition-colors"
          >
            Reset
          </button>
        </div>

        <div className="mt-4 grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">
                Venue
              </span>
              <input
                value={form.venue}
                onChange={(event) => updateField('venue', event.target.value)}
                className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">
                Domain
              </span>
              <select
                value={form.domain}
                onChange={(event) => updateField('domain', event.target.value)}
                className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
              >
                <option value="">Auto</option>
                <option value="sports">Sports</option>
                <option value="earnings">Earnings</option>
                <option value="politics">Politics</option>
                <option value="mention">Mention</option>
                <option value="macro">Macro</option>
              </select>
            </label>
          </div>

          <label className="grid gap-1">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">
              Market title
            </span>
            <input
              value={form.title}
              onChange={(event) => updateField('title', event.target.value)}
              placeholder='Will management say "GLP-1" on the earnings call?'
              className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-[11px] uppercase tracking-wide text-text-muted">
              Resolution question
            </span>
            <textarea
              value={form.question}
              onChange={(event) => updateField('question', event.target.value)}
              rows={3}
              placeholder="Will the event resolve YES?"
              className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">
                Market ID
              </span>
              <input
                value={form.marketId}
                onChange={(event) => updateField('marketId', event.target.value)}
                className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">
                URL
              </span>
              <input
                value={form.url}
                onChange={(event) => updateField('url', event.target.value)}
                placeholder="https://kalshi.com/markets/..."
                className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
              />
            </label>
          </div>

          <details className="rounded border border-border/80 bg-surface-elevated/50">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-text-secondary">
              Advanced market fields
            </summary>
            <div className="grid gap-3 border-t border-border/80 px-3 py-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-text-muted">
                    Market type hint
                  </span>
                  <input
                    value={form.marketType}
                    onChange={(event) => updateField('marketType', event.target.value)}
                    placeholder="mention, binary, total"
                    className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-text-muted">
                    Market subtype
                  </span>
                  <input
                    value={form.marketSubtype}
                    onChange={(event) =>
                      updateField('marketSubtype', event.target.value)
                    }
                    placeholder="earnings_call_mention"
                    className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
                  />
                </label>
              </div>
              <label className="grid gap-1">
                <span className="text-[11px] uppercase tracking-wide text-text-muted">
                  Resolution source
                </span>
                <input
                  value={form.resolutionSource}
                  onChange={(event) =>
                    updateField('resolutionSource', event.target.value)
                  }
                  className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-[11px] uppercase tracking-wide text-text-muted">
                  Notes
                </span>
                <textarea
                  value={form.notes}
                  onChange={(event) => updateField('notes', event.target.value)}
                  rows={2}
                  className="rounded border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary focus:border-cyan/50 focus:outline-none"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-[11px] uppercase tracking-wide text-text-muted">
                  Metadata JSON
                </span>
                <textarea
                  value={form.metadataJson}
                  onChange={(event) =>
                    updateField('metadataJson', event.target.value)
                  }
                  rows={5}
                  placeholder='{"company":"Hims & Hers","start_time":"2026-05-06T17:00:00-04:00"}'
                  className="rounded border border-border bg-surface-elevated px-3 py-2 font-mono text-xs text-text-primary focus:border-cyan/50 focus:outline-none"
                />
              </label>
            </div>
          </details>

          {error && (
            <div className="rounded border border-rose/30 bg-rose/10 px-3 py-2 text-xs text-rose">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || (!form.title.trim() && !form.question.trim())}
            className="mt-1 rounded border border-cyan/30 bg-cyan/10 px-3 py-2 text-sm font-medium text-cyan transition-colors hover:bg-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Building card...' : 'Build event-market card'}
          </button>
        </div>
      </form>

      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              User-Facing Card
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              Compact output for the ChatGPT app and the future dashboard.
            </p>
          </div>
          {result && (
            <div className="text-[11px] text-text-muted">
              {new Date(result.timestamp).toLocaleTimeString()}
            </div>
          )}
        </div>

        {!result ? (
          <div className="mt-6 flex h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-surface-elevated/50 px-6 text-center text-sm text-text-muted">
            Submit a market title or resolution question to preview the compact card.
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-border bg-surface-elevated p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-1 text-[11px] font-medium ${recommendationTone(
                    result.user_facing.summary.recommendation
                  )}`}
                >
                  {labelize(result.user_facing.summary.recommendation)}
                </span>
                <span
                  className={`text-[11px] font-medium ${statusTone(
                    result.user_facing.status
                  )}`}
                >
                  {labelize(result.user_facing.status)}
                </span>
                <span className="text-[11px] text-text-muted">
                  {labelize(result.user_facing.event_domain)} /{' '}
                  {labelize(result.user_facing.event_type)} /{' '}
                  {labelize(result.user_facing.market_type)}
                </span>
              </div>

              <h3 className="mt-3 text-lg font-semibold text-text-primary">
                {result.user_facing.summary.headline}
              </h3>
              <p className="mt-2 text-sm text-text-secondary">
                {result.user_facing.summary.one_line_reason}
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded border border-border/80 bg-surface px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-text-muted">
                    Platform
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {result.user_facing.source.platform}
                  </div>
                </div>
                <div className="rounded border border-border/80 bg-surface px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-text-muted">
                    Confidence
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {labelize(result.user_facing.confidence)}
                  </div>
                </div>
                <div className="rounded border border-border/80 bg-surface px-3 py-2">
                  <div className="text-[11px] uppercase tracking-wide text-text-muted">
                    Next action
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {result.user_facing.next_action
                      ? labelize(result.user_facing.next_action)
                      : 'None'}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
              <div className="rounded-lg border border-border bg-surface-elevated p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Event Context
                </h3>
                <div className="mt-3 space-y-2">
                  {contextEntries.length === 0 ? (
                    <p className="text-sm text-text-muted">
                      No event context extracted yet.
                    </p>
                  ) : (
                    contextEntries.map(([key, value]) => (
                      <div
                        key={key}
                        className="rounded border border-border/80 bg-surface px-3 py-2"
                      >
                        <div className="text-[11px] uppercase tracking-wide text-text-muted">
                          {labelize(key)}
                        </div>
                        <div className="mt-1 text-sm text-text-primary">
                          {renderValue(value)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-surface-elevated p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Market View
                </h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {marketHighlights.length === 0 ? (
                    <p className="text-sm text-text-muted">
                      The market view is mapped, but no compact highlights are available yet.
                    </p>
                  ) : (
                    marketHighlights.map((highlight) => (
                      <div
                        key={`${highlight.label}-${highlight.value}`}
                        className="rounded border border-border/80 bg-surface px-3 py-2"
                      >
                        <div className="text-[11px] uppercase tracking-wide text-text-muted">
                          {highlight.label}
                        </div>
                        <div className="mt-1 text-sm text-text-primary">
                          {labelize(highlight.value)}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {watchForItems.length > 0 && (
                    <div className="mt-4 rounded border border-border/80 bg-surface px-3 py-3">
                      <div className="text-[11px] uppercase tracking-wide text-text-muted">
                        Watch for
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {watchForItems.map((item) => (
                          <span
                            key={item}
                            className="rounded-full border border-border px-2 py-1 text-xs text-text-secondary"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-surface-elevated p-4">
              <button
                type="button"
                onClick={() => setShowHidden((prev) => !prev)}
                className="flex w-full items-center justify-between text-left"
              >
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Hidden debug payload
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    Keep this collapsed in normal app flows. It exists for development and audit work.
                  </div>
                </div>
                <span className="text-xs text-cyan">
                  {showHidden ? 'Hide' : 'Show'}
                </span>
              </button>
              {showHidden && (
                <pre className="mt-4 max-h-64 overflow-auto rounded border border-border bg-void/70 p-3 text-[11px] text-text-secondary">
                  {compactJson(result.hidden)}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
