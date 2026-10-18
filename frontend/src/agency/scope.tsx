import { useCallback, useEffect, useMemo, useState, use, type ReactNode } from 'react'
import { SessionContext } from '@/auth/SessionContext'
import { ScopeContext, type ScopeValue } from './ScopeContext'

/**
 * Holds the branch an admin is working inside.
 *
 * Only an ADMIN can be inside one, because only an ADMIN has more than one to
 * choose from - every other role already receives a single agency's data from
 * the backend, and giving them a control that could only ever select what they
 * already have would suggest they had a choice.
 *
 * Kept in sessionStorage so a page reload does not silently drop an admin back
 * to the first branch - which the screens would then present as if it were the
 * one they had chosen. Per tab on purpose: two tabs can look at two branches.
 * The stored choice records WHOSE it is, and is only honoured for that same
 * user, so signing out, or a different person signing in on the tab, never
 * inherits it.
 *
 * Dropped on any change of who is signed in. That covers signing out, and it
 * covers the fixture-mode role preview: coming back as a MANAGER while still
 * holding an admin's chosen branch would filter their already-filtered data
 * against a branch that is not theirs, and quietly show them nothing.
 */

export const SCOPE_STORAGE_KEY = 'smartagency.scope'

interface Scoped {
  id: string
  name: string
}

interface StoredScope extends Scoped {
  userId: string
}

function readStored(userId: string | null): Scoped | null {
  if (userId === null) return null
  try {
    const raw = sessionStorage.getItem(SCOPE_STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<StoredScope> | null
    if (
      parsed &&
      typeof parsed.id === 'string' &&
      parsed.id !== '' &&
      typeof parsed.name === 'string' &&
      parsed.userId === userId
    ) {
      return { id: parsed.id, name: parsed.name }
    }
  } catch {
    /* Unreadable storage or a corrupt value: no branch chosen. */
  }
  return null
}

function writeStored(userId: string | null, scoped: Scoped | null): void {
  try {
    if (userId === null || scoped === null) sessionStorage.removeItem(SCOPE_STORAGE_KEY)
    else
      sessionStorage.setItem(
        SCOPE_STORAGE_KEY,
        JSON.stringify({ userId, id: scoped.id, name: scoped.name } satisfies StoredScope),
      )
  } catch {
    /* Cannot persist; the choice still holds for this page load. */
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  /* Read straight from the context rather than through useSession, which
     throws. This provider sits above the router and has a sensible answer with
     no session at all - nobody is signed in, so nobody is inside a branch - and
     refusing to render would make it the one provider that cannot be mounted
     on its own. */
  const user = use(SessionContext)?.user ?? null
  const isAdmin = user?.role === 'ADMIN'
  const userId = user?.id ?? null

  const [scoped, setScoped] = useState<Scoped | null>(() => readStored(userId))

  /* When who is signed in changes, take the stored choice only if it is that
     person's, otherwise let go of it. On the first render this finds the same
     value the initial state already read, so a reload keeps the branch. */
  useEffect(() => {
    setScoped(readStored(userId))
    if (userId === null) writeStored(null, null)
  }, [userId])

  const enter = useCallback(
    (agency: { id: string; name: string }) => {
      const next = { id: agency.id, name: agency.name }
      setScoped(next)
      writeStored(userId, next)
    },
    [userId],
  )

  const leave = useCallback(() => {
    setScoped(null)
    writeStored(userId, null)
  }, [userId])

  const value = useMemo<ScopeValue>(
    () => ({
      /* Held but not applied for a non-admin, so a role preview that lands
         mid-session cannot filter data it has no business filtering. */
      agencyId: isAdmin ? (scoped?.id ?? null) : null,
      agencyName: isAdmin ? (scoped?.name ?? null) : null,
      enter,
      leave,
    }),
    [isAdmin, scoped, enter, leave],
  )

  return <ScopeContext value={value}>{children}</ScopeContext>
}
