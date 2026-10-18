import { registerMock, registerMockWriter } from '../registry'
import type {
  CounterServiceAssignment,
  Service,
  ServiceCreate,
  ServicePoint,
  ServiceUpdate,
} from '@/api/types'
import { AGENCY_ID } from './people'
import * as serviceStore from '../serviceStore'
import * as ticketStore from '../ticketStore'

/**
 * Field names from ServiceResponse / ServicePointResponse / CounterResponse in
 * backend/app/schemas/service.py and agency.py. Added alongside the Services
 * contract update (contracts/api.md §3, 2026-08-27).
 *
 * Counters live in ticketStore, not here - they are the same COUNTERS array
 * agencyStore nests under Casablanca, and a service's points are just that
 * array filtered by `service_id`. Duplicating counters into a second store
 * would let the two disagree about which counter is assigned to what.
 */

/** The agency id sits at the end of the path for the list/create routes. */
function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** For /api/agencies/{agency_id}/services - the id is second-to-last. */
function agencyIdFrom(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

registerMock<Service[]>('GET /api/agencies/{id}/services', {
  normal: (path) => serviceStore.listServices(agencyIdFrom(path)),
  empty: () => [],
  large: (path) => serviceStore.listServices(agencyIdFrom(path)),
})

registerMockWriter('POST /api/agencies/{id}/services', (body, path) =>
  serviceStore.createService(agencyIdFrom(path), body as ServiceCreate),
)

registerMock<Service>('GET /api/services/{id}', {
  normal: (path) => serviceStore.getService(lastSegment(path)),
  empty: (path) => serviceStore.getService(lastSegment(path)),
  large: (path) => serviceStore.getService(lastSegment(path)),
})

registerMockWriter('PUT /api/services/{id}', (body, path) =>
  serviceStore.updateService(lastSegment(path), body as ServiceUpdate),
)

registerMockWriter('DELETE /api/services/{id}', (_body, path) => {
  serviceStore.deleteService(lastSegment(path))
  return undefined
})

/** All seeded counters belong to Casablanca - see agencyStore's `casablanca()`. */
function toServicePoint(
  counter: ReturnType<typeof ticketStore.listServicePoints>[number],
): ServicePoint {
  return { ...counter, agency_id: AGENCY_ID }
}

/** For /api/services/{id}/points - the id is second-to-last path segment. */
function penultimateSegment(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

registerMock<ServicePoint[]>('GET /api/services/{id}/points', {
  normal: (path) => ticketStore.listServicePoints(penultimateSegment(path)).map(toServicePoint),
  empty: () => [],
  large: (path) => ticketStore.listServicePoints(penultimateSegment(path)).map(toServicePoint),
})

registerMockWriter('PATCH /api/counters/{id}/service', (body, path) => {
  const counterId = penultimateSegment(path)
  const assignment = body as CounterServiceAssignment
  return toServicePoint(ticketStore.assignCounterService(counterId, assignment.service_id))
})
