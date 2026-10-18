import type { SensorThreshold, SensorThresholdUpsert } from '@/api/types'
import { ApiError } from '@/api/errors'
import { DEVICE_ID_DHT22 } from './deviceStore'

/**
 * A writable sensor threshold list for mock mode, scoped per device.
 *
 * PUT is the only write route and it upserts - there is no separate create,
 * matching backend/app/api/thresholds.py's `upsert_threshold`. `sensor_type`
 * is the natural key alongside `device_id` (uq_threshold_device_sensor), so
 * this store is keyed the same way rather than by a synthetic lookup.
 */

let thresholds: SensorThreshold[] | null = null
let nextId = 5000

function seed(): SensorThreshold[] {
  if (thresholds === null) {
    thresholds = [
      {
        id: 'th100000-0000-4000-8000-000000000001',
        device_id: DEVICE_ID_DHT22,
        sensor_type: 'temperature',
        unit: 'C',
        warning_max: 30,
        critical_max: 40,
        is_active: true,
      },
      {
        id: 'th100000-0000-4000-8000-000000000002',
        device_id: DEVICE_ID_DHT22,
        sensor_type: 'humidity',
        unit: '%',
        warning_max: 70,
        critical_max: 85,
        is_active: true,
      },
    ]
  }
  return thresholds
}

function normalizeSensorType(sensorType: string): string {
  const normalized = sensorType.trim().toLowerCase()
  if (!normalized || normalized.length > 80) {
    throw new ApiError('http', 'Type de capteur invalide', 422)
  }
  return normalized
}

export function listThresholds(deviceId: string): SensorThreshold[] {
  return seed()
    .filter((t) => t.device_id === deviceId)
    .map((t) => ({ ...t }))
}

export function upsertThreshold(
  deviceId: string,
  sensorType: string,
  body: SensorThresholdUpsert,
): SensorThreshold {
  if (body.warning_max == null && body.critical_max == null) {
    throw new ApiError('http', 'warning_max ou critical_max est obligatoire', 422)
  }
  if (
    body.warning_max != null &&
    body.critical_max != null &&
    body.warning_max > body.critical_max
  ) {
    throw new ApiError('http', 'warning_max doit etre inferieur ou egal a critical_max', 422)
  }

  const normalized = normalizeSensorType(sensorType)
  const list = seed()
  const index = list.findIndex((t) => t.device_id === deviceId && t.sensor_type === normalized)

  const updated: SensorThreshold = {
    id:
      index === -1
        ? `th900000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`
        : list[index].id,
    device_id: deviceId,
    sensor_type: normalized,
    unit: body.unit?.trim() || null,
    warning_max: body.warning_max ?? null,
    critical_max: body.critical_max ?? null,
    is_active: body.is_active ?? true,
  }

  if (index === -1) list.push(updated)
  else list[index] = updated
  return { ...updated }
}

export function deleteThreshold(deviceId: string, sensorType: string): void {
  const normalized = normalizeSensorType(sensorType)
  const list = seed()
  const index = list.findIndex((t) => t.device_id === deviceId && t.sensor_type === normalized)
  if (index === -1) throw new ApiError('http', 'Seuil introuvable', 404)
  list.splice(index, 1)
}

/** Cascades with the owning device - Device.thresholds is delete-orphan. */
export function deleteThresholdsForDevice(deviceId: string): void {
  thresholds = seed().filter((t) => t.device_id !== deviceId)
}

/** Tests only - module state would otherwise leak between them. */
export function resetThresholdStore(): void {
  thresholds = null
  nextId = 5000
}
