import { registerMock, registerMockWriter } from '../registry'
import type {
  DeviceCommand,
  Intruder,
  ManualControlRequest,
  ManualControlResult,
  RosterEntry,
  StoredAlert,
  VisitorHistory,
  ZoneRestriction,
} from '@/api/types'
import type { EmployeeFace } from '@/api/endpoints/employeeFaces'
import { ApiError } from '@/api/errors'
import { requestUser } from '../currentUser'
import * as alerts from '../alertStore'
import { getDevice } from '../deviceStore'
import { listEmployees } from '../employeeStore'
import { setZoneRestriction } from '../zoneStore'

/**
 * Security reads and writes that had no fixtures (2026-10-18 review): alert
 * actions, manual controls, employee door faces, restricted zones and the
 * manual "who is this" links, and a ticket's visitor history.
 */

function segments(path: string): string[] {
  return new URL(path, 'http://mock').pathname.split('/').filter(Boolean)
}

/* --- Alert actions -------------------------------------------------------- */

function actOn(path: string, patch: (alert: StoredAlert) => Partial<StoredAlert>): StoredAlert {
  const id = segments(path)[2] ?? ''
  const current = Object.values(alerts.listAllForMock()).find((a) => a.id === id)
  if (!current) throw new ApiError('http', 'Alerte introuvable', 404)
  const user = requestUser()
  if (user && user.role !== 'ADMIN' && user.agency_id !== current.agency_id) {
    throw new ApiError('http', 'Acces limite a votre agence', 403)
  }
  return alerts.updateAlert(id, patch(current)) as StoredAlert
}

registerMockWriter('POST /api/alerts/{id}/acknowledge', (_body, path) =>
  actOn(path, (a) => (a.status === 'OPEN' ? { status: 'ACKNOWLEDGED' } : {})),
)
registerMockWriter('POST /api/alerts/{id}/resolve', (_body, path) =>
  actOn(path, (a) =>
    a.status === 'RESOLVED' ? {} : { status: 'RESOLVED', resolved_at: new Date().toISOString() },
  ),
)

/* --- Manual "who is this" links and restricted zones ---------------------- */

/** tracking id -> employee id; read by GET /api/employees/tracked too. */
export const trackLinks = new Map<string, string>()

registerMockWriter('POST /api/alerts/{id}/its-staff', (body, path) => {
  const employeeId = (body as { employee_id: string }).employee_id
  return actOn(path, (a) => {
    if (a.alert_type !== 'intrusion' || !a.tracking_id) {
      throw new ApiError('http', "Pas une alerte d'intrusion", 422)
    }
    const employee = listEmployees().find((e) => e.id === employeeId)
    if (!employee) throw new ApiError('http', 'Employe introuvable', 404)
    trackLinks.set(a.tracking_id, employeeId)
    return {
      status: 'RESOLVED',
      resolved_at: new Date().toISOString(),
      message: `${a.message ?? ''} - fausse alerte: ${employee.first_name} ${employee.last_name} (personnel)`,
    }
  })
})

registerMock<RosterEntry[]>('GET /api/employees/roster', {
  normal: () => {
    const user = requestUser()
    return listEmployees()
      .filter(
        (e) =>
          e.status === 'ACTIVE' &&
          (!user || user.role === 'ADMIN' || e.agency_id === user.agency_id),
      )
      .map((e) => ({
        employee_id: e.id,
        full_name: `${e.first_name} ${e.last_name}`,
        agency_id: e.agency_id,
      }))
  },
  empty: () => [],
  large: () => [],
})

registerMockWriter('PUT /api/employees/{id}/tracking', (body, path) => {
  const employeeId = segments(path)[2] ?? ''
  const employee = listEmployees().find((e) => e.id === employeeId)
  if (!employee) throw new ApiError('http', 'Employe introuvable', 404)
  if (employee.status !== 'ACTIVE') throw new ApiError('http', 'Employe inactif', 422)
  const trackingId = (body as { tracking_id: string }).tracking_id
  for (const [track, holder] of trackLinks) if (holder === employeeId) trackLinks.delete(track)
  trackLinks.set(trackingId, employeeId)
  return undefined
})

