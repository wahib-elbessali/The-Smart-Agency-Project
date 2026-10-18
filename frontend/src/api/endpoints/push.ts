import { fetchJson } from '../client'
import type { PushPublicKey, PushSubscriptionBody } from '../types'

/**
 * Web Push registration for the CRITICAL-alert pipeline. ADMIN, MANAGER and
 * SECURITY only - the same roles the backend notifies. The alerts themselves
 * are sent by the backend; the frontend only registers/unregisters this
 * browser as somewhere to send them.
 */

export function fetchPushPublicKey(signal?: AbortSignal): Promise<PushPublicKey> {
  return fetchJson<PushPublicKey>(
    { key: 'GET /api/push/public-key', path: '/api/push/public-key', auth: true },
    { signal },
  )
}

export function savePushSubscription(
  body: PushSubscriptionBody,
  signal?: AbortSignal,
): Promise<void> {
  return fetchJson<void>(
    {
      key: 'POST /api/push/subscriptions',
      path: '/api/push/subscriptions',
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

export function deletePushSubscription(endpoint: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/push/subscriptions',
      path: `/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
