import { ROLES, type Role } from '@/api/types'

/**
 * The roles this dashboard will put on an account. ADMIN is not one of them.
 *
 * Nobody creates an admin here and nobody removes one - not a manager, not an
 * admin, not on their own account (2026-08-20). Admin is not a setting the
 * application administers; it is a fact about who owns the system, and it is
 * arranged where the system is installed.
 *
 * So the way in is closed as well as the way out. Locking the ADMIN rows while
 * leaving ADMIN in the dropdowns would have left one direction open, and a
 * promotion nobody could reverse from here is a worse trap than a demotion.
 *
 * The API is unchanged and still accepts both: POST /api/users takes role=ADMIN
 * and PATCH /api/users/{id}/access moves anybody anywhere. This is the product
 * rule, held by the screens, and an admin still has to be made somewhere -
 * backend/seed_dev.py, or the database.
 */
export const ASSIGNABLE_ROLES: readonly Role[] = ROLES.filter((role) => role !== 'ADMIN')

/**
 * Which roles may reach which screen.
 *
 * A screen a role cannot use is NOT SHOWN to that role - not in the navigation,
 * and not by typing the URL. Asked for on 2026-08-20, and it reverses what this
 * codebase used to argue: screens were deliberately left reachable so that
 * meeting the refusal state taught you where the boundary was, on the grounds
 * that a missing nav item looks like a feature that was never built. The call
 * went the other way, so the comments that argued for it are gone too.
 *
 * The refusal states stay in the screens as a backstop. They are close to
 * unreachable now, but "close to" is not "never": a session whose role changed
 * under it, or a route added here without an entry, both still land on one, and
 * a 403 answered by a blank screen would be worse than one answered in words.
 *
 * KEYED ON THE PRIMARY DATA OF EACH SCREEN, which is not always the only data
 * it reads. Two screens fetch something their own visitors may not be allowed
 * to fetch, and both let that degrade rather than fail:
 *
 *   /presence  reads attendance (ADMIN, MANAGER, SECURITY), and also agencies
 *              and employees, which are ADMIN and MANAGER only. A SECURITY
 *              account gets the roster but no opening_time, so nobody is marked
 *              late - the screen works and is missing a column of meaning.
 *   /visitors  reads tickets (ADMIN, MANAGER, AGENT), and also agencies for the
 *              branch picker when registering someone, and services for the
 *              service picker. An AGENT gets the queue and an empty picker for
 *              anything scoped ADMIN/MANAGER-only.
 *
 * Both are worth fixing properly one day - by scoping those two reads to the
 * caller's own agency in the backend rather than refusing them - and neither is
 * a reason to hide a screen that otherwise works.
 *
 * /occupancy is a rule with nothing behind it yet. The AI stream it reads
 * (contracts/ai-service.md, WS /zoning/occupancy/stream) has no role check and
 * no agency_id on a zone - one physical site, not scoped per branch - so this
 * entry only decides who may look at the one feed that exists. An ADMIN or
 * MANAGER seeing "their own agency's zones" and nothing else needs zones to
 * carry an agency_id all the way from the AI service through the backend
 * proxy first; that's a contracts/backend/ai change, not one this file can
 * make on its own.
 *
 * Roles transcribed from backend/app/api/*.py. mocks/roles.ts carries the same
 * table keyed by API path; they describe the same rules from the two ends and
 * have to move together.
 */
