import { renderHook, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from './session'
import { useSession } from './SessionContext'
import {
  beginSessionRestore,
  getAccessToken,
  setSession,
  SESSION_STORAGE_KEY,
} from '@/api/tokenStore'
import type { User } from '@/api/types'
import { attemptRefresh, resetSessionBridge } from '@/api/sessionBridge'
import '@/mocks'

describe('useSession', () => {
  it('starts anonymous when there is no stored session', () => {
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })
    expect(result.current.status).toBe('anonymous')
    expect(result.current.user).toBeNull()
  })

  it('signs in against the contract-shaped login fixture', async () => {
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    await act(async () => {
      await result.current.signIn({ email: 'leila@agency.com', password: 'whatever' })
    })

    expect(result.current.status).toBe('authenticated')
    expect(result.current.user?.role).toBe('MANAGER')
    expect(getAccessToken()).toBe('FIXTURE.ACCESS.TOKEN')
  })

  it('drops the token on sign-out', async () => {
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    await act(async () => {
      await result.current.signIn({ email: 'leila@agency.com', password: 'whatever' })
    })
    act(() => result.current.signOut())

    expect(result.current.status).toBe('anonymous')
    expect(getAccessToken()).toBeNull()
  })
})

describe('keeping the session alive', () => {
  afterEach(() => {
    resetSessionBridge()
    vi.useRealTimers()
  })

  /* The whole point: access tokens last 30 minutes, and a wall dashboard has
     nobody sitting in front of it to sign back in. */
  it('registers a refresh handler that client.ts can reach', async () => {
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    await act(async () => {
      await result.current.signIn({ email: 'leila@agency.com', password: 'whatever' })
    })
    expect(getAccessToken()).toBe('FIXTURE.ACCESS.TOKEN')

    /* client.ts calls this on a 401 without importing this module. */
    await act(async () => {
      expect(await attemptRefresh()).toBe(true)
    })

    await waitFor(() => {
      expect(getAccessToken()).toBe('FIXTURE.ACCESS.TOKEN.REFRESHED')
    })
    expect(result.current.status).toBe('authenticated')
  })

  it('signs out when the refresh token is no longer accepted', async () => {
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    await act(async () => {
      await result.current.signIn({ email: 'leila@agency.com', password: 'whatever' })
    })

    /* Nothing recovers from a rejected refresh token, so the session has to end
       cleanly rather than sit in a half-authenticated state. */
    const auth = await import('@/api/endpoints/auth')
    vi.spyOn(auth, 'refreshSession').mockRejectedValue(new Error('rejected'))

    await act(async () => {
      expect(await attemptRefresh()).toBe(false)
    })

    expect(result.current.status).toBe('anonymous')
    expect(result.current.user).toBeNull()
    expect(getAccessToken()).toBeNull()
  })
})

function jwtExpiringIn(seconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).split('+').join('-').split('/').join('_').split('=').join('')
  const exp = Math.floor(Date.now() / 1000) + seconds
  return `${encode({ alg: 'none' })}.${encode({ exp })}.sig`
}

const restoredUser = { id: 'u1', full_name: 'Restored', email: 'r@a.com', role: 'MANAGER' } as User

