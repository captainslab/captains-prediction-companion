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
      json = null
    }
  }

  return {
    response,
    payload: json,
    text: bodyText,
  }
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
        name: 'alphapoly-web',
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
      return NextResponse.json(
        { error: text || `MCP tool call failed with ${response.status}` },
        { status: response.status }
      )
    }

    if (isJsonRpcError(payload)) {
      return NextResponse.json(
        { error: payload.error.message },
        { status: 502 }
      )
    }

    const result = (payload as JsonRpcSuccess<ToolResult> | null)?.result

    if (!result) {
      return NextResponse.json(
        { error: 'MCP tool returned no result payload.' },
        { status: 502 }
      )
    }

    const card = parseToolCard(result)

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      card,
      raw: result,
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
