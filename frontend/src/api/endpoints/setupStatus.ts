import { fetchJson } from '../client'
import type { SetupStatus } from '../types'

/**
 * What a branch still needs before it is fully set up. ADMIN, and MANAGER for
 * their own branch. Derived live on the server from data that already exists,
 * so there is nothing stored to keep in step; informational only.
 */
export function fetchSetupStatus(agencyId: string, signal?: AbortSignal): Promise<SetupStatus> {
  return fetchJson<SetupStatus>(
    {
      key: 'GET /api/agencies/{id}/setup-status',
      path: `/api/agencies/${agencyId}/setup-status`,
      auth: true,
    },
    { signal },
  )
}
