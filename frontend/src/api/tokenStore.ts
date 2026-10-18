import type { User } from './types'

/**
 * The signed-in session: access token, refresh token and the user.
 *
 * Held in a module variable, mirrored into sessionStorage, and shared between
 * the browser's open tabs. That is a decision made on 2026-10-02 in two steps:
 * first so a page reload no longer signs you out, then so a new tab does not
 * either. The earlier rule (SECURITY.md) kept tokens in memory only, so script
 * injected by an XSS could not read them back out; that protection is what was
 * traded away, and SECURITY.md says so.
 *
 *   - sessionStorage survives a reload of the same tab and ends when the tab
 *     closes, but it is per tab, so a NEW tab starts empty.
 *   - A new tab therefore asks the other open tabs for the session over a
 *     same-origin BroadcastChannel and adopts the answer. Nothing is written to
 *     localStorage on purpose: with it the session would outlive the browser
 *     for the refresh token's whole lifetime (three and a half days), whereas
 *     this ends when the last tab closes.
 *   - Signing out in one tab signs out the rest, and a sign-in or a token
 *     refresh in one tab is passed to the others, so none is left holding a
 *     stale token.
 *
 * Reading and writing storage can throw (private windows, blocked site data),
 * BroadcastChannel can be missing, and a stored or received session can be
 * stale or hand-made, so every access is guarded and a session is shape-checked
 * before it is trusted. Anything wrong simply means "not signed in", never a
 * crash. The server stays the only authority on whether a token is valid.
 *
 * Not React state, because api/client.ts has to read it and client.ts is not a
 * component. Subscribers get notified so the UI can still react.
 */

interface Session {
  accessToken: string
  refreshToken: string
  user: User
}

export const SESSION_STORAGE_KEY = 'smartagency.session'
const CHANNEL_NAME = 'smartagency.session'

/** How long a new tab waits for another tab to answer before concluding there
 * is nobody signed in. Same-origin broadcasts arrive in a few milliseconds. */
export const RESTORE_TIMEOUT_MS = 300

type Message = { type: 'request' } | { type: 'session'; session: Session } | { type: 'signout' }

/** Where a change came from, so the UI only reschedules for tabs' remote ones. */
export type ChangeOrigin = 'local' | 'remote'

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken !== '' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.user === 'object' &&
    candidate.user !== null &&
    typeof (candidate.user as Record<string, unknown>).role === 'string'
  )
}

function readStored(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (isSession(parsed)) return parsed
    sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    /* Unreadable or blocked storage: start signed out. */
  }
  return null
}

function writeStored(session: Session | null): void {
  try {
    if (session === null) sessionStorage.removeItem(SESSION_STORAGE_KEY)
    else sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    /* Cannot persist; the in-memory session still works for this page load. */
  }
}

let current: Session | null = readStored()
const listeners = new Set<(session: Session | null, origin: ChangeOrigin) => void>()

function notify(origin: ChangeOrigin): void {
  for (const listener of listeners) listener(current, origin)
}

/* --- sharing with other tabs ------------------------------------------- */

let channel: BroadcastChannel | null = null
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
    /* Node's channel would otherwise keep a test process alive; browsers have
       no such method. */
    ;(channel as unknown as { unref?: () => void }).unref?.()
  }
} catch {
  channel = null
}

function post(message: Message): void {
  try {
    channel?.postMessage(message)
  } catch {
    /* Nobody to tell. */
  }
}

let restoring = false
const restoreWaiters = new Set<() => void>()

function finishRestore(): void {
  if (!restoring) return
  restoring = false
  for (const waiter of restoreWaiters) waiter()
  restoreWaiters.clear()
}

if (channel) {
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Message | null
    if (!message || typeof message !== 'object') return

    if (message.type === 'request') {
      if (current) post({ type: 'session', session: current })
    } else if (message.type === 'session' && isSession(message.session)) {
      /* Adopt it if this tab has nothing, or if it is the same person's newer
         tokens. A different user's session is never swapped in underneath a tab
         that is already signed in as someone else. */
      if (current === null || current.user.id === message.session.user.id) {
        current = message.session
        writeStored(current)
        notify('remote')
      }
      finishRestore()
    } else if (message.type === 'signout') {
      if (current !== null) {
        current = null
        writeStored(null)
        notify('remote')
      }
    }
  }
}

/**
 * Called once from the app entry point, not at import: it is only meaningful in
 * a real browser, and tests that render the provider expect to start signed out
 * immediately. A tab that restored nothing from its own sessionStorage asks
 * the other tabs; until one answers (or the timeout passes) the session is
 * "unknown" rather than "anonymous", so the route guard waits instead of
 * bouncing to the login screen.
 */
export function beginSessionRestore(): void {
  if (current !== null || channel === null || restoring) return
  restoring = true
  post({ type: 'request' })
  setTimeout(finishRestore, RESTORE_TIMEOUT_MS)
}

export function isRestoringSession(): boolean {
  return restoring
}

/** Resolves when a restore in progress has settled, immediately if none is. */
export function waitForSessionRestore(): Promise<void> {
  return restoring
    ? new Promise((resolve) => {
        restoreWaiters.add(resolve)
      })
    : Promise.resolve()
}

/** Stop listening to and talking to other tabs. For teardown and tests, where
 * several copies of this module share one process. */
export function closeSessionSharing(): void {
  try {
    channel?.close()
  } catch {
    /* already closed */
  }
  channel = null
  finishRestore()
}

/* --- the public surface ------------------------------------------------- */

export function getSession(): Session | null {
  return current
}

export function getAccessToken(): string | null {
  return current?.accessToken ?? null
}

export function setSession(session: Session | null): void {
  current = session
  writeStored(session)
  post(session ? { type: 'session', session } : { type: 'signout' })
  notify('local')
}

export function clearSession(): void {
  setSession(null)
}

export function subscribeToSession(
  listener: (session: Session | null, origin: ChangeOrigin) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type { Session }
