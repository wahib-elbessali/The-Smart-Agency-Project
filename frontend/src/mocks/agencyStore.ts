import type { Agency, AgencyCreate, AgencyUpdate, Counter, Zone } from '@/api/types'
import { ApiError } from '@/api/errors'
import { AGENCY_ID, AGENCY_ID_RABAT } from './fixtures/people'
import { COUNTERS } from './ticketStore'

/**
 * A writable agency list for mock mode.
 *
 * Same reasoning as the employee store: a screen whose purpose is creating and
 * editing cannot be built against a frozen fixture, because the create appears
 * to succeed and the list never changes - which reads as a bug in the screen
 * rather than a limit of the fixtures.
 *
 * It also enforces the rules the backend enforces. Every refusal here is one
 * the contract documents, with the same status code, so the form is exercised
 * against its real failure modes long before there is a server to talk to:
 *
 *   409  two counters in one request sharing a `number`
 *   422  a name outside 2-150 characters
 *   404  an id that does not exist
 */

let agencies: Agency[] | null = null
let nextId = 2000

function casablanca(): Agency {
  return {
    id: AGENCY_ID,
    name: 'Agence Casablanca',
    address: 'Casablanca',
    phone: '0522000000',
    opening_time: '08:30:00',
    closing_time: '16:30:00',
    is_active: true,
    no_show_min_wait_seconds: 60,
    kiosk_zone_name: null,
    weapon_lockdown_enabled: false,
    access_failure_threshold: 5,
    access_failure_window_minutes: 10,
    queue_depth_warning: 5,
    queue_depth_critical: 10,
    oldest_wait_warning_seconds: 600,
    oldest_wait_critical_seconds: 1200,
    /* Zones are populated now. The contract documents their shape in the
       POST /api/agencies body, so this is transcribed rather than invented -
       and an agency with no zones leaves the occupancy screen with nothing to
       point at. */
    zones: [
      {
        id: 'z1000000-0000-4000-8000-000000000001',
        name: 'Accueil',
        zone_type: 'PUBLIC',
        is_private: false,
      },
      {
        id: 'z1000000-0000-4000-8000-000000000002',
        name: 'Guichets',
        zone_type: 'PUBLIC',
        is_private: false,
      },
      {
        id: 'z1000000-0000-4000-8000-000000000003',
        name: 'Coffre',
        zone_type: 'SECURE',
        is_private: true,
      },
    ],
    counters: COUNTERS,
    employees_count: 10,
    devices_count: 2,
    cameras_count: 3,
  }
}

function rabat(): Agency {
  return {
    id: AGENCY_ID_RABAT,
    name: 'Agence Rabat',
    address: 'Rabat',
    phone: '0537000000',
    opening_time: '09:00:00',
    closing_time: '17:00:00',
    is_active: true,
    no_show_min_wait_seconds: 60,
    kiosk_zone_name: null,
    weapon_lockdown_enabled: false,
    access_failure_threshold: 5,
    access_failure_window_minutes: 10,
    queue_depth_warning: 5,
    queue_depth_critical: 10,
    oldest_wait_warning_seconds: 600,
    oldest_wait_critical_seconds: 1200,
    zones: [],
    counters: [],
    employees_count: 6,
    devices_count: 1,
    cameras_count: 2,
  }
}

function seed(): Agency[] {
  if (agencies === null) agencies = [casablanca(), rabat()]
  return agencies
}

export function listAgencies(): Agency[] {
  return [...seed()]
}

export function getAgency(id: string): Agency {
  const found = seed().find((a) => a.id === id)
  if (!found) throw new ApiError('http', 'Agence introuvable.', 404)
  return { ...found }
}

/** The contract's only stated length bound on the whole shape. */
function assertName(name: string): void {
  const trimmed = name.trim()
  if (trimmed.length < 2 || trimmed.length > 150) {
    throw new ApiError('http', 'Le nom doit contenir entre 2 et 150 caracteres.', 422)
  }
}

export function createAgency(body: AgencyCreate): Agency {
  assertName(body.name)

  const numbers = (body.counters ?? []).map((c) => c.number)
  if (new Set(numbers).size !== numbers.length) {
    /* 409 rather than 422, matching the contract: each counter is individually
       valid, it is the pair that cannot exist. */
    throw new ApiError('http', 'Deux guichets portent le meme numero.', 409)
  }

  const suffix = () => String((nextId += 1)).padStart(12, '0')

  const zones: Zone[] = (body.zones ?? []).map((zone) => ({
    id: `z9000000-0000-4000-8000-${suffix()}`,
    name: zone.name,
    /* The server-side defaults, applied here so a zone created through the
       mock has the same shape as one that came back from the backend. */
    zone_type: zone.zone_type ?? 'PUBLIC',
    is_private: zone.is_private ?? false,
  }))

  const counters: Counter[] = (body.counters ?? []).map((counter) => ({
    id: `c9000000-0000-4000-8000-${suffix()}`,
    number: counter.number,
    name: counter.name ?? null,
    point_type: counter.point_type ?? 'COUNTER',
    is_open: counter.is_open ?? true,
    /* Not accepted on create: a counter has nothing to assign to until a
       service exists, and services are created afterwards, against the
       agency's own id. */
    service_id: null,
    emotion_camera_id: null,
    workstation_name: null,
  }))

  const created: Agency = {
    id: `a9000000-0000-4000-8000-${suffix()}`,
    name: body.name.trim(),
    address: body.address ?? null,
    phone: body.phone ?? null,
    opening_time: body.opening_time ?? null,
    closing_time: body.closing_time ?? null,
    /* Derived, not accepted - the create body has no is_active field. */
    is_active: true,
    no_show_min_wait_seconds: 60,
    kiosk_zone_name: null,
    weapon_lockdown_enabled: false,
    access_failure_threshold: 5,
    access_failure_window_minutes: 10,
    queue_depth_warning: 5,
    queue_depth_critical: 10,
    oldest_wait_warning_seconds: 600,
    oldest_wait_critical_seconds: 1200,
    zones,
    counters,
    employees_count: 0,
    devices_count: 0,
    cameras_count: 0,
  }

  seed().unshift(created)
  return created
}

export function updateAgency(id: string, body: AgencyUpdate): Agency {
  const list = seed()
  const index = list.findIndex((a) => a.id === id)
  if (index === -1) throw new ApiError('http', 'Agence introuvable.', 404)

  if (body.name !== undefined) assertName(body.name)

  /* Spread reproduces exclude_unset: an absent key is left alone, a present one
     overwrites. Zones and counters are not in AgencyUpdate, so they survive
     untouched - which is what the contract's response shows. */
  const updated: Agency = { ...list[index], ...body }
  if (body.name !== undefined) updated.name = body.name.trim()

  list[index] = updated
  return { ...updated }
}

export function deleteAgency(id: string): void {
  const list = seed()
  const index = list.findIndex((a) => a.id === id)
  if (index === -1) throw new ApiError('http', 'Agence introuvable.', 404)
  list.splice(index, 1)
}

/** Tests only - module state would otherwise leak between them. */
export function resetAgencyStore(): void {
  agencies = null
  nextId = 2000
}
