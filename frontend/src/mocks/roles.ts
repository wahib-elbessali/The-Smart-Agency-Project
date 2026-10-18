import { ApiError } from '@/api/errors'
import type { Role } from '@/api/types'
import { requestUser } from './currentUser'

/**
 * Who may call what, reproduced from the backend's route dependencies.
 *
 * The fixtures answered every registered endpoint to whoever asked, because
 * nothing in the mock layer knew who that was. Found by testing: signed in as
 * the MANAGER the fixtures hand out by default, the User accounts screen was
 * fully usable - table, role dropdowns, delete - when every route behind it is
 * ADMIN-only and would answer her with a 403. The screen already handles that
 * refusal; there was simply no way to reach it without a backend.
 *
 * That is the failure this layer is supposed to prevent. A fixture that allows
 * what the API forbids does not just mislead a tester, it lets a screen be
 * built against permissions that do not exist, and the gap only shows up on the
 * day it is pointed at a real server.
 *
 * The gate lives here rather than in each fixture for two reasons: a rule
 * written once cannot be forgotten on the next endpoint added, and reads and
 * writes go through the same table instead of two copies that drift.
 *
 * Transcribed from backend/app/api/*.py, one line per router:
 *
 *   users        ADMIN                                  (ADMIN_ONLY, users.py:20)
 *   agencies     ADMIN, MANAGER to read; ADMIN to write (agencies.py)
 *   employees    ADMIN, MANAGER                         (employees.py)
 *   attendance   ADMIN, MANAGER, SECURITY               (ATTENDANCE_ROLES)
 *   tickets      ADMIN, MANAGER, AGENT                  (TICKET_ROLES)
 *                  /tracked: ADMIN, MANAGER, SECURITY (monitoring read, not ticket-handling)
 *   visitors     ADMIN, MANAGER, AGENT, SECURITY        (VISITOR_ROLES)
 *   services     ADMIN, MANAGER, AGENT to read;         (SERVICE_READ_ROLES,
 *                ADMIN, MANAGER to write                 SERVICE_WRITE_ROLES)
 *   counters     ADMIN, MANAGER (the /service assignment) (SERVICE_WRITE_ROLES)
 *   devices      ADMIN, MANAGER, TECHNICIAN;            (DEVICE_ROLES; rotate-key
 *                rotate-key is ADMIN, MANAGER only        is its own dependency)
 *   thresholds   ADMIN, MANAGER, TECHNICIAN             (THRESHOLD_ROLES)
 *   cameras      ADMIN, MANAGER, SECURITY;              (CAMERA_ROLES; delete
 *                delete is ADMIN, MANAGER only            is its own dependency)
 *   ai-alerts    ADMIN, MANAGER, SECURITY               (AI_ALERT_ROLES)
 */

const ALL_WATCH: Role[] = ['ADMIN', 'MANAGER', 'SECURITY']
const ADMIN_MANAGER: Role[] = ['ADMIN', 'MANAGER']
const EXACT_ROLES: Record<string, Role[]> = {
  'GET /api/agencies/{id}/access-zones': ALL_WATCH,
  'POST /api/agencies/{id}/access-zones': ADMIN_MANAGER,
  'PUT /api/access-zones/{id}': ADMIN_MANAGER,
  'DELETE /api/access-zones/{id}': ADMIN_MANAGER,
  'GET /api/agencies/{id}/counters': ['ADMIN', 'MANAGER', 'AGENT'],
  'POST /api/agencies/{id}/counters': ADMIN_MANAGER,
  'POST /api/announcements': ADMIN_MANAGER,
  'DELETE /api/announcements/{id}': ADMIN_MANAGER,
  'GET /api/agencies/{id}/insights/overview': ALL_WATCH,
  'GET /api/agencies/{id}/insights/satisfaction': ALL_WATCH,
  'GET /api/agencies/{id}/insights/trends': ALL_WATCH,
  'GET /api/agencies/{id}/insights/devices': ALL_WATCH,
  'GET /api/agencies/{id}/insights/access': ALL_WATCH,
  'GET /api/insights/branches': ['ADMIN'],
  'GET /api/agencies/{id}/report': ADMIN_MANAGER,
  'GET /api/reports/branches': ['ADMIN'],
  'POST /api/alerts/{id}/acknowledge': ALL_WATCH,
  'POST /api/alerts/{id}/resolve': ALL_WATCH,
  'POST /api/alerts/{id}/its-staff': ALL_WATCH,
  'GET /api/controls/commands': ALL_WATCH,
  'POST /api/controls/devices/{id}/command': ALL_WATCH,
  'GET /api/employees/roster': ALL_WATCH,
  'PUT /api/employees/{id}/tracking': ALL_WATCH,
  'DELETE /api/employees/tracked/{id}': ALL_WATCH,
  'GET /api/zones/intruders': ALL_WATCH,
}

