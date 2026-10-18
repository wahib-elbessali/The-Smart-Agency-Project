/**
 * Reading the expiry out of an access token.
 *
 * This is **decoding, not verifying**. A JWT's payload is base64url, not
 * encrypted - anyone can read it, including us, and a client cannot check the
 * signature because it does not have the key. So nothing here is a security
 * check and none of it may be used as one: the server is the only authority on
 * whether a token is valid, and it re-checks on every request.
 *
 * The single legitimate use is scheduling. Knowing roughly when the token
 * expires lets the session refresh it *before* the dashboard breaks, instead of
 * discovering it through a wave of 401s. If the claim is missing, malformed or
 * lying, the worst case is that we schedule badly and fall back to the 401
 * path - which is why every failure here returns null rather than throwing.
 */

interface JwtPayload {
  exp?: unknown
}

function decodeSegment(segment: string): unknown {
  /* base64url -> base64: JWT uses the URL-safe alphabet and drops padding. */
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')

  try {
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

/** Expiry as a Date, or null if the token does not carry a usable one. */
export function readExpiry(token: string): Date | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null

  const payload = decodeSegment(segments[1]) as JwtPayload | null
  if (!payload || typeof payload !== 'object') return null

  /* `exp` is seconds since the epoch, per RFC 7519 - not milliseconds. */
  const exp = payload.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null

  return new Date(exp * 1000)
}

/**
 * When to refresh, given an expiry.
 *
 * Early enough that a slow network or a brief backend hiccup still leaves room
 * for a retry before anything user-visible breaks, and never so early that a
 * short-lived token refreshes in a tight loop.
 *
 * Returns null when the token is already expired or so close to it that there
 * is no point scheduling - the caller should refresh immediately instead.
 */
export const REFRESH_LEAD_MS = 60_000
export const MIN_REFRESH_DELAY_MS = 5_000

export function refreshDelayFor(expiry: Date, now: Date = new Date()): number | null {
  const remaining = expiry.getTime() - now.getTime()
  if (remaining <= MIN_REFRESH_DELAY_MS) return null

  /* Refresh a minute early, or at 80% of whatever is left if the token is
     shorter-lived than that - a 30-second token must not schedule in the past. */
  const lead = Math.min(REFRESH_LEAD_MS, remaining * 0.2)
  return Math.max(MIN_REFRESH_DELAY_MS, remaining - lead)
}
