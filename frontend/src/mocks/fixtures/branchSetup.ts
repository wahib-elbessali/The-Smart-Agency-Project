import { registerMock, registerMockWriter } from '../registry'
import type {
  Announcement,
  AnnouncementCreate,
  Counter,
  CounterCreate,
  CounterUpdate,
  LatestClimateReading,
  Zone,
  ZoneCreate,
} from '@/api/types'
import { ApiError } from '@/api/errors'
import { requestUser } from '../currentUser'
import { CAMERA_ID_STORE } from '../cameraStore'
import { DEVICE_ID_DHT22 } from '../deviceStore'
import { SERVICE_ID_VIR } from '../serviceStore'
import { AGENCY_ID } from './people'

/**
 * Branch set-up reads and writes that had no fixtures (2026-10-18 review):
 * badge rooms (access zones), counters, announcements and the latest climate
 * reading. Field names from contracts/api.md; each list is a small in-memory
 * store so a create shows up on the next read, as against the backend.
 */

/** /api/agencies/{id}/... - the agency id is the third path segment. */
function agencyOf(path: string): string {
  return new URL(path, 'http://mock').pathname.split('/').filter(Boolean)[2] ?? ''
}

/** /api/<thing>/{id} - the last path segment. */
function lastSegment(path: string): string {
  return new URL(path, 'http://mock').pathname.split('/').filter(Boolean).pop() ?? ''
}

function ensureOwnBranch(agencyId: string): void {
  const user = requestUser()
  if (user && user.role !== 'ADMIN' && user.agency_id !== agencyId) {
    throw new ApiError('http', 'Acces limite a votre agence', 403)
  }
}

let nextId = 1
const newId = (prefix: string) =>
  `${prefix}000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`

/* --- Badge rooms ---------------------------------------------------------- */

const zonesByAgency = new Map<string, Zone[]>([
  [
    AGENCY_ID,
    [
      {
        id: 'z1000000-0000-4000-8000-000000000001',
        name: 'Accueil',
        zone_type: 'PUBLIC',
        is_private: false,
        access_mode: 'rfid',
        door_camera_id: null,
      },
      {
        id: 'z1000000-0000-4000-8000-000000000002',
        name: 'Bureau de direction',
        zone_type: 'PRIVATE',
        is_private: true,
        access_mode: 'rfid_face',
        door_camera_id: CAMERA_ID_STORE,
      },
    ],
  ],
])

function zones(agencyId: string): Zone[] {
  if (!zonesByAgency.has(agencyId)) zonesByAgency.set(agencyId, [])
  return zonesByAgency.get(agencyId) as Zone[]
}

registerMock<Zone[]>('GET /api/agencies/{id}/access-zones', {
  normal: (path) => {
    ensureOwnBranch(agencyOf(path))
    return zones(agencyOf(path)).map((z) => ({ ...z }))
  },
  empty: () => [],
  large: (path) => zones(agencyOf(path)).map((z) => ({ ...z })),
})

function checkZone(body: Partial<ZoneCreate>): void {
  if (body.access_mode === 'rfid_face' && !body.door_camera_id) {
    throw new ApiError('http', 'Une camera de porte est requise pour badge + visage', 422)
  }
}

registerMockWriter('POST /api/agencies/{id}/access-zones', (body, path) => {
  const agencyId = agencyOf(path)
  ensureOwnBranch(agencyId)
  const input = body as ZoneCreate
  checkZone(input)
  const zone: Zone = {
    id: newId('z'),
    name: input.name,
    zone_type: input.zone_type ?? 'PUBLIC',
    is_private: input.is_private ?? false,
    access_mode: input.access_mode ?? 'rfid',
    door_camera_id: input.door_camera_id ?? null,
  }
  zones(agencyId).push(zone)
  return { ...zone }
})

function findZone(id: string): Zone {
  for (const list of zonesByAgency.values()) {
    const zone = list.find((z) => z.id === id)
    if (zone) return zone
  }
  throw new ApiError('http', 'Zone introuvable', 404)
}

registerMockWriter('PUT /api/access-zones/{id}', (body, path) => {
  const zone = findZone(lastSegment(path))
  const input = body as Partial<ZoneCreate>
  checkZone({ ...zone, ...input })
  Object.assign(zone, input)
  return { ...zone }
})

registerMockWriter('DELETE /api/access-zones/{id}', (_body, path) => {
  const id = lastSegment(path)
  for (const list of zonesByAgency.values()) {
    const index = list.findIndex((z) => z.id === id)
    if (index !== -1) {
      list.splice(index, 1)
      return undefined
    }
  }
  throw new ApiError('http', 'Zone introuvable', 404)
})

/* --- Counters ------------------------------------------------------------- */

