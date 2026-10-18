import type { Device, DeviceCreate, DeviceRegistration, DeviceUpdate } from '@/api/types'
import { ApiError } from '@/api/errors'
import { AGENCY_ID, AGENCY_ID_RABAT } from './fixtures/people'
import { deleteThresholdsForDevice } from './thresholdStore'

/**
 * A writable device list for mock mode.
 *
 * Same reasoning as agencyStore and employeeStore. Refusals mirror
 * backend/app/api/devices.py, same status code:
 *   409  mqtt_client_id collides, or the target agency is inactive
 *   404  the device does not exist
 */

export const DEVICE_ID_DHT22 = 'd1000000-0000-4000-8000-000000000001'
export const DEVICE_ID_PIR = 'd1000000-0000-4000-8000-000000000002'

let devices: Device[] | null = null
let nextId = 4000

function seed(): Device[] {
  if (devices === null) {
    devices = [
      {
        id: DEVICE_ID_DHT22,
        agency_id: AGENCY_ID,
        name: 'Capteur DHT22',
        device_type: 'DHT22',
        mqtt_client_id: 'dht22-001',
        mqtt_topic: `agency/${AGENCY_ID}/device/dht22-001/sensor`,
        status: 'ONLINE',
        last_seen_at: new Date(Date.now() - 2 * 60_000).toISOString(),
        badge_zone_name: null,
        heartbeat_seconds: null,
      },
      {
        id: DEVICE_ID_PIR,
        agency_id: AGENCY_ID,
        name: 'Capteur mouvement',
        device_type: 'PIR',
        mqtt_client_id: 'pir-001',
        mqtt_topic: `agency/${AGENCY_ID}/device/pir-001/sensor`,
        /* Never seen: this is the "never published" state, not "went
           offline" - last_seen_at stays null until the first MQTT message. */
        status: 'OFFLINE',
        last_seen_at: null,
        badge_zone_name: null,
        heartbeat_seconds: null,
      },
      {
        id: 'd1000000-0000-4000-8000-000000000003',
        agency_id: AGENCY_ID_RABAT,
        name: 'Capteur DHT22 Rabat',
        device_type: 'DHT22',
        mqtt_client_id: 'dht22-002',
        mqtt_topic: `agency/${AGENCY_ID_RABAT}/device/dht22-002/sensor`,
        status: 'ERROR',
        last_seen_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
        badge_zone_name: null,
        heartbeat_seconds: null,
      },
    ]
  }
  return devices
}

/** Not cryptographically real - a fixture value, shaped like the real one. */
function fakeDeviceKey(): string {
  return `dk_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

export function listDevices(): Device[] {
  return seed().map((d) => ({ ...d }))
}

export function getDevice(id: string): Device {
  const found = seed().find((d) => d.id === id)
  if (!found) throw new ApiError('http', 'Appareil introuvable', 404)
  return { ...found }
}

function assertUniqueClientId(clientId: string, excludingId?: string): void {
  const clash = seed().some((d) => d.mqtt_client_id === clientId && d.id !== excludingId)
  if (clash) throw new ApiError('http', 'Ce mqtt_client_id est deja utilise', 409)
}

export function registerDevice(agencyId: string, body: DeviceCreate): DeviceRegistration {
  const clientId = body.mqtt_client_id.trim()
  assertUniqueClientId(clientId)

  const created: Device = {
    id: `d9000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`,
    agency_id: agencyId,
    name: body.name.trim(),
    device_type: body.device_type.trim().toUpperCase(),
    mqtt_client_id: clientId,
    mqtt_topic: body.mqtt_topic?.trim() || `agency/${agencyId}/device/${clientId}/sensor`,
    status: 'OFFLINE',
    last_seen_at: null,
    badge_zone_name: null,
    heartbeat_seconds: null,
  }
  seed().push(created)
  return { ...created, device_key: fakeDeviceKey() }
}

export function updateDevice(id: string, body: DeviceUpdate): Device {
  const list = seed()
  const index = list.findIndex((d) => d.id === id)
  if (index === -1) throw new ApiError('http', 'Appareil introuvable', 404)

  if (body.mqtt_client_id !== undefined) assertUniqueClientId(body.mqtt_client_id.trim(), id)

  const current = list[index]
  const updated: Device = {
    ...current,
    ...body,
    name: body.name !== undefined ? body.name.trim() : current.name,
    device_type:
      body.device_type !== undefined ? body.device_type.trim().toUpperCase() : current.device_type,
    mqtt_client_id:
      body.mqtt_client_id !== undefined ? body.mqtt_client_id.trim() : current.mqtt_client_id,
    /* The column is NOT NULL - a literal null in the request is left alone
       rather than applied, matching the real column constraint the ...body
       spread above cannot express. */
    mqtt_topic: body.mqtt_topic ? body.mqtt_topic.trim() : current.mqtt_topic,
  }
  list[index] = updated
  return { ...updated }
}

export function rotateDeviceKey(id: string): DeviceRegistration {
  const device = getDevice(id)
  return { ...device, device_key: fakeDeviceKey() }
}

export function deleteDevice(id: string): void {
  const list = seed()
  const index = list.findIndex((d) => d.id === id)
  if (index === -1) throw new ApiError('http', 'Appareil introuvable', 404)
  list.splice(index, 1)
  deleteThresholdsForDevice(id)
}

/** Tests only - module state would otherwise leak between them. */
export function resetDeviceStore(): void {
  devices = null
  nextId = 4000
}
