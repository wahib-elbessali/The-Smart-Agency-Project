import { fetchJson } from '../client'
import type { LatestClimateReading } from '../types'

/**
 * Indoor sensor readings (DHT22, MQ-2/MQ-7, ...) - contracts/api.md, added
 * 2026-09-23. No role restriction, same as the rest of /climate.
 */
export function fetchLatestClimate(
  agencyId: string,
  signal?: AbortSignal,
): Promise<LatestClimateReading[]> {
  return fetchJson<LatestClimateReading[]>(
    {
      key: 'GET /api/agencies/{id}/climate/latest',
      path: `/api/agencies/${agencyId}/climate/latest`,
      auth: true,
    },
    { signal },
  )
}
