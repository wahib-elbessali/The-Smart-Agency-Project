import { fetchJson } from '../client'
import type { SensorThreshold, SensorThresholdUpsert } from '../types'

/**
 * Sensor threshold endpoints — contracts/api.md §10, added 2026-08-27.
 * ADMIN, MANAGER and TECHNICIAN, same as the device routes they hang off.
 */

export function fetchThresholds(
  deviceId: string,
  signal?: AbortSignal,
): Promise<SensorThreshold[]> {
  return fetchJson<SensorThreshold[]>(
    {
      key: 'GET /api/devices/{id}/thresholds',
      path: `/api/devices/${deviceId}/thresholds`,
      auth: true,
    },
    { signal },
  )
}

/**
 * Creates the threshold for this device/sensor pair if none exists yet,
 * otherwise replaces it whole - there is no separate create route, PUT is
 * both. At least one of `warning_max` / `critical_max` is required and
 * `warning_max` must not exceed `critical_max`; the server answers 422 if not.
 */
export function upsertThreshold(
  deviceId: string,
  sensorType: string,
  body: SensorThresholdUpsert,
  signal?: AbortSignal,
): Promise<SensorThreshold> {
  return fetchJson<SensorThreshold>(
    {
      key: 'PUT /api/devices/{id}/thresholds/{sensor_type}',
      path: `/api/devices/${deviceId}/thresholds/${encodeURIComponent(sensorType)}`,
      method: 'PUT',
      auth: true,
    },
    { signal, body },
  )
}

export function deleteThreshold(
  deviceId: string,
  sensorType: string,
  signal?: AbortSignal,
): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/devices/{id}/thresholds/{sensor_type}',
      path: `/api/devices/${deviceId}/thresholds/${encodeURIComponent(sensorType)}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
