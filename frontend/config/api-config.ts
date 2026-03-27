// =============================================================================
// API CONFIGURATION - Dynamic URL resolution for backend connections
// =============================================================================

/**
 * Get the base URL for API requests.
 * Uses Next.js API proxy (/api) for client-side to avoid CORS issues.
 * Server-side uses direct connection.
 */
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    // Server-side rendering - direct connection
    return 'http://localhost:8000'
  }

  // Client-side - use Next.js API proxy to avoid CORS/Safari issues
  return '/api'
}

/**
 * Get the WebSocket URL for portfolio price updates.
 */
export function getPortfolioWsUrl(): string {
  if (typeof window === 'undefined') {
    return 'ws://localhost:8000/portfolios/ws'
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/portfolios/ws`
}

/**
 * Get the API docs URL.
 */
export function getApiDocsUrl(): string {
  // Use the Next.js proxy path so the rendered href stays identical
  // between server render and client hydration.
  return '/api/docs'
}