const ROUTE_ROLES: Record<string, readonly Role[]> = {
  '/presence': ['ADMIN', 'MANAGER', 'SECURITY'],
  '/employees': ['ADMIN', 'MANAGER'],
  '/agencies': ['ADMIN', 'MANAGER'],
  '/services': ['ADMIN', 'MANAGER'],
  '/ticket-template': ['ADMIN', 'MANAGER'],
  '/reports': ['ADMIN', 'MANAGER'],
  '/devices': ['ADMIN', 'MANAGER', 'TECHNICIAN'],
  '/users': ['ADMIN'],
  '/visitors': ['ADMIN', 'MANAGER', 'AGENT'],
  '/occupancy': ['ADMIN', 'MANAGER'],
  /* PROPOSED routes, not transcribed from backend source: the zone-drawing
     screen writes to the AI service's /zoning through proxies that do not
     exist yet (api/endpoints/zones.ts, BACKEND-ASKS.md §8). Narrower than
     /cameras on purpose - a guard registers the cameras they watch, but the
     floor geometry every count is computed from is administration, not
     monitoring. Confirm with backend before it ships. */
  '/zones': ['ADMIN', 'MANAGER'],
  /* Same rule and the same PROPOSED caveat as /zones - a workstation is a
     name bound to one of those zones, so it cannot be read by anyone who
     cannot see the zone behind it. Not AGENT: this reports on whether the
     counters are manned, which is a thing said ABOUT agents. */
  '/staffing': ['ADMIN', 'MANAGER'],
  /* The site's floor geometry - the thing world-mode zones and person
     tracking are computed against. Same roles and the same PROPOSED caveat
     as the two above. */
  '/calibration': ['ADMIN', 'MANAGER'],
  /* PROPOSED, same caveat as /calibration - api/endpoints/people.ts. Wider
     than the other configuration screens on purpose: SECURITY can read the
     live map (a monitoring view, same bucket as /alerts), it just cannot
     edit which cameras feed it - that split is enforced inside the screen
     itself (Tracking.tsx's canEditSources) and mirrored in mocks/roles.ts. */
  '/tracking': ['ADMIN', 'MANAGER', 'SECURITY'],
  /* PROPOSED - api/endpoints/face.ts, api/endpoints/watchlist.ts. Plain
     configuration, same bucket as /zones and /calibration, not a
     monitoring view like /alerts. */
  '/faces': ['ADMIN', 'MANAGER'],
  /* Transcribed from CONFIG_ROLES (ai_config.py): detector tuning is
     site-wide, so ADMIN alone. */
  '/ai-settings': ['ADMIN'],
  '/watchlist': ['ADMIN', 'MANAGER'],
  /* Transcribed from CAMERA_ROLES / AI_ALERT_ROLES (cameras.py, ai_alerts.py),
     added 2026-09-12. The one screen a guard can write to: they register the
     cameras they watch and set how sure the detector has to be before an
     alert reaches them. Deleting a camera is ADMIN and MANAGER only and the
     screen hides that button for SECURITY; the route stays open to them
     because everything else on it is theirs. */
  '/cameras': ['ADMIN', 'MANAGER', 'SECURITY'],
  /* Transcribed from CONTROL_ROLES (controls.py), added 2026-09-23. Same
     roles as /cameras - a security operator overriding a lock is the same
     kind of real-time action as registering the camera that watches it. */
  '/controls': ['ADMIN', 'MANAGER', 'SECURITY'],
  /* Transcribed from INSIGHTS_ROLES (insights.py), added 2026-09-23. Same
     bucket as /alerts and /controls - a monitoring view read by the roles
     watching the floor, not a configuration screen. */
  '/insights': ['ADMIN', 'MANAGER', 'SECURITY'],
  /* ALERT_ROLES - contracts/api.md §13 puts all four alert streams behind
     ADMIN, MANAGER and SECURITY, and closes anyone else with 1008. */
  '/alerts': ['ADMIN', 'MANAGER', 'SECURITY'],
  /* No entry means every signed-in role. /announcements has no GET-side role
     check - an announcement is for every employee, the write-side restriction
     (ADMIN/MANAGER) lives inside the screen. */
}

/**
 * Every route in the shell, so the navigation and the guard cannot drift.
 *
 * ROUTE_ROLES is keyed on the top-level paths in SCREENS, all of which are
 * static - but /agencies/{id} (the agency detail screen) is not, and an exact
 * lookup on a path carrying a real id would never match its entry, silently
 * treating it as unguarded (`!allowed` returns true). A nested path inherits
 * its parent's rule instead: /agencies/{id} is exactly as restricted as
 * /agencies, because it reads the same data one level deeper. /cameras/{id}
 * (the live view, 2026-09-12) relies on the same fallback.
 */
export function canReach(role: Role | null | undefined, path: string): boolean {
  const base = `/${path.split('/')[1] ?? ''}`
  const allowed = ROUTE_ROLES[path] ?? ROUTE_ROLES[base]
  if (!allowed) return true
  if (!role) return false
  return allowed.includes(role)
}
