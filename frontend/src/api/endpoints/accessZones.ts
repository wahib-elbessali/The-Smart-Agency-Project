import { fetchJson } from '../client'
import type { Zone, ZoneCreate, ZoneUpdate } from '../types'

/**
 * Door access zones - backend/app/api/access_zones.py. The rooms an RFID door
 * reader guards; an employee's badge opens the ones in their
 * `authorized_zone_ids`. Not the AI service's camera zones (zones.ts), which
 * are floor polygons.
 *
 * Roles: ADMIN, MANAGER, SECURITY read; ADMIN, MANAGER write.
 */

export function fetchAccessZones(agencyId: string, signal?: AbortSignal): Promise<Zone[]> {
  return fetchJson<Zone[]>(
    {
      key: 'GET /api/agencies/{id}/access-zones',
      path: `/api/agencies/${agencyId}/access-zones`,
      auth: true,
    },
    { signal },
  )
}

/** 409 when the agency already has a zone with that name. */
export function createAccessZone(
  agencyId: string,
  body: ZoneCreate,
  signal?: AbortSignal,
): Promise<Zone> {
  return fetchJson<Zone>(
    {
      key: 'POST /api/agencies/{id}/access-zones',
      path: `/api/agencies/${agencyId}/access-zones`,
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

export function updateAccessZone(
  zoneId: string,
  body: ZoneUpdate,
  signal?: AbortSignal,
): Promise<Zone> {
  return fetchJson<Zone>(
    {
      key: 'PUT /api/access-zones/{id}',
      path: `/api/access-zones/${zoneId}`,
      method: 'PUT',
      auth: true,
    },
    { signal, body },
  )
}

/** Removes everyone's access to it too. */
export function deleteAccessZone(zoneId: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/access-zones/{id}',
      path: `/api/access-zones/${zoneId}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
