import { afterEach, describe, expect, it, vi } from 'vitest'

describe('fetchJson against a real backend', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  async function loadClient() {
    vi.stubEnv('VITE_USE_MOCKS', 'false')
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.test')
    vi.resetModules()
    return {
      client: await import('./client'),
      tokenStore: await import('./tokenStore'),
    }
  }

  it('sends the bearer token on an authenticated endpoint', async () => {
    const { client, tokenStore } = await loadClient()
    tokenStore.setSession({
      accessToken: 'JWT123',
      refreshToken: 'R',
      user: {
        id: 'u1',
        full_name: 'Leila Fassi',
        email: 'leila@agency.com',
        role: 'MANAGER',
        agency_id: 'a1',
        is_active: true,
      },
    })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )

    await client.fetchJson({ key: 'k', path: '/api/employees', auth: true })

    const headers = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe('Bearer JWT123')
    tokenStore.clearSession()
  })

  /* Failing before the request goes out means the screen says "you are signed
     out" instead of having to interpret a bare 401. */
  it('fails with 401 rather than sending an unauthenticated request', async () => {
    const { client, tokenStore } = await loadClient()
    tokenStore.clearSession()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(
      client.fetchJson({ key: 'k', path: '/api/employees', auth: true }),
    ).rejects.toMatchObject({ kind: 'http', status: 401 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never attaches a token to an endpoint that did not ask for one', async () => {
    const { client, tokenStore } = await loadClient()
    tokenStore.setSession({
      accessToken: 'JWT123',
      refreshToken: 'R',
      user: {
        id: 'u1',
        full_name: 'A',
        email: 'a@b.c',
        role: 'ADMIN',
        agency_id: null,
        is_active: true,
      },
    })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )

    await client.fetchJson({ key: 'k', path: '/api/auth/login', method: 'POST' }, { body: {} })

    const headers = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    tokenStore.clearSession()
  })
})

describe('401 retry after refresh', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.restoreAllMocks()
  })

  async function load() {
    vi.stubEnv('VITE_USE_MOCKS', 'false')
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.test')
    vi.resetModules()
    const client = await import('./client')
    const tokenStore = await import('./tokenStore')
    const bridge = await import('./sessionBridge')

    tokenStore.setSession({
      accessToken: 'STALE',
      refreshToken: 'R',
      user: {
        id: 'u1',
        full_name: 'Leila Fassi',
        email: 'leila@agency.com',
        role: 'MANAGER',
        agency_id: 'a1',
        is_active: true,
      },
    })

    return { client, tokenStore, bridge }
  }

  const unauthorized = () => new Response('{"detail":"Not authenticated"}', { status: 401 })
  const ok = () =>
    new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('refreshes once and retries when an authenticated call gets 401', async () => {
    const { client, tokenStore, bridge } = await load()

    bridge.setRefreshHandler(async () => {
      tokenStore.setSession({ ...tokenStore.getSession()!, accessToken: 'FRESH' })
      return true
    })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok())

    await client.fetchJson({ key: 'k', path: '/api/employees', auth: true })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const retryHeaders = (fetchSpy.mock.calls[1][1]?.headers ?? {}) as Record<string, string>
    /* The retry has to carry the NEW token - retrying with the stale one would
       just 401 again and look like the refresh silently did nothing. */
    expect(retryHeaders.Authorization).toBe('Bearer FRESH')

    bridge.resetSessionBridge()
    tokenStore.clearSession()
  })

  it('gives up after one retry rather than looping', async () => {
    const { client, tokenStore, bridge } = await load()
    bridge.setRefreshHandler(async () => true)

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized())

    await expect(
      client.fetchJson({ key: 'k', path: '/api/employees', auth: true }),
    ).rejects.toMatchObject({ status: 401 })

    expect(fetchSpy).toHaveBeenCalledTimes(2)

    bridge.resetSessionBridge()
    tokenStore.clearSession()
  })

  /* A 403 is a permissions problem - AGENT and TECHNICIAN genuinely cannot read
     /api/attendance/today. No token fixes that, so retrying would hammer the
     backend for nothing. */
  it('does not retry a 403', async () => {
    const { client, tokenStore, bridge } = await load()
    let refreshes = 0
    bridge.setRefreshHandler(async () => {
      refreshes += 1
      return true
    })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"detail":"Acces limite"}', { status: 403 }))

    await expect(
      client.fetchJson({ key: 'k', path: '/api/attendance/today', auth: true }),
    ).rejects.toMatchObject({ status: 403 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(refreshes).toBe(0)

    bridge.resetSessionBridge()
    tokenStore.clearSession()
  })

  /* Login has auth: false. A 401 there means wrong password, and refreshing
     would be nonsense. */
  it('does not retry an unauthenticated endpoint', async () => {
    const { client, bridge } = await load()
    let refreshes = 0
    bridge.setRefreshHandler(async () => {
      refreshes += 1
      return true
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(unauthorized())

    await expect(
      client.fetchJson({ key: 'k', path: '/api/auth/login', method: 'POST' }, { body: {} }),
    ).rejects.toMatchObject({ status: 401 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(refreshes).toBe(0)

    bridge.resetSessionBridge()
  })
})