/**
 * The roles allowed to call this endpoint, or null when no rule applies.
 *
 * Matched on the router prefix rather than the full key so an endpoint added
 * later is covered by the rule its neighbours already carry. Null - and so
 * allowed - covers /api/auth, which is how a session begins and cannot require
 * one, and anything under a prefix nobody has written a rule for yet.
 */
export function rolesFor(key: string): Role[] | null {
  const [method, path] = key.split(' ')
  if (!path) return null

  /* Exact routes first, copied from contracts/api.md's Roles lines (the
     backend's own test checks those match the real routes). Added in the
     2026-10-18 review for routes whose prefix rule below would be wrong. */
  const exact = EXACT_ROLES[key]
  if (exact) return exact

  if (path.startsWith('/api/users')) return ['ADMIN']

  /* Real backend now - backend/app/api/assignments.py's require_roles calls
     match exactly: AGENT-only on /me, ADMIN|MANAGER on everything else under
     this prefix. Still checked separately here rather than folded into the
     "transcribed from backend" table above, since this table predates that
     endpoint existing and the split by path prefix is easier to read this
     way regardless. /me is an agent reading their own assignment; everything
     else under this prefix (PATCH .../assignment) is a MANAGER or ADMIN
     setting one - checked first because it's the more specific path. */
  if (path.startsWith('/api/agents/me')) return ['AGENT']
  if (path.startsWith('/api/agents')) return ['ADMIN', 'MANAGER']

  /* Checked ahead of /api/agencies: two routers share the "services"
     substring - /api/agencies/{id}/services (list/create per agency) and
     /api/services/{id}[/points] (read/update/delete one) - and both split
     read from write the same way. */
  if (path.includes('/services')) {
    return method === 'GET' ? ['ADMIN', 'MANAGER', 'AGENT'] : ['ADMIN', 'MANAGER']
  }

  /* /api/counters/{id}/service - singular, the counter-to-service assignment.
     Does not collide with the plural check above. */
  if (path.startsWith('/api/counters')) return ['ADMIN', 'MANAGER']

  /* Also checked ahead of /api/agencies, for the same reason as services:
     /api/agencies/{id}/cameras (list/create per agency) and /api/cameras/{id}
     (update/delete one) are the same router, and the agencies prefix below
     would otherwise claim the first and lock SECURITY out of its own list. */
  if (path.includes('/cameras')) {
    return method === 'DELETE' ? ['ADMIN', 'MANAGER'] : ['ADMIN', 'MANAGER', 'SECURITY']
  }
  if (path.startsWith('/api/ai-alerts')) return ['ADMIN', 'MANAGER', 'SECURITY']
  if (path.startsWith('/api/push')) return ['ADMIN', 'MANAGER', 'SECURITY']
  /* Stored alerts (#112) hang off /api/agencies/{id}/..., so ahead of the
     agencies rule below, which would lock SECURITY out. */
  if (path.endsWith('/alerts')) return ['ADMIN', 'MANAGER', 'SECURITY']

  /* PROPOSED, not in the real backend - api/endpoints/zones.ts. Drawing the
     floor geometry the counts are computed from is not the same act as
     registering a camera, so this drops SECURITY where /api/cameras keeps
     it. Flagged for confirmation in BACKEND-ASKS.md §8, not transcribed
     from backend source, which is why it sits apart from the table above.
     The per-branch half of the rule is in fixtures/zones.ts, since it
     depends on which camera the zone hangs off. */
  if (path.startsWith('/api/zones')) return ['ADMIN', 'MANAGER']

  /* PROPOSED too - api/endpoints/workstations.ts. Same roles as the zones a
     workstation is bound to, for the same reason: this is configuration of
     what the site measures, not a monitoring view. The per-branch half is in
     fixtures/workstations.ts, which walks workstation -> zone -> camera. */
  if (path.startsWith('/api/workstations')) return ['ADMIN', 'MANAGER']

  /* api/endpoints/aiConfig.ts - site-wide detector tuning, ADMIN alone
     (api/ai_config.py). */
  if (path.startsWith('/api/ai/config')) return ['ADMIN']

  /* PROPOSED - api/endpoints/calibration.ts. The floor geometry every
     world-mode zone and the person tracker are computed against, so it sits
     with the other two rather than with the monitoring screens. */
  if (path.startsWith('/api/calibration')) return ['ADMIN', 'MANAGER']

  /* PROPOSED - api/endpoints/people.ts. Registering which cameras a tracked
     scene uses is configuration, same bucket as zones/workstations/
     calibration; SECURITY can read the live map (it's a monitoring view for
     them, see /alerts and /cameras above) but not touch the source
     registry, same split cameras.py already draws between viewing and
     administering a camera. */
  /* Reading the source registry is the same monitoring view as the rest of
     /people (SECURITY can see which cameras feed the map); only writing to
     it is configuration, ADMIN/MANAGER only - same read/write split
     cameras.py already draws. */
  if (path.startsWith('/api/people/sources') && method !== 'GET') return ['ADMIN', 'MANAGER']
  if (path.startsWith('/api/people')) return ['ADMIN', 'MANAGER', 'SECURITY']

  /* PROPOSED - api/endpoints/face.ts, api/endpoints/watchlist.ts. Plain
     admin configuration (who's enrolled, who's wanted, how sensitive the
     watchlist match is), same bucket as zones/workstations/calibration -
     not a monitoring view like /alerts, which already shows a wanted hit
     when the stream fires one. */
  if (path.startsWith('/api/face')) return ['ADMIN', 'MANAGER']
  if (path.startsWith('/api/watchlist')) return ['ADMIN', 'MANAGER']

  if (path.startsWith('/api/agencies')) {
    /* The one split router. Reading is ADMIN and MANAGER, and a MANAGER's list
       comes back scoped (fixtures/agencies.ts). Creating and deleting are ADMIN
       alone. PUT allows a MANAGER on their OWN agency - the ownership half is
       not expressible here, so it is left to the route, and this only keeps out
       the roles that cannot edit any agency at all. */
    return method === 'GET' || method === 'PUT' ? ['ADMIN', 'MANAGER'] : ['ADMIN']
  }

  if (path.startsWith('/api/employees')) {
    /* /tracked is a monitoring read for the live map (Tracking.tsx) - same
       roles as /api/tickets/tracked and /api/people, not the employee-
       management roles everything else under this prefix uses. */
    return path === '/api/employees/tracked'
      ? ['ADMIN', 'MANAGER', 'SECURITY']
      : ['ADMIN', 'MANAGER']
  }
  if (path.startsWith('/api/attendance')) return ['ADMIN', 'MANAGER', 'SECURITY']
  if (path.startsWith('/api/tickets')) {
    /* /tracked is a monitoring read for the live map (Tracking.tsx) - same
       roles as /api/people, not the ticket-handling roles everything else
       under this prefix uses. */
    return path === '/api/tickets/tracked'
      ? ['ADMIN', 'MANAGER', 'SECURITY']
      : ['ADMIN', 'MANAGER', 'AGENT']
  }
  if (path.startsWith('/api/visitors')) return ['ADMIN', 'MANAGER', 'AGENT', 'SECURITY']

  /* Covers both /api/devices... and /api/devices/{id}/thresholds... - the
     thresholds router hangs off the same prefix and shares the same roles,
     except rotate-key, which drops TECHNICIAN. */
  if (path.startsWith('/api/devices')) {
    return path.endsWith('/rotate-key') ? ['ADMIN', 'MANAGER'] : ['ADMIN', 'MANAGER', 'TECHNICIAN']
  }

  return null
}

/**
 * Throws the 403 the backend would throw, or returns for an allowed call.
 *
 * An unknown caller is allowed through rather than refused. The alternative
 * would be a 401, which is what the real API answers, but nothing here can tell
 * "signed out" apart from "a test supplied a session without going through
 * tokenStore" - and refusing the second would fail suites over a detail of how
 * they render rather than over anything about the app.
 */
export function assertRoleAllowed(key: string): void {
  const allowed = rolesFor(key)
  if (allowed === null) return

  const user = requestUser()
  if (user === null) return

  if (!allowed.includes(user.role)) {
    /* The French detail and the status the backend's require_roles produces,
       so a screen handling this here handles the real one unchanged. */
    throw new ApiError('http', 'Acces refuse', 403)
  }
}
