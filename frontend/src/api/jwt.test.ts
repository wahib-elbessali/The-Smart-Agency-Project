import { describe, expect, it } from 'vitest'
import { MIN_REFRESH_DELAY_MS, readExpiry, refreshDelayFor } from './jwt'

function tokenWith(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`
}

describe('readExpiry', () => {
  it('reads exp as seconds, not milliseconds', () => {
    /* RFC 7519 says seconds. Treating it as milliseconds puts expiry in 1970
       and refreshes in a tight loop. */
    const expiry = readExpiry(tokenWith({ exp: 1786022483 }))
    expect(expiry?.toISOString()).toBe('2026-08-06T13:21:23.000Z')
  })

  it('handles base64url padding', () => {
    expect(readExpiry(tokenWith({ exp: 1786022483, sub: 'a'.repeat(37) }))).not.toBeNull()
  })

  /* Every one of these returns null rather than throwing: this is scheduling
     input, not a security check, so a bad token must degrade to "don't
     schedule" and let the 401 backstop handle it. */
  it('returns null for anything unusable instead of throwing', () => {
    expect(readExpiry('not-a-jwt')).toBeNull()
    expect(readExpiry('a.b')).toBeNull()
    expect(readExpiry('a.!!!not-base64!!!.c')).toBeNull()
    expect(readExpiry(tokenWith({}))).toBeNull()
    expect(readExpiry(tokenWith({ exp: 'soon' }))).toBeNull()
    expect(readExpiry(tokenWith({ exp: Number.NaN }))).toBeNull()
  })
})

describe('refreshDelayFor', () => {
  const now = new Date('2026-08-06T12:00:00Z')
  const inMinutes = (n: number) => new Date(now.getTime() + n * 60_000)

  it('refreshes a 30-minute token a minute before it expires', () => {
    expect(refreshDelayFor(inMinutes(30), now)).toBe(29 * 60_000)
  })

  /* A short-lived token must not schedule in the past, which is what a fixed
     60s lead would do to a 30-second token. */
  it('scales the lead down for short-lived tokens', () => {
    const delay = refreshDelayFor(inMinutes(0.5), now)
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThan(30_000)
  })

  it('never returns a delay below the floor', () => {
    for (const seconds of [6, 8, 12, 20, 45]) {
      const delay = refreshDelayFor(new Date(now.getTime() + seconds * 1000), now)
      if (delay !== null) expect(delay).toBeGreaterThanOrEqual(MIN_REFRESH_DELAY_MS)
    }
  })

  it('returns null when the token is already expired or about to be', () => {
    expect(refreshDelayFor(inMinutes(-5), now)).toBeNull()
    expect(refreshDelayFor(new Date(now.getTime() + 1000), now)).toBeNull()
  })
})

describe('the one-second granularity trap', () => {
  /* Against the real backend, a refresh inside the same second as the previous
     issue returns a byte-identical token - same `iat`, same `exp`. Anything
     that reacts to "cannot schedule" by refreshing immediately spins. The
     session waits MIN_REFRESH_DELAY_MS instead, which guarantees the next
     token lands in a later second. */
  it('reports null rather than zero when a token cannot be scheduled', () => {
    const now = new Date('2026-08-06T12:00:00Z')
    const expired = new Date(now.getTime() - 1)
    expect(refreshDelayFor(expired, now)).toBeNull()
    expect(MIN_REFRESH_DELAY_MS).toBeGreaterThanOrEqual(1000)
  })
})
