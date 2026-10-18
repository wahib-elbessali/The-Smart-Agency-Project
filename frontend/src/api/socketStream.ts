import {
  WS_AUTH_MODE,
  WS_AUTH_QUERY_PARAM,
  WS_BASE_URL,
  WS_MAX_INITIAL_ATTEMPTS,
  WS_RECONNECT_MS,
} from './config'
import { getAccessToken } from './tokenStore'

/**
 * The connect / backoff / status machinery every live stream shares.
 *
 * Extracted from attendanceStream.ts when Alerts and Occupancy arrived and
 * wanted the same behaviour. Three sockets each with their own hand-rolled
 * reconnect loop is three places for the same bug, and the reconnect policy
 * here is the part that took measurement to get right - see the comments on
 * WS_MAX_INITIAL_ATTEMPTS and on the token in the query string.
 *
 * What is NOT here: the shape of a frame. Each stream passes its own parser,
 * because "is this frame valid" is the one thing that genuinely differs.
 */

export type StreamStatus =
  | 'idle' // never connected
  | 'connecting'
  | 'open'
  | 'reconnecting' // dropped, trying again
  | 'closed' // deliberately stopped, or cannot run

export interface SocketStream<T> {
  readonly status: StreamStatus
  /** Returns an unsubscribe function. */
  subscribe(onEvent: (event: T) => void): () => void
  /** Returns an unsubscribe function. Fires immediately with the current status. */
  onStatusChange(listener: (status: StreamStatus) => void): () => void
  close(): void
}

export interface SocketStreamDeps {
  /** Injectable for tests; defaults to the browser's WebSocket. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket
  tokenProvider?: () => string | null
  scheduleRetry?: (fn: () => void, ms: number) => number
  cancelRetry?: (handle: number) => void
}

/**
 * Builds the socket URL for one path.
 *
 * Returns null when we cannot connect honestly - no token, or no configured way
 * to present it. Returning null (rather than connecting anyway and hoping) is
 * what makes the badge say "Not connected" instead of showing a calm, empty,
 * silently-unauthenticated list.
 */
export function buildSocketTarget(
  path: string,
  token: string | null,
  mode = WS_AUTH_MODE,
  base = WS_BASE_URL,
): { url: string; protocols?: string[] } | null {
  if (!base || !token || !mode) return null

  const url = new URL(`${base}${path}`)
  url.searchParams.set(WS_AUTH_QUERY_PARAM, token)
  /* Worth knowing: a token in a query string lands in server and proxy access
     logs. The subprotocol field avoids that, but the backend returns 403 for it
     - tested - so this is the only option that works today. */
  return { url: url.toString() }
}

/** Full jitter exponential backoff, so N reconnecting dashboards don't sync up. */
export function backoffDelay(attempt: number): number {
  const { min, max } = WS_RECONNECT_MS
  const ceiling = Math.min(max, min * 2 ** attempt)
  return min + Math.random() * (ceiling - min)
}

export function createSocketStream<T>(
  path: string,
  parse: (data: unknown) => T | null,
  deps: SocketStreamDeps = {},
): SocketStream<T> {
  const {
    socketFactory = (url, protocols) => new WebSocket(url, protocols),
    tokenProvider = getAccessToken,
    scheduleRetry = (fn, ms) => setTimeout(fn, ms) as unknown as number,
    cancelRetry = (handle) => clearTimeout(handle),
  } = deps

  const eventListeners = new Set<(event: T) => void>()
  const statusListeners = new Set<(status: StreamStatus) => void>()

  let status: StreamStatus = 'idle'
  let socket: WebSocket | null = null
  let retryHandle: number | null = null
  let attempt = 0
  let stopped = false
  /* Once true, drops stay retryable forever - see WS_MAX_INITIAL_ATTEMPTS. */
  let hasEverOpened = false

  function setStatus(next: StreamStatus) {
    if (status === next) return
    status = next
    for (const listener of statusListeners) listener(next)
  }

  function connect() {
    if (stopped) return

    const target = buildSocketTarget(path, tokenProvider())
    if (!target) {
      /* No token, or VITE_WS_AUTH_MODE is unset. Either way there is nothing
         honest to connect to, and retrying forever would just spin. */
      setStatus('closed')
      return
    }

    setStatus(attempt === 0 ? 'connecting' : 'reconnecting')

    let ws: WebSocket
    try {
      ws = socketFactory(target.url, target.protocols)
    } catch {
      scheduleReconnect()
      return
    }
    socket = ws

    ws.onopen = () => {
      attempt = 0
      hasEverOpened = true
      setStatus('open')
    }

    ws.onmessage = (message: MessageEvent) => {
      const parsed = parse(message.data)
      /* A frame we cannot read is dropped, not thrown. One malformed message
         must not take down a dashboard that is otherwise fine. */
      if (parsed === null) return
      for (const listener of eventListeners) listener(parsed)
    }

    ws.onerror = () => {
      /* onerror is always followed by onclose, so reconnecting is handled
         there - doing it in both places double-schedules. */
    }

    ws.onclose = () => {
      socket = null
      if (stopped) {
        setStatus('closed')
        return
      }
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (!hasEverOpened && attempt >= WS_MAX_INITIAL_ATTEMPTS) {
      /* Never connected once. Something is wrong with the token or the config,
         and no amount of retrying fixes either. "Not connected" is the honest
         status; "Reconnecting..." forever is not. */
      setStatus('closed')
      return
    }

    setStatus('reconnecting')
    const delay = backoffDelay(attempt)
    attempt += 1
    retryHandle = scheduleRetry(() => {
      retryHandle = null
      connect()
    }, delay)
  }

  connect()

  return {
    get status() {
      return status
    },
    subscribe(onEvent) {
      eventListeners.add(onEvent)
      return () => eventListeners.delete(onEvent)
    },
    onStatusChange(listener) {
      statusListeners.add(listener)
      listener(status)
      return () => statusListeners.delete(listener)
    },
    close() {
      stopped = true
      if (retryHandle !== null) {
        cancelRetry(retryHandle)
        retryHandle = null
      }
      eventListeners.clear()
      if (socket) {
        socket.onclose = null
        socket.close()
        socket = null
      }
      setStatus('closed')
      statusListeners.clear()
    },
  }
}

/** Parses a JSON socket frame into an object, or null if it is unreadable. */
export function parseJsonFrame(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null

  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}
