import { fetchJson } from '../client'
import type { WeaponThreshold } from '../types'

/**
 * AI alert configuration — contracts/api.md §12, added 2026-09-12.
 *
 * ADMIN, MANAGER and SECURITY. One global value, no agency in the path: the
 * backend applies it to every camera's detections the moment it is saved.
 */

export function fetchWeaponThreshold(signal?: AbortSignal): Promise<WeaponThreshold> {
  return fetchJson<WeaponThreshold>(
    {
      key: 'GET /api/ai-alerts/thresholds/weapon',
      path: '/api/ai-alerts/thresholds/weapon',
      auth: true,
    },
    { signal },
  )
}

/** 422 unless 0 < confidence <= 1. */
export function setWeaponThreshold(
  body: WeaponThreshold,
  signal?: AbortSignal,
): Promise<WeaponThreshold> {
  return fetchJson<WeaponThreshold>(
    {
      key: 'PUT /api/ai-alerts/thresholds/weapon',
      path: '/api/ai-alerts/thresholds/weapon',
      method: 'PUT',
      auth: true,
    },
    { signal, body },
  )
}
