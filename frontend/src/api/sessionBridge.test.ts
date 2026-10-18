import { afterEach, describe, expect, it } from 'vitest'
import { attemptRefresh, resetSessionBridge, setRefreshHandler } from './sessionBridge'

describe('attemptRefresh', () => {
  afterEach(resetSessionBridge)

  it('reports failure when nothing has registered a handler', async () => {
    expect(await attemptRefresh()).toBe(false)
  })

  /* The presence screen fires three requests at once. When the token expires
     they all 401 in the same tick, and the backend rotates the refresh token on
     every call - so three refreshes would mean two of them using one that has
     already been replaced. */
  it('collapses concurrent callers into a single refresh', async () => {
    let calls = 0
    let release: (value: boolean) => void = () => {}
    setRefreshHandler(() => {
      calls += 1
      return new Promise<boolean>((resolve) => {
        release = resolve
      })
    })

    const all = Promise.all([attemptRefresh(), attemptRefresh(), attemptRefresh()])

    /* The handler runs on a microtask, not synchronously - that deferral is
       what makes a synchronous throw catchable. So let it be invoked before
       releasing it. */
    await new Promise((resolve) => setTimeout(resolve, 0))
    release(true)

    expect(await all).toEqual([true, true, true])
    expect(calls).toBe(1)
  })

  it('allows a fresh attempt once the previous one has settled', async () => {
    let calls = 0
    setRefreshHandler(() => {
      calls += 1
      return Promise.resolve(true)
    })

    await attemptRefresh()
    await attemptRefresh()
    expect(calls).toBe(2)
  })

  it('treats a throwing handler as failure rather than propagating', async () => {
    setRefreshHandler(() => Promise.reject(new Error('network')))
    expect(await attemptRefresh()).toBe(false)
    /* And the lock must be released, or nothing could ever refresh again. */
    setRefreshHandler(() => Promise.resolve(true))
    expect(await attemptRefresh()).toBe(true)
  })

  it('does not leave the lock held after a synchronous throw', async () => {
    setRefreshHandler(() => {
      throw new Error('boom')
    })
    /* A synchronous throw must be absorbed like any other failure, not
       propagated to a caller that only wanted to know true or false. */
    expect(await attemptRefresh()).toBe(false)
    setRefreshHandler(() => Promise.resolve(true))
    expect(await attemptRefresh()).toBe(true)
  })
})
