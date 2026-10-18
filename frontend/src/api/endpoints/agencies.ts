import { fetchJson } from '../client'
import type { Agency, AgencyCreate, AgencyUpdate } from '../types'

/**
 * Agency endpoints.
 *
 * The roles differ per route and it is worth reading them as a set, because
 * they are not the usual "admin writes, manager reads":
 *
 *   GET    list / one   ADMIN, MANAGER (a MANAGER sees only its own)
 *   POST   create       ADMIN only - a MANAGER gets 403
 *   PUT    update       ADMIN, or a MANAGER on its OWN agency
 *   DELETE               ADMIN only
 *
 * So a MANAGER can edit the agency it runs but cannot create or destroy one.
 *
 * Scoping stays the backend's job. A MANAGER's list arrives already filtered,
 * and the frontend must not filter again or an ADMIN loses rows they are
 * entitled to see.
 */

export function fetchAgencies(signal?: AbortSignal): Promise<Agency[]> {
  return fetchJson<Agency[]>(
    { key: 'GET /api/agencies', path: '/api/agencies', auth: true },
    { signal },
  )
}

/**
 * One agency by id.
 *
 * Everything on this shape is already in the list response, so this is not
 * needed to render a row - it exists for a detail view that must be current
 * rather than reading from a list fetched some time ago.
 */
export function fetchAgency(id: string, signal?: AbortSignal): Promise<Agency> {
  return fetchJson<Agency>(
    { key: 'GET /api/agencies/{id}', path: `/api/agencies/${id}`, auth: true },
    { signal },
  )
}

/**
 * ADMIN only. Zones and counters are created with the agency, in one request.
 *
 * That is the only opportunity the contract gives: there is no route for adding
 * a counter to an existing agency, so anything omitted here cannot be added
 * later through the API.
 *
 * Two counters sharing a `number` in the same request is a 409, not a 422 -
 * the body is well formed, the collision is the problem.
 */
export function createAgency(body: AgencyCreate, signal?: AbortSignal): Promise<Agency> {
  return fetchJson<Agency>(
    { key: 'POST /api/agencies', path: '/api/agencies', method: 'POST', auth: true },
    { signal, body },
  )
}

/**
 * Partial update - only the keys present are changed.
 *
 * `is_active: false` is the reversible way to take an agency out of service and
 * is what the UI offers instead of deletion.
 */
export function updateAgency(
  id: string,
  body: AgencyUpdate,
  signal?: AbortSignal,
): Promise<Agency> {
  return fetchJson<Agency>(
    { key: 'PUT /api/agencies/{id}', path: `/api/agencies/${id}`, method: 'PUT', auth: true },
    { signal, body },
  )
}

/**
 * ADMIN only, and the most destructive route in the whole contract.
 *
 * It does not just remove the agency: "deleting an agency also deletes its
 * zones, counters, employees, visitors, devices, cameras and alerts". Every
 * attendance record belonging to those employees goes with them, because
 * Employee.attendance cascades in turn. There is no undo and no soft delete.
 *
 * `is_active: false` via PUT is the reversible alternative, and the UI leads
 * with it. Anything calling this must confirm first, and the confirmation has
 * to name what is being destroyed - the counts are on the agency record for
 * exactly that purpose.
 *
 * Returns 204 with no body.
 */
export function deleteAgency(id: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    { key: 'DELETE /api/agencies/{id}', path: `/api/agencies/${id}`, method: 'DELETE', auth: true },
    { signal },
  )
}
