import { fetchJson } from '../client'
import type {
  CounterServiceAssignment,
  Service,
  ServiceCreate,
  ServicePoint,
  ServiceUpdate,
} from '../types'

/**
 * Service endpoints — what a visitor's ticket is for, and which counters serve
 * it. Added by the same contract update that changed POST /api/tickets to
 * require `service_id` (contracts/api.md §3, 2026-08-27).
 *
 * Reading is ADMIN, MANAGER, AGENT. Writing (create/update/delete, and
 * assigning a counter) is ADMIN, MANAGER only.
 */

export function fetchServices(agencyId: string, signal?: AbortSignal): Promise<Service[]> {
  return fetchJson<Service[]>(
    {
      key: 'GET /api/agencies/{id}/services',
      path: `/api/agencies/${agencyId}/services`,
      auth: true,
    },
    { signal },
  )
}

export function createService(
  agencyId: string,
  body: ServiceCreate,
  signal?: AbortSignal,
): Promise<Service> {
  return fetchJson<Service>(
    {
      key: 'POST /api/agencies/{id}/services',
      path: `/api/agencies/${agencyId}/services`,
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

/**
 * Partial update — only the keys present are changed.
 *
 * Changing `point_type` is refused with a 409 while a counter is still
 * assigned to this service (backend/app/api/services.py); the caller has to
 * clear the assignment first via `assignCounterToService`.
 */
export function updateService(
  id: string,
  body: ServiceUpdate,
  signal?: AbortSignal,
): Promise<Service> {
  return fetchJson<Service>(
    { key: 'PUT /api/services/{id}', path: `/api/services/${id}`, method: 'PUT', auth: true },
    { signal, body },
  )
}

/**
 * Refused with a 409 while any counter or ticket still references this
 * service. There is no cascade here, unlike deleting an agency.
 */
export function deleteService(id: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    { key: 'DELETE /api/services/{id}', path: `/api/services/${id}`, method: 'DELETE', auth: true },
    { signal },
  )
}

/** The counters/offices currently assigned to serve one service. */
export function fetchServicePoints(
  serviceId: string,
  signal?: AbortSignal,
): Promise<ServicePoint[]> {
  return fetchJson<ServicePoint[]>(
    {
      key: 'GET /api/services/{id}/points',
      path: `/api/services/${serviceId}/points`,
      auth: true,
    },
    { signal },
  )
}

/**
 * Assigns or clears a counter's service. Sending `{ service_id: null }` clears
 * it and resets the counter's `point_type` back to `COUNTER` server-side.
 *
 * The service and the counter must belong to the same agency (422), and the
 * service must be active (409) - a counter cannot be pointed at a service that
 * has been switched off.
 */
export function assignCounterService(
  counterId: string,
  body: CounterServiceAssignment,
  signal?: AbortSignal,
): Promise<ServicePoint> {
  return fetchJson<ServicePoint>(
    {
      key: 'PATCH /api/counters/{id}/service',
      path: `/api/counters/${counterId}/service`,
      method: 'PATCH',
      auth: true,
    },
    { signal, body },
  )
}
