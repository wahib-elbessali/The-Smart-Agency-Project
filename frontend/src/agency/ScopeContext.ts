import { createContext, use } from 'react'

/**
 * The agency an admin is currently working inside, or null for all of them.
 *
 * THIS IS A VIEW FILTER, NOT A PERMISSION, and the difference matters enough to
 * say twice. An admin is entitled to every branch; this narrows what they are
 * looking at because they asked it to. A MANAGER's data arrives already scoped
 * by the backend and this does nothing for them - filtering their rows here
 * would be the frontend enforcing a boundary it does not own, which
 * api/endpoints/agencies.ts warns against in as many words.
 *
 * Because it is a lens rather than a rule, it has to be visible the entire time
 * it is on. An admin who forgets they are inside one branch and reads a total as
 * the whole estate is worse off than one who never had the control - hence the
 * bar in AppShell, which cannot be dismissed without leaving the branch.
 *
 * Kept in sessionStorage so it survives a reload, for the same user only (see
 * scope.tsx): signing out or previewing another role drops it.
 */
export interface ScopeValue {
  /** The chosen agency id, or null when looking at everything. */
  agencyId: string | null
  /** For the bar and the empty states - null whenever agencyId is. */
  agencyName: string | null
  enter(agency: { id: string; name: string }): void
  leave(): void
}

export const ScopeContext = createContext<ScopeValue | null>(null)

export function useScope(): ScopeValue {
  const value = use(ScopeContext)
  if (!value) throw new Error('useScope must be used inside a ScopeProvider')
  return value
}

/**
 * Applies the scope to any list of rows carrying an agency_id.
 *
 * Kept beside the context so every screen filters the same way and none of them
 * has to decide what "no scope" means. Null scope returns the list untouched -
 * it must, or an admin who never opened a branch would see nothing at all.
 */
export function withinScope<T extends { agency_id: string }>(
  rows: T[],
  agencyId: string | null,
): T[] {
  if (agencyId === null) return rows
  return rows.filter((row) => row.agency_id === agencyId)
}
