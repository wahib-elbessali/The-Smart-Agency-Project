import { afterEach, describe, expect, it, vi } from 'vitest'
import type { User } from './types'

/* Each "tab" is a separate copy of the module, talking to the others over a
 * real BroadcastChannel - the same wiring two browser tabs have. */
type Store = typeof import('./tokenStore')
const opened: Store[] = []

async function openTab(): Promise<Store> {
  vi.resetModules()
  const store = await import('./tokenStore')
  opened.push(store)
  return store
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

const user = (id: string) => ({ id, full_name: id, email: `${id}@a.com`, role: 'MANAGER' }) as User
const session = (id: string, token = 'ACCESS') => ({
  accessToken: token,
  refreshToken: 'REFRESH',
  user: user(id),
})

describe('sharing the session between tabs', () => {
  afterEach(async () => {
    /* Let replies still in flight land before the copies are closed; one arriving
       late would otherwise be adopted by the next test's tabs. */
    await flush()
    for (const store of opened.splice(0)) store.closeSessionSharing()
    sessionStorage.clear()
  })

  it('has a BroadcastChannel to work with in this environment', () => {
    expect(typeof BroadcastChannel).toBe('function')
  })

  it('lets a new tab pick the session up from one that is signed in', async () => {
    const first = await openTab()
    first.setSession(session('u1'))
    await flush()
    sessionStorage.clear() /* a new tab has a sessionStorage of its own, empty */

    const second = await openTab()
    expect(second.getSession()).toBeNull()
    second.beginSessionRestore()
    expect(second.isRestoringSession()).toBe(true)
    await second.waitForSessionRestore()

    expect(second.getSession()?.accessToken).toBe('ACCESS')
    expect(second.getSession()?.user.id).toBe('u1')
    expect(second.isRestoringSession()).toBe(false)
  })

  it('settles as signed out when no other tab answers', async () => {
    const lonely = await openTab()
    lonely.beginSessionRestore()
    expect(lonely.isRestoringSession()).toBe(true)
    await lonely.waitForSessionRestore()
    expect(lonely.getSession()).toBeNull()
    expect(lonely.isRestoringSession()).toBe(false)
  })

  it('does not ask when the tab already has a session of its own', async () => {
    sessionStorage.setItem('smartagency.session', JSON.stringify(session('u1')))
    const tab = await openTab()
    tab.beginSessionRestore()
    expect(tab.isRestoringSession()).toBe(false)
  })

  it('signs the other tabs out when one signs out, and says it came from elsewhere', async () => {
    const first = await openTab()
    first.setSession(session('u1'))
    await flush()
    const second = await openTab()
    second.beginSessionRestore()
    await second.waitForSessionRestore()
    const seen: string[] = []
    second.subscribeToSession((s, origin) => seen.push(`${s ? 'in' : 'out'}:${origin}`))

    first.clearSession()
    await flush()

    expect(second.getSession()).toBeNull()
    expect(seen).toEqual(['out:remote'])
  })

  it('passes a sign-in or a token refresh on to a tab holding the same person', async () => {
    const first = await openTab()
    const second = await openTab()
    first.setSession(session('u1', 'OLD'))
    await flush()
    expect(second.getSession()?.accessToken).toBe('OLD')

    first.setSession(session('u1', 'NEW'))
    await flush()
    expect(second.getSession()?.accessToken).toBe('NEW')
  })

  it("never swaps a different person's session in under a tab that is signed in", async () => {
    const first = await openTab()
    const second = await openTab()
    second.setSession(session('u2', 'MINE'))
    await flush()
    first.setSession(session('u1', 'THEIRS'))
    await flush()
    expect(second.getSession()?.user.id).toBe('u2')
    expect(second.getSession()?.accessToken).toBe('MINE')
  })

  it('ignores messages that are not a valid session', async () => {
    const tab = await openTab()
    const raw = new BroadcastChannel('smartagency.session')
    raw.postMessage({ type: 'session', session: { accessToken: 'x' } })
    raw.postMessage({ type: 'session', session: null })
    raw.postMessage('nonsense')
    raw.postMessage({ type: 'unheard-of' })
    await flush()
    raw.close()
    expect(tab.getSession()).toBeNull()
  })

  it('only answers a request when it has something to give', async () => {
    const signedOut = await openTab()
    const asker = await openTab()
    asker.beginSessionRestore()
    await asker.waitForSessionRestore()
    expect(signedOut.getSession()).toBeNull()
    expect(asker.getSession()).toBeNull()
  })
})
