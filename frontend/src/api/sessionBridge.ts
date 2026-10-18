/**
 * A one-function hand-off between the API client and the session.
 *
 * The problem it solves is a cycle: client.ts needs to refresh a token when it
 * sees a 401, but refreshing means calling an endpoint module, which calls
 * client.ts. Rather than tangle those, the session registers a handler here and
 * client.ts calls it without knowing what it does.
 *
 * The deduplication matters as much as the indirection. The presence screen
 * fires three requests at once; when the token expires, all three get 401 in
 * the same tick. Without a shared in-flight promise that is three refreshes,
 * and since the backend rotates the refresh token on every call, two of them
 * would be using one that has already been replaced.
 */

type RefreshHandler = () => Promise<boolean>

let handler: RefreshHandler | null = null
let inFlight: Promise<boolean> | null = null

export function setRefreshHandler(next: RefreshHandler | null): void {
  handler = next
}

/** True if a fresh token is now in the store. False if there is no way to get one. */
export function attemptRefresh(): Promise<boolean> {
  const handlerRef = handler
  if (!handlerRef) return Promise.resolve(false)
  if (inFlight) return inFlight

  /* Promise.resolve().then(...) rather than handler() directly: a handler that
     throws SYNCHRONOUSLY would otherwise escape this function entirely and
     leave inFlight unassigned, so the lock is never released and nothing can
     ever refresh again. Found by a test, not by reasoning. */
  inFlight = Promise.resolve()
    .then(() => handlerRef())
    .catch(() => false)
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/** Tests only - the module-level state would otherwise leak between them. */
export function resetSessionBridge(): void {
  handler = null
  inFlight = null
}