describe('restoring a session after a page reload', () => {
  beforeEach(() => {
    /* An earlier test's spy on refreshSession would otherwise carry its calls in. */
    vi.restoreAllMocks()
  })

  afterEach(() => {
    resetSessionBridge()
    vi.restoreAllMocks()
  })

  it('starts authenticated from the stored session, with no sign-in and no refresh needed', async () => {
    const auth = await import('@/api/endpoints/auth')
    const refresh = vi.spyOn(auth, 'refreshSession')
    setSession({ accessToken: jwtExpiringIn(1800), refreshToken: 'R', user: restoredUser })

    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    expect(result.current.status).toBe('authenticated')
    expect(result.current.user?.full_name).toBe('Restored')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes straight away when the restored token has already expired', async () => {
    const auth = await import('@/api/endpoints/auth')
    const refresh = vi.spyOn(auth, 'refreshSession').mockResolvedValue({
      access_token: 'NEW.ACCESS',
      refresh_token: 'NEW.REFRESH',
      token_type: 'bearer',
      user: restoredUser,
    } as Awaited<ReturnType<typeof auth.refreshSession>>)
    setSession({ accessToken: jwtExpiringIn(-60), refreshToken: 'OLD.REFRESH', user: restoredUser })

    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    await waitFor(() => expect(getAccessToken()).toBe('NEW.ACCESS'))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('OLD.REFRESH')
    expect(result.current.status).toBe('authenticated')
  })

  it('signs out cleanly if the restored session can no longer be refreshed', async () => {
    const auth = await import('@/api/endpoints/auth')
    vi.spyOn(auth, 'refreshSession').mockRejectedValue(new Error('rejected'))
    setSession({ accessToken: jwtExpiringIn(-60), refreshToken: 'DEAD', user: restoredUser })

    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    expect(getAccessToken()).toBeNull()
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('keeps a restored session whose token has no readable expiry, leaving it to the 401 path', async () => {
    const auth = await import('@/api/endpoints/auth')
    const refresh = vi.spyOn(auth, 'refreshSession')
    setSession({ accessToken: 'NOT.A.JWT', refreshToken: 'R', user: restoredUser })

    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    expect(result.current.status).toBe('authenticated')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('writes the session on sign-in and removes it on sign-out', async () => {
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })
    await act(async () => {
      await result.current.signIn({ email: 'leila@agency.com', password: 'whatever' })
    })
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) as string).accessToken).toBe(
      'FIXTURE.ACCESS.TOKEN',
    )
    act(() => result.current.signOut())
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })
})

describe('sharing the session between tabs', () => {
  type Store = typeof import('@/api/tokenStore')
  const otherTabs: Store[] = []

  /* Another tab is another copy of tokenStore talking over the same channel. */
  async function anotherTab(): Promise<Store> {
    vi.resetModules()
    const store = await import('@/api/tokenStore')
    otherTabs.push(store)
    return store
  }

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    for (const store of otherTabs.splice(0)) store.closeSessionSharing()
    resetSessionBridge()
    vi.restoreAllMocks()
  })

  it('waits as "unknown" while asking the other tabs, then settles signed out if nobody answers', async () => {
    beginSessionRestore()
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    expect(result.current.status).toBe('unknown')
    await waitFor(() => expect(result.current.status).toBe('anonymous'), { timeout: 2000 })
    expect(result.current.user).toBeNull()
  })

  it('becomes signed in when another tab hands its session over', async () => {
    beginSessionRestore()
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })
    expect(result.current.status).toBe('unknown')

    const other = await anotherTab()
    act(() => {
      other.setSession({ accessToken: 'NOT.A.JWT', refreshToken: 'R', user: restoredUser })
    })

    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(result.current.user?.full_name).toBe('Restored')
    expect(getAccessToken()).toBe('NOT.A.JWT')
  })

  it('is signed out when another tab signs out', async () => {
    setSession({ accessToken: 'NOT.A.JWT', refreshToken: 'R', user: restoredUser })
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })
    expect(result.current.status).toBe('authenticated')

    const other = await anotherTab()
    act(() => other.clearSession())

    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    expect(result.current.user).toBeNull()
    expect(getAccessToken()).toBeNull()
  })

  it('does not echo its own sign-in back as a remote change that reschedules it', async () => {
    const auth = await import('@/api/endpoints/auth')
    const refresh = vi.spyOn(auth, 'refreshSession')
    const { result } = renderHook(() => useSession(), { wrapper: SessionProvider })

    await act(async () => {
      await result.current.signIn({ email: 'leila@agency.com', password: 'whatever' })
    })
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(result.current.status).toBe('authenticated')
    expect(refresh).not.toHaveBeenCalled()
  })
})
