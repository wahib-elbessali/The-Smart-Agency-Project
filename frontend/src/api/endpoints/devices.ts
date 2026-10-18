import { fetchJson } from '../client'
import type { Device, DeviceCreate, DeviceRegistration, DeviceUpdate } from '../types'

/**
 * IoT device endpoints — contracts/api.md §9, added 2026-08-27.
 *
 * ADMIN, MANAGER and TECHNICIAN throughout, except `rotateKey`, which is
 * ADMIN and MANAGER only: a technician can register a sensor and see its
 * status, but not mint a new secret for it.
 */

export function fetchDevices(signal?: AbortSignal): Promise<Device[]> {
  return fetchJson<Device[]>(
    { key: 'GET /api/devices', path: '/api/devices', auth: true },
    { signal },
  )
}

/**
 * Registers a new device under an agency.
 *
 * `device_key` on the response is the ONLY time the plaintext secret is ever
 * sent - the backend stores just its hash and there is no route to recover a
 * lost one, only `rotateKey` to replace it. The caller has to show it once and
 * mean it.
 */
export function registerDevice(
  agencyId: string,
  body: DeviceCreate,
  signal?: AbortSignal,
): Promise<DeviceRegistration> {
  return fetchJson<DeviceRegistration>(
    {
      key: 'POST /api/devices/agencies/{id}',
      path: `/api/devices/agencies/${agencyId}`,
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

export function fetchDevice(id: string, signal?: AbortSignal): Promise<Device> {
  return fetchJson<Device>(
    { key: 'GET /api/devices/{id}', path: `/api/devices/${id}`, auth: true },
    { signal },
  )
}

/** Partial update - only the keys present are changed. */
export function updateDevice(
  id: string,
  body: DeviceUpdate,
  signal?: AbortSignal,
): Promise<Device> {
  return fetchJson<Device>(
    { key: 'PUT /api/devices/{id}', path: `/api/devices/${id}`, method: 'PUT', auth: true },
    { signal, body },
  )
}

/**
 * Mints a new device_key and invalidates the previous one immediately - the
 * device stops authenticating with its old key from this call onward, whether
 * or not it has been given the new one yet.
 */
export function rotateDeviceKey(id: string, signal?: AbortSignal): Promise<DeviceRegistration> {
  return fetchJson<DeviceRegistration>(
    {
      key: 'POST /api/devices/{id}/rotate-key',
      path: `/api/devices/${id}/rotate-key`,
      method: 'POST',
      auth: true,
    },
    { signal },
  )
}

export function deleteDevice(id: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    { key: 'DELETE /api/devices/{id}', path: `/api/devices/${id}`, method: 'DELETE', auth: true },
    { signal },
  )
}
