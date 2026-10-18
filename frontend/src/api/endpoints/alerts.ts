import { fetchJson } from '../client'
import type { StoredAlert } from '../types'

/**
 * Stored business alerts - contracts/api.md §14, added in #112.
 *
 * ADMIN reads any agency; MANAGER and SECURITY only their own (403
 * otherwise). Newest first. `alertType` filters server-side, e.g. 'weapon'.
 *
 * There is no limit or paging: the backend returns every alert the agency
 * has ever had of that type.
 */
export function fetchStoredAlerts(
  agencyId: string,
  alertType?: string,
  signal?: AbortSignal,
): Promise<StoredAlert[]> {
  const query = alertType ? `?alert_type=${encodeURIComponent(alertType)}` : ''
  return fetchJson<StoredAlert[]>(
    {
      key: 'GET /api/agencies/{id}/alerts',
      path: `/api/agencies/${agencyId}/alerts${query}`,
      auth: true,
    },
    { signal },
  )
}

/** Marks an OPEN alert as seen; it stays active until its cause clears. */
export function acknowledgeAlert(alertId: string, signal?: AbortSignal): Promise<StoredAlert> {
  return fetchJson<StoredAlert>(
    {
      key: 'POST /api/alerts/{id}/acknowledge',
      path: `/api/alerts/${alertId}/acknowledge`,
      method: 'POST',
      auth: true,
    },
    { signal },
  )
}

/** A person closes the incident (weapon and watchlist alerts only close this way). */
export function resolveAlert(alertId: string, signal?: AbortSignal): Promise<StoredAlert> {
  return fetchJson<StoredAlert>(
    {
      key: 'POST /api/alerts/{id}/resolve',
      path: `/api/alerts/${alertId}/resolve`,
      method: 'POST',
      auth: true,
    },
    { signal },
  )
}

/** A false intrusion alarm: the person is this employee. Links them and closes it. */
export function intrusionIsStaff(
  alertId: string,
  employeeId: string,
  signal?: AbortSignal,
): Promise<StoredAlert> {
  return fetchJson<StoredAlert>(
    {
      key: 'POST /api/alerts/{id}/its-staff',
      path: `/api/alerts/${alertId}/its-staff`,
      method: 'POST',
      auth: true,
    },
    { signal, body: { employee_id: employeeId } },
  )
}
