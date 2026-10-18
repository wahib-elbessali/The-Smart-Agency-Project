import type { Role } from '@/api/types'

/**
 * Where each role starts after signing in.
 *
 * Everyone used to land on /presence, and for two of the five roles that is a
 * screen they are refused from: GET /api/attendance/* is ADMIN, MANAGER and
 * SECURITY only, so an AGENT and a TECHNICIAN met the 403 refusal state as
 * their first impression of the application.
 *
 * The map is read off what each role may actually reach:
 *
 *   ADMIN       /agencies   an admin has NO agency, so "who is in today" has no
 *                           branch to be about for them - the estate does
 *   MANAGER     /presence   their branch's roster, scoped server-side
 *   SECURITY    /alerts     the live camera stream is the whole of their job
 *   AGENT       /visitors   tickets are ADMIN, MANAGER, AGENT - the queue they serve
 *   TECHNICIAN  /devices    device registration and sensor thresholds are ADMIN,
 *                           MANAGER, TECHNICIAN - added 2026-08-27, and the first
 *                           screen actually built for this role. /controls (doors,
 *                           locks, motors) is still <ContractPending>.
 *
 * This is a default, not a permission. Every route stays reachable by URL for
 * anyone signed in - hiding one would make a 403 look like a broken link
 * instead of a boundary, which is the same reasoning the nav follows.
 */
export const LANDING_BY_ROLE: Record<Role, string> = {
  ADMIN: '/agencies',
  MANAGER: '/presence',
  SECURITY: '/alerts',
  AGENT: '/visitors',
  TECHNICIAN: '/devices',
}

/** Used while the session is still resolving, and for a role added upstream. */
export const DEFAULT_LANDING = '/presence'

export function landingPathFor(role: Role | null | undefined): string {
  return role ? LANDING_BY_ROLE[role] : DEFAULT_LANDING
}
