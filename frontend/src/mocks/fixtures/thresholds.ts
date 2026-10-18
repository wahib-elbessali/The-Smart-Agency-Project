import { registerMock, registerMockWriter } from '../registry'
import type { SensorThreshold, SensorThresholdUpsert } from '@/api/types'
import * as store from '../thresholdStore'

/**
 * Field names from SensorThresholdResponse in backend/app/schemas/threshold.py.
 * contracts/api.md §10, added 2026-08-27.
 */

/** /api/devices/{device_id}/thresholds - the device id is second-to-last. */
function deviceIdFromListPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

registerMock<SensorThreshold[]>('GET /api/devices/{id}/thresholds', {
  normal: (path) => store.listThresholds(deviceIdFromListPath(path)),
  empty: () => [],
  large: (path) => store.listThresholds(deviceIdFromListPath(path)),
})

/** /api/devices/{device_id}/thresholds/{sensor_type} - device id is third-from-end. */
function idsFromDetailPath(path: string): { deviceId: string; sensorType: string } {
  const parts = path.split('/').filter(Boolean)
  return {
    deviceId: parts[parts.length - 3] ?? '',
    sensorType: decodeURIComponent(parts[parts.length - 1] ?? ''),
  }
}

registerMockWriter('PUT /api/devices/{id}/thresholds/{sensor_type}', (body, path) => {
  const { deviceId, sensorType } = idsFromDetailPath(path)
  return store.upsertThreshold(deviceId, sensorType, body as SensorThresholdUpsert)
})

registerMockWriter('DELETE /api/devices/{id}/thresholds/{sensor_type}', (_body, path) => {
  const { deviceId, sensorType } = idsFromDetailPath(path)
  store.deleteThreshold(deviceId, sensorType)
  return undefined
})
