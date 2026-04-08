import { NextRequest, NextResponse } from 'next/server'
import type { EventMarketUserFacing } from '@/types/event-market'

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp'
const TOOL_NAME = 'analyze_kalshi_market_url'

type JsonRpcSuccess<T> = {
  jsonrpc: '2.0'
  id?: string | number | null
  result: T
}

type JsonRpcError = {
  jsonrpc: '2.0'
  id?: string | number | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
}

type FocusMetadata = {
  auto_selected: boolean
  market_ticker: string | null
  label: string | null
  message: string
} | null

function isJsonRpcError(payload: unknown): payload is JsonRpcError {
  return payload !== null && typeof payload === 'object' && 'error' in payload
}

async function postJsonRpc(
  payload: Record<string, unknown>,
  sessionId?: string
) {
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  })

  if (sessionId) {
    headers.set('Mcp-Session-Id', sessionId)
  }

  const response = await fetch(MCP_SERVER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    cache: 'no-store',
  })

  const bodyText = await response.text()
  let json: unknown = null

  if (bodyText) {
    try {
      json = JSON.parse(bodyText)
    } catch {
      const ssePayload = extractSseJson(bodyText)
      if (ssePayload) {
        try {
          json = JSON.parse(ssePayload)
        } catch {
          json = null
        }
      } else {
        json = null
      }
    }
  }

  return {
    response,
    payload: json,
    text: bodyText,
  }
}

function extractSseJson(bodyText: string) {
  const dataLines = bodyText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)

  if (dataLines.length === 0) return null
  return dataLines.join('\n')
}

async function initializeSession() {
  const requestId = crypto.randomUUID()
  const { response, payload, text } = await postJsonRpc({
    jsonrpc: '2.0',
    id: requestId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'captains-prediction-companion-frontend',
        version: '0.1.0',
      },
    },
  })

  if (!response.ok) {
    throw new Error(text || `MCP initialize failed with ${response.status}`)
  }

  if (isJsonRpcError(payload)) {
    throw new Error(payload.error.message)
  }

  const sessionId = response.headers.get('Mcp-Session-Id')
  if (!sessionId) {
    throw new Error('MCP session header missing from initialize response.')
  }

  return sessionId
}

async function notifyInitialized(sessionId: string) {
  try {
    await postJsonRpc(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      sessionId
    )
  } catch {
    // Best-effort only. The local MCP server accepts tool calls without this.
  }
}

function parseToolCard(toolResult: ToolResult): EventMarketUserFacing {
  if (toolResult.structuredContent) {
    return toolResult.structuredContent as EventMarketUserFacing
  }

  const textBlock = toolResult.content?.find(
    (item) => item.type === 'text' && typeof item.text === 'string'
  )

  if (!textBlock?.text) {
    throw new Error('Tool response did not include a structured card.')
  }

  return JSON.parse(textBlock.text) as EventMarketUserFacing
}

function getAvailableContracts(card: EventMarketUserFacing) {
  const contracts = card.market_view?.available_contracts
  return Array.isArray(contracts) ? contracts : []
}

function getActiveMarketTicker(card: EventMarketUserFacing) {
  const tradeView = card.market_view?.trade_view
  return typeof tradeView?.market_ticker === 'string'
    ? tradeView.market_ticker
    : null
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

async function callAnalyzeTool(sessionId: string, url: string) {
  const requestId = crypto.randomUUID()
  const { response, payload, text } = await postJsonRpc(
    {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: TOOL_NAME,
        arguments: { url },
      },
    },
    sessionId
  )

  if (!response.ok) {
    throw new Error(text || `MCP tool call failed with ${response.status}`)
  }

  if (isJsonRpcError(payload)) {
    throw new Error(payload.error.message)
  }

  const result = (payload as JsonRpcSuccess<ToolResult> | null)?.result

  if (!result) {
    throw new Error('MCP tool returned no result payload.')
  }

  const card = parseToolCard(result)
  return { result, card }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { url?: string }
    const url = body.url?.trim()

    if (!url) {
      return NextResponse.json(
        { error: 'A Kalshi URL is required.' },
        { status: 400 }
      )
    }

    const sessionId = await initializeSession()
    await notifyInitialized(sessionId)
    let { result, card } = await callAnalyzeTool(sessionId, url)
    let focus: FocusMetadata = null

    const boardContracts = getAvailableContracts(card)
    if (!getActiveMarketTicker(card) && boardContracts.length > 0) {
      const primaryContract = boardContracts[0]
      const contractUrl = deriveContractUrl(
        card.source.url ?? url,
        primaryContract.market_ticker
      )

      if (contractUrl) {
        const focused = await callAnalyzeTool(sessionId, contractUrl)
        result = focused.result
        card = focused.card
        focus = {
          auto_selected: true,
          market_ticker: primaryContract.market_ticker,
          label: primaryContract.label,
          message: `Auto-focused ${primaryContract.label ?? primaryContract.market_ticker ?? 'the top contract'} from the board.`,
        }
      }
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      card,
      raw: result,
      focus,
    })
  } catch (error) {
    console.error('MCP analysis proxy failed:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to analyze Kalshi market URL.',
      },
      { status: 502 }
    )
  }
}