const countersByAgency = new Map<string, Counter[]>([
  [
    AGENCY_ID,
    [
      {
        id: 'k1000000-0000-4000-8000-000000000001',
        number: 1,
        name: 'Guichet 1',
        point_type: 'COUNTER',
        is_open: true,
        service_id: SERVICE_ID_VIR,
        emotion_camera_id: null,
        workstation_name: 'Guichet 1',
      },
      {
        id: 'k1000000-0000-4000-8000-000000000002',
        number: 2,
        name: 'Guichet 2',
        point_type: 'COUNTER',
        is_open: true,
        service_id: null,
        emotion_camera_id: null,
        workstation_name: null,
      },
    ],
  ],
])

function counters(agencyId: string): Counter[] {
  if (!countersByAgency.has(agencyId)) countersByAgency.set(agencyId, [])
  return countersByAgency.get(agencyId) as Counter[]
}

registerMock<Counter[]>('GET /api/agencies/{id}/counters', {
  normal: (path) => {
    ensureOwnBranch(agencyOf(path))
    return counters(agencyOf(path)).map((c) => ({ ...c }))
  },
  empty: () => [],
  large: (path) => counters(agencyOf(path)).map((c) => ({ ...c })),
})

registerMockWriter('POST /api/agencies/{id}/counters', (body, path) => {
  const agencyId = agencyOf(path)
  ensureOwnBranch(agencyId)
  const input = body as CounterCreate
  if (counters(agencyId).some((c) => c.number === input.number)) {
    throw new ApiError('http', 'Ce numero de guichet existe deja', 409)
  }
  const counter: Counter = {
    id: newId('k'),
    number: input.number,
    name: input.name ?? null,
    point_type: input.point_type ?? 'COUNTER',
    is_open: input.is_open ?? true,
    service_id: null,
    emotion_camera_id: null,
    workstation_name: null,
  }
  counters(agencyId).push(counter)
  return { ...counter }
})

function findCounter(id: string): Counter {
  for (const list of countersByAgency.values()) {
    const counter = list.find((c) => c.id === id)
    if (counter) return counter
  }
  throw new ApiError('http', 'Guichet introuvable', 404)
}

registerMockWriter('PUT /api/counters/{id}', (body, path) => {
  const counter = findCounter(lastSegment(path))
  Object.assign(counter, body as CounterUpdate)
  return { ...counter }
})

registerMockWriter('DELETE /api/counters/{id}', (_body, path) => {
  const id = lastSegment(path)
  for (const list of countersByAgency.values()) {
    const index = list.findIndex((c) => c.id === id)
    if (index !== -1) {
      list.splice(index, 1)
      return undefined
    }
  }
  throw new ApiError('http', 'Guichet introuvable', 404)
})

/* --- Announcements -------------------------------------------------------- */

const announcements: Announcement[] = [
  {
    id: 'n1000000-0000-4000-8000-000000000001',
    agency_id: null,
    author_id: null,
    title: 'Maintenance du systeme',
    message: 'Le systeme sera redemarre ce soir a 20h.',
    created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  },
]

registerMock<Announcement[]>('GET /api/announcements', {
  normal: () => {
    const user = requestUser()
    return announcements
      .filter(
        (a) =>
          a.agency_id === null || !user || user.role === 'ADMIN' || a.agency_id === user.agency_id,
      )
      .map((a) => ({ ...a }))
  },
  empty: () => [],
  large: () => announcements.map((a) => ({ ...a })),
})

registerMockWriter('POST /api/announcements', (body) => {
  const input = body as AnnouncementCreate
  const user = requestUser()
  const announcement: Announcement = {
    id: newId('n'),
    agency_id: user?.role === 'ADMIN' ? (input.agency_id ?? null) : (user?.agency_id ?? null),
    author_id: user?.id ?? null,
    title: input.title,
    message: input.message,
    created_at: new Date().toISOString(),
  }
  announcements.unshift(announcement)
  return { ...announcement }
})

registerMockWriter('DELETE /api/announcements/{id}', (_body, path) => {
  const index = announcements.findIndex((a) => a.id === lastSegment(path))
  if (index === -1) throw new ApiError('http', 'Annonce introuvable', 404)
  announcements.splice(index, 1)
  return undefined
})

/* --- Climate -------------------------------------------------------------- */

registerMock<LatestClimateReading[]>('GET /api/agencies/{id}/climate/latest', {
  normal: () => {
    const now = new Date().toISOString()
    return [
      {
        device_id: DEVICE_ID_DHT22,
        device_name: 'Capteur salle',
        sensor_type: 'temperature',
        value: 22.4,
        unit: 'C',
        recorded_at: now,
      },
      {
        device_id: DEVICE_ID_DHT22,
        device_name: 'Capteur salle',
        sensor_type: 'humidity',
        value: 46,
        unit: '%',
        recorded_at: now,
      },
      {
        device_id: DEVICE_ID_DHT22,
        device_name: 'Capteur salle',
        sensor_type: 'gas_co',
        value: 3,
        unit: 'ppm',
        recorded_at: now,
      },
    ]
  },
  empty: () => [],
  large: () => [],
})
