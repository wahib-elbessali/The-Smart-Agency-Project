import type { Service, ServiceCreate, ServiceUpdate } from '@/api/types'
import { ApiError } from '@/api/errors'
import { AGENCY_ID } from './fixtures/people'

/**
 * A writable service list for mock mode, scoped per agency.
 *
 * Same reasoning as agencyStore and employeeStore: the Services screen exists
 * to create, edit and delete these, so a frozen fixture would make every write
 * look like it silently failed.
 *
 * Refusals mirror backend/app/api/services.py, same status code:
 *   409  the agency is inactive, or the `code` collides within the agency,
 *        or a counter/ticket still references the service being deleted
 *   404  the service does not exist
 */

export const SERVICE_ID_VIR = 's1000000-0000-4000-8000-000000000001'
export const SERVICE_ID_OUV = 's1000000-0000-4000-8000-000000000002'
export const SERVICE_ID_CNS = 's1000000-0000-4000-8000-000000000003'

let services: Service[] | null = null
let nextId = 3000

function seed(): Service[] {
  if (services === null) {
    services = [
      {
        id: SERVICE_ID_VIR,
        agency_id: AGENCY_ID,
        code: 'VIR',
        name: 'Virement et consultation',
        description: 'Virements et consultation de compte',
        point_type: 'COUNTER',
        min_points: 1,
        is_active: true,
      },
      {
        id: SERVICE_ID_OUV,
        agency_id: AGENCY_ID,
        code: 'OUV',
        name: 'Ouverture de compte',
        description: null,
        point_type: 'OFFICE',
        min_points: 1,
        is_active: true,
      },
      /* Inactive on purpose: a service that has been switched off still has to
         render in the list (it is not deleted), and a counter can no longer be
         assigned to it - the 409 that refusal produces is only reachable if at
         least one inactive service exists to click on. */
      {
        id: SERVICE_ID_CNS,
        agency_id: AGENCY_ID,
        code: 'CNS',
        name: 'Conseil',
        description: 'Rendez-vous conseil clientèle',
        point_type: 'COUNTER',
        min_points: 1,
        is_active: false,
      },
    ]
  }
  return services
}

export function listServices(agencyId: string): Service[] {
  return seed()
    .filter((s) => s.agency_id === agencyId)
    .map((s) => ({ ...s }))
}

export function getService(id: string): Service {
  const found = seed().find((s) => s.id === id)
  if (!found) throw new ApiError('http', 'Service introuvable', 404)
  return { ...found }
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

function assertUniqueCode(agencyId: string, code: string, excludingId?: string): void {
  const clash = seed().some(
    (s) => s.agency_id === agencyId && s.code === code && s.id !== excludingId,
  )
  if (clash) throw new ApiError('http', 'Ce code de service existe deja dans cette agence', 409)
}

export function createService(agencyId: string, body: ServiceCreate): Service {
  const code = normalizeCode(body.code)
  assertUniqueCode(agencyId, code)

  const created: Service = {
    id: `s9000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`,
    agency_id: agencyId,
    code,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    point_type: body.point_type ?? 'COUNTER',
    min_points: body.min_points ?? 1,
    is_active: body.is_active ?? true,
  }
  seed().push(created)
  return created
}

export function updateService(id: string, body: ServiceUpdate): Service {
  const list = seed()
  const index = list.findIndex((s) => s.id === id)
  if (index === -1) throw new ApiError('http', 'Service introuvable', 404)

  const current = list[index]
  if (body.code !== undefined) assertUniqueCode(current.agency_id, normalizeCode(body.code), id)

  const updated: Service = {
    ...current,
    ...body,
    code: body.code !== undefined ? normalizeCode(body.code) : current.code,
    name: body.name !== undefined ? body.name.trim() : current.name,
    description:
      body.description !== undefined ? (body.description?.trim() ?? null) : current.description,
  }
  list[index] = updated
  return { ...updated }
}

export function deleteService(id: string): void {
  const list = seed()
  const index = list.findIndex((s) => s.id === id)
  if (index === -1) throw new ApiError('http', 'Service introuvable', 404)
  list.splice(index, 1)
}

/** Tests only - module state would otherwise leak between them. */
export function resetServiceStore(): void {
  services = null
  nextId = 3000
}
