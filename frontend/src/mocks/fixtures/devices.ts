import { registerMock, registerMockWriter } from '../registry'
import type { Device, DeviceCreate, DeviceRegistration, DeviceUpdate } from '@/api/types'
import * as store from '../deviceStore'
import { requestUser } from '../currentUser'

/**
 * Field names from DeviceResponse / DeviceRegistrationResponse in
 * backend/app/schemas/device.py. contracts/api.md §9, added 2026-08-27.
 *
 * Same agency scoping as agencies/employees: ADMIN sees every device, MANAGER
 * and TECHNICIAN see only their own agency's. Enforced here rather than in
 * deviceStore, for the same reason agencyStore's `visibleTo` lives in the
 * fixture file - this layer IS the backend when mocks are on.
 */
function visibleTo(devices: Device[]): Device[] {
  const user = requestUser()
  if (!user || user.role === 'ADMIN') return devices
  return devices.filter((d) => d.agency_id === user.agency_id)
}

registerMock<Device[]>('GET /api/devices', {
  normal: () => visibleTo(store.listDevices()),
  empty: () => [],
  large: () => visibleTo(store.listDevices()),
})

/** The agency id is the last path segment for the registration route. */
function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

registerMockWriter('POST /api/devices/agencies/{id}', (body, path) =>
  store.registerDevice(lastSegment(path), body as DeviceCreate),
)

registerMock<Device>('GET /api/devices/{id}', {
  normal: (path) => store.getDevice(lastSegment(path)),
  empty: (path) => store.getDevice(lastSegment(path)),
  large: (path) => store.getDevice(lastSegment(path)),
})

registerMockWriter('PUT /api/devices/{id}', (body, path) =>
  store.updateDevice(lastSegment(path), body as DeviceUpdate),
)

registerMockWriter('POST /api/devices/{id}/rotate-key', (_body, path) => {
  const parts = path.split('/').filter(Boolean)
  const id = parts[parts.length - 2] ?? ''
  return store.rotateDeviceKey(id) as DeviceRegistration
})

registerMockWriter('DELETE /api/devices/{id}', (_body, path) => {
  store.deleteDevice(lastSegment(path))
  return undefined
})
