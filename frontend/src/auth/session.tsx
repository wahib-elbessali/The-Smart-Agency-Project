import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { login, refreshSession, type Credentials } from '@/api/endpoints/auth'
import { MIN_REFRESH_DELAY_MS, readExpiry, refreshDelayFor } from '@/api/jwt'
import { setRefreshHandler } from '@/api/sessionBridge'
import {
  clearSession,
  getSession,
  isRestoringSession,
  setSession,
  subscribeToSession,
  waitForSessionRestore,
} from '@/api/tokenStore'
import { SessionContext, type SessionStatus, type SessionValue } from './SessionContext'
import type { LoginResponse, User } from '@/api/types'

/**
 * Holds session state, performs sign-in, and keeps the access token alive.
 *
 * Keeping it alive is the point of most of this file. Access tokens expire
 * after 30 minutes. Without a refresh, a wall-mounted dashboard silently stops
 * updating half an hour after someone signed it in, with no indication beyond
 * the panels going stale - which is the failure mode this whole screen was
 * designed to avoid.
 *
 * Two mechanisms, deliberately:
 *
 *   1. Proactive - a timer fires ahead of expiry so nothing ever 401s in normal
 *      operation. This is the one that should always win.
 *   2. Reactive - client.ts retries a 401 once after refreshing. Timers do not
 *      fire on a sleeping machine, and a dashboard that has been asleep is
 *      exactly the case where nobody is watching to fix it.
 *
 * The session survives a page reload: tokenStore mirrors it into sessionStorage
 * (per tab, cleared when the tab closes; see tokenStore.ts and SECURITY.md for
 * what that trades away). On load a stored session is picked up as-is, and its
 * access token is refreshed straight away if it has already expired or is about
 * to - a reload an hour later must not start with a wave of 401s.
 *
 * It is also shared between the browser's open tabs (tokenStore.ts): a new tab
 * starts "unknown" while it asks the others for the session, then settles, and
 * a sign-out, sign-in or refresh in one tab reaches the rest.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  /* Starts from whatever tokenStore restored from sessionStorage, if anything;
     "unknown" while a new tab is still asking the other tabs. */
  const [status, setStatus] = useState<SessionStatus>(() =>
    getSession() ? 'authenticated' : isRestoringSession() ? 'unknown' : 'anonymous',
  )
  const [user, setUser] = useState<User | null>(() => getSession()?.user ?? null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const signOut = useCallback(() => {
    clearTimer()
    clearSession()
    setUser(null)
    setStatus('anonymous')
  }, [clearTimer])

  /* Declared as a ref so adopt() and refreshNow() can call each other without
     either needing to exist first. */
  const refreshNowRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false))

  const adopt = useCallback(
    (response: LoginResponse) => {
      setSession({
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        user: response.user,
      })
      setUser(response.user)
      setStatus('authenticated')

      clearTimer()

      /* If the token carries no readable expiry we simply do not schedule, and
         the 401 backstop covers it. Guessing an interval would be worse: too
         short hammers the backend, too long fails silently. */
      const expiry = readExpiry(response.access_token)
      if (!expiry) return

      /* Never refresh immediately, even when the token is already at its
         expiry. JWT `exp` has one-second granularity, so a refresh inside the
         same second as the previous issue returns a byte-identical token with
         an unchanged expiry - and refreshing immediately on that would be an
         unbounded loop, precisely in the near-expiry case this code exists for.
         Waiting the floor guarantees the next `iat` lands in a later second.
         Found by testing against the real backend, not by reasoning. */
      const delay = refreshDelayFor(expiry) ?? MIN_REFRESH_DELAY_MS

      timerRef.current = setTimeout(() => {
        void refreshNowRef.current()
      }, delay)
    },
    [clearTimer],
  )

  const refreshNow = useCallback(async (): Promise<boolean> => {
    const current = getSession()
    if (!current) return false

    try {
      adopt(await refreshSession(current.refreshToken))
      return true
    } catch {
      /* The refresh token is gone, expired or rejected. There is no third
         option and no amount of retrying changes it, so end the session
         cleanly and let the guard send them to the login screen. */
      signOut()
      return false
    }
  }, [adopt, signOut])

  refreshNowRef.current = refreshNow

  /* A restored or adopted session never went through adopt(), so nothing is
     scheduled for it. Do the same job here: refresh now if the token is already
     (or nearly) expired, otherwise set the timer. Scheduling is repeatable on
     purpose - StrictMode mounts, unmounts (which clears the timer) and mounts
     again - but the immediate refresh is guarded so it is only fired once. */
  const restoredRefreshRef = useRef(false)
  const scheduleForStoredSession = useCallback(() => {
    const restored = getSession()
    if (!restored) return
    const expiry = readExpiry(restored.accessToken)
    if (!expiry) return

    const delay = refreshDelayFor(expiry)
    if (delay === null) {
      if (!restoredRefreshRef.current) {
        restoredRefreshRef.current = true
        void refreshNowRef.current()
      }
      return
    }
    clearTimer()
    timerRef.current = setTimeout(() => {
      void refreshNowRef.current()
    }, delay)
  }, [clearTimer])

  useEffect(() => {
    scheduleForStoredSession()
  }, [scheduleForStoredSession])

  /* Follow the other tabs. Only changes that came FROM another tab are acted on:
     this tab's own sign-in already sets its state and timer in adopt(), and
     rescheduling it here could refresh an almost-expired token in a loop. */
  useEffect(() => {
    const sync = () => {
      const stored = getSession()
      setUser(stored?.user ?? null)
      setStatus(stored ? 'authenticated' : 'anonymous')
      if (stored) {
        restoredRefreshRef.current = false
        scheduleForStoredSession()
      } else {
        clearTimer()
      }
    }
    const stop = subscribeToSession((_session, origin) => {
      if (origin === 'remote') sync()
    })
    let cancelled = false
    if (isRestoringSession()) {
      void waitForSessionRestore().then(() => {
        if (!cancelled) sync()
      })
    }
    return () => {
      cancelled = true
      stop()
    }
  }, [clearTimer, scheduleForStoredSession])

  const signIn = useCallback(
    async (credentials: Credentials) => {
      adopt(await login(credentials))
    },
    [adopt],
  )

  /* Lets client.ts trigger a refresh on a 401 without importing this module,
     which would be a cycle. */
  useEffect(() => {
    setRefreshHandler(() => refreshNowRef.current())
    return () => setRefreshHandler(null)
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const value = useMemo<SessionValue>(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut],
  )

  return <SessionContext value={value}>{children}</SessionContext>
}