registerMockWriter('DELETE /api/employees/tracked/{id}', (_body, path) => {
  trackLinks.delete(decodeURIComponent(segments(path)[3] ?? ''))
  return undefined
})

registerMock<Intruder[]>('GET /api/zones/intruders', {
  normal: () =>
    alerts
      .listAllForMock()
      .filter((a) => a.alert_type === 'intrusion' && a.status !== 'RESOLVED' && a.tracking_id)
      .map((a) => ({
        alert_id: a.id,
        tracking_id: a.tracking_id as string,
        title: a.title ?? 'Intrusion',
      })),
  empty: () => [],
  large: () => [],
})

registerMockWriter('PUT /api/zones/{name}/restriction', (body, path) => {
  const name = decodeURIComponent(segments(path)[2] ?? '')
  const restriction = (body as { restriction: ZoneRestriction }).restriction
  setZoneRestriction(name, restriction)
  return { name, restriction, warnings: [] }
})

/* --- Manual controls (contracts/device-commands.json) ---------------------- */

const COMMANDS: Record<string, DeviceCommand[]> = {
  ACCESS_SENSORS: [
    { action: 'lock', label: 'Lock' },
    { action: 'unlock', label: 'Unlock' },
  ],
  DOOR: [
    { action: 'lock', label: 'Lock' },
    { action: 'unlock', label: 'Unlock' },
  ],
}

registerMock<Record<string, DeviceCommand[]>>('GET /api/controls/commands', {
  normal: () => COMMANDS,
  empty: () => ({}),
  large: () => COMMANDS,
})

registerMockWriter('POST /api/controls/devices/{id}/command', (body, path): ManualControlResult => {
  const device = getDevice(segments(path)[3] ?? '')
  const action = (body as ManualControlRequest).action.trim().toLowerCase()
  const allowed = (COMMANDS[device.device_type.toUpperCase()] ?? []).map((c) => c.action)
  if (!allowed.includes(action)) {
    throw new ApiError(
      'http',
      `Commande non prise en charge par cet appareil (possibles: ${allowed.join(', ') || 'aucune'})`,
      422,
    )
  }
  return { status: 'confirmed', detail: `simulated ${device.mqtt_client_id}: ${action}` }
})

/* --- Employee door faces --------------------------------------------------- */

const facePhotos = new Map<string, number>()

registerMock<EmployeeFace>('GET /api/employees/{id}/face', {
  normal: (path) => {
    const photos = facePhotos.get(segments(path)[2] ?? '') ?? 0
    return { enrolled: photos > 0, photos }
  },
  empty: () => ({ enrolled: false, photos: 0 }),
  large: () => ({ enrolled: true, photos: 3 }),
})

registerMockWriter('POST /api/employees/{id}/face', (_body, path): EmployeeFace => {
  const id = segments(path)[2] ?? ''
  const photos = (facePhotos.get(id) ?? 0) + 1
  facePhotos.set(id, photos)
  return { enrolled: true, photos }
})

registerMockWriter('DELETE /api/employees/{id}/face', (_body, path) => {
  facePhotos.delete(segments(path)[2] ?? '')
  return undefined
})

/* --- A ticket's visitor history --------------------------------------------- */

registerMock<VisitorHistory>('GET /api/tickets/{id}/history', {
  normal: () => ({
    recognised: true,
    previous_visits: [
      {
        ticket_number: 'VIR-004',
        service_name: 'Virement',
        status: 'COMPLETED',
        created_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        notes: 'Virement international, documents complets.',
      },
    ],
  }),
  empty: () => ({ recognised: false, previous_visits: [] }),
  large: () => ({ recognised: false, previous_visits: [] }),
})
