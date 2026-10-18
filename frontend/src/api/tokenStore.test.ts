import { afterEach, describe, expect, it, vi } from 'vitest'
import type { User } from './types'

/* tokenStore hydrates from sessionStorage once, at import - so each test that
 * cares about that moment resets the module registry and imports a fresh copy. */
async function freshStore() {
  vi.resetModules()
  return import('./tokenStore')
}

const user = { id: 'u1', full_name: 'Test', email: 't@a.com', role: 'MANAGER' } as User
const stored = { accessToken: 'ACCESS', refreshToken: 'REFRESH', user }

describe('tokenStore persistence', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('writes the session to sessionStorage and removes it on clear', async () => {
    const store = await freshStore()
    store.setSession(stored)
    expect(JSON.parse(sessionStorage.getItem(store.SESSION_STORAGE_KEY) as string)).toEqual(stored)
    store.clearSession()
    expect(sessionStorage.getItem(store.SESSION_STORAGE_KEY)).toBeNull()
    expect(store.getAccessToken()).toBeNull()
  })

  it('restores a stored session when the module loads (a page reload)', async () => {
    sessionStorage.setItem('smartagency.session', JSON.stringify(stored))
    const store = await freshStore()
    expect(store.getAccessToken()).toBe('ACCESS')
    expect(store.getSession()?.user.role).toBe('MANAGER')
  })

  it('starts signed out when nothing is stored', async () => {
    expect((await freshStore()).getSession()).toBeNull()
  })

  it('treats corrupt or wrongly shaped storage as signed out, and clears it', async () => {
    for (const bad of [
      'not json',
      '{}',
      'null',
      '"a string"',
      JSON.stringify({ ...stored, accessToken: '' }),
      JSON.stringify({ ...stored, refreshToken: 5 }),
      JSON.stringify({ ...stored, user: null }),
      JSON.stringify({ ...stored, user: { id: 'x' } }),
    ]) {
      sessionStorage.setItem('smartagency.session', bad)
      const store = await freshStore()
      expect(store.getSession()).toBeNull()
    }
    expect(sessionStorage.getItem('smartagency.session')).toBeNull()
  })

  it('still works in memory when storage throws (private window, blocked site data)', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const store = await freshStore()
    expect(store.getSession()).toBeNull()
    expect(() => store.setSession(stored)).not.toThrow()
    expect(store.getAccessToken()).toBe('ACCESS')
  })

  it('notifies subscribers on set and clear', async () => {
    const store = await freshStore()
    const seen: (string | null)[] = []
    const stop = store.subscribeToSession((s) => seen.push(s?.accessToken ?? null))
    store.setSession(stored)
    store.clearSession()
    stop()
    store.setSession(stored)
    expect(seen).toEqual(['ACCESS', null])
  })
})
