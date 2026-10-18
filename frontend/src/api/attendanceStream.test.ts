import { afterEach, describe, expect, it, vi } from 'vitest'
import { backoffDelay, buildSocketTarget, parseFrame } from './attendanceStream'

describe('buildSocketTarget', () => {
  /* These three nulls are the whole safety property: the socket refuses to
     open rather than connecting unauthenticated and rendering a calm, empty,
     silently-wrong list. */
  it('refuses without a token', () => {
    expect(buildSocketTarget(null, 'query', 'ws://api.test')).toBeNull()
  })

  it('refuses when the auth mode has not been configured', () => {
    expect(buildSocketTarget('jwt', null, 'ws://api.test')).toBeNull()
  })

  it('refuses without a base url', () => {
    expect(buildSocketTarget('jwt', 'query', '')).toBeNull()
  })

  /* Measured against the running backend: the query parameter is the only
     mechanism it accepts. A subprotocol handshake and an Authorization header
     are both rejected with 403, so neither is offered. */
  it('puts the token in the query string, and sends no subprotocol', () => {
    const target = buildSocketTarget('jwt', 'query', 'ws://api.test')
    expect(target?.url).toBe('ws://api.test/ws/attendance?token=jwt')
    expect(target?.protocols).toBeUndefined()
  })
})

describe('backoffDelay', () => {
  it('never drops below the floor or above the ceiling', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = backoffDelay(attempt)
      expect(delay).toBeGreaterThanOrEqual(1_000)
      expect(delay).toBeLessThanOrEqual(30_000)
    }
  })
})

describe('parseFrame', () => {
  const valid = JSON.stringify({
    type: 'attendance_updated',
    event: 'check_in',
    employee_id: 'emp-1',
    employee_name: 'Hamza Benali',
    agency_id: 'agency-1',
    check_in: '2026-08-05T08:30:00Z',
    check_out: null,
    method: 'RFID',
    device_id: 'device-1',
  })

  it('parses a contract-shaped frame', () => {
    expect(parseFrame(valid)?.employee_id).toBe('emp-1')
  })

  /* One malformed message must not take down a dashboard that is otherwise
     fine, so these all return null instead of throwing. */
  it('drops malformed frames instead of throwing', () => {
    expect(parseFrame('{not json')).toBeNull()
    expect(parseFrame(JSON.stringify({ type: 'attendance_updated' }))).toBeNull()
    expect(parseFrame(JSON.stringify(null))).toBeNull()
    expect(parseFrame(new ArrayBuffer(4))).toBeNull()
  })

  it('keeps a frame whose event value is not one the contract documents', () => {
    const amended = JSON.parse(valid) as Record<string, unknown>
    amended.event = 'attendance_amended'
    expect(parseFrame(JSON.stringify(amended))?.event).toBe('attendance_amended')
  })
})

describe('createLiveAttendanceStream reconnect policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  /* The module reads WS_AUTH_MODE and WS_BASE_URL at import time, and both are
     unset by default - deliberately, so an unconfigured socket refuses to
     connect. Stub them and re-import to exercise the connected path. */
  async function harness() {
    vi.stubEnv('VITE_USE_MOCKS', 'false')
    vi.stubEnv('VITE_API_BASE_URL', 'http://api.test')
    vi.stubEnv('VITE_WS_AUTH_MODE', 'query')
    vi.resetModules()

    const mod = await import('./attendanceStream')
    const { WS_MAX_INITIAL_ATTEMPTS } = await import('./config')

    const sockets: WebSocket[] = []
    const pending: Array<() => void> = []

    const stream = mod.createLiveAttendanceStream({
      tokenProvider: () => 'jwt',
      socketFactory: () => {
        const ws = { close: () => {} } as unknown as WebSocket
        sockets.push(ws)
        return ws
      },
      scheduleRetry: (fn) => {
        pending.push(fn)
        return pending.length
      },
      cancelRetry: () => {},
    })

    return {
      stream,
      sockets,
      max: WS_MAX_INITIAL_ATTEMPTS,
      drop: () => sockets[sockets.length - 1].onclose?.(new CloseEvent('close')),
      open: () => sockets[sockets.length - 1].onopen?.(new Event('open')),
      runPendingRetry: () => pending.shift()?.(),
    }
  }

  /* A socket that has never opened is bad config or a dead token, and the
     backend rejects both during the handshake - so the browser gets no status
     code and cannot tell them from an outage. Retrying forever would leave the
     badge reading "Reconnecting..." for something that will never succeed. */
  it('gives up after WS_MAX_INITIAL_ATTEMPTS if it never opens', async () => {
    const h = await harness()

    for (let i = 0; i < 20; i += 1) {
      h.drop()
      h.runPendingRetry()
    }

    expect(h.stream.status).toBe('closed')
    expect(h.sockets.length).toBeLessThanOrEqual(h.max + 1)
  })

  /* A socket that opened and then dropped is a transient outage, and a
     wall-mounted dashboard has to recover from that unattended. */
  it('keeps retrying indefinitely once it has opened at least once', async () => {
    const h = await harness()

    h.open()
    expect(h.stream.status).toBe('open')

    for (let i = 0; i < 20; i += 1) {
      h.drop()
      h.runPendingRetry()
    }

    expect(h.stream.status).toBe('reconnecting')
    expect(h.sockets.length).toBeGreaterThan(h.max + 1)
  })
})

describe('env fallbacks treat empty as unset', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  /* .env.example ships `VITE_WS_BASE_URL=`, which parses as "" and is NOT
     nullish - so `??` would let it win over the derived fallback and leave the
     socket pointed at nothing, with no error anywhere. */
  it('derives the ws base from the api base when the ws base is empty', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://api.test')
    vi.stubEnv('VITE_WS_BASE_URL', '')
    vi.stubEnv('VITE_WS_AUTH_MODE', 'query')
    vi.resetModules()

    const { WS_BASE_URL, WS_AUTH_QUERY_PARAM } = await import('./config')
    expect(WS_BASE_URL).toBe('ws://api.test')
    expect(WS_AUTH_QUERY_PARAM).toBe('token')
  })
})
