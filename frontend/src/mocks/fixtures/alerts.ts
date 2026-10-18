import { registerMock } from '../registry'
import type { StoredAlert } from '@/api/types'
import { ApiError } from '@/api/errors'
import * as store from '../alertStore'
import { requestUser } from '../currentUser'

/**
 * Field names from AlertResponse in backend/app/schemas/alert.py.
 * contracts/api.md §14, added in #112.
 *
 * Scoped the way backend/app/api/alerts.py scopes it: ADMIN any agency, and
 * anyone else asking about a branch that isn't theirs gets 403 "Acces limite
 * a votre agence".
 */
function scopedList(path: string): StoredAlert[] {
  const url = new URL(path, 'http://mock')
  const parts = url.pathname.split('/').filter(Boolean)
  /* /api/agencies/{agency_id}/alerts - the id is second-to-last. */
  const agencyId = parts[parts.length - 2] ?? ''

  const user = requestUser()
  if (user && user.role !== 'ADMIN' && user.agency_id !== agencyId) {
    throw new ApiError('http', 'Acces limite a votre agence', 403)
  }
  return store.listAlerts(agencyId, url.searchParams.get('alert_type'))
}

registerMock<StoredAlert[]>('GET /api/agencies/{id}/alerts', {
  normal: scopedList,
  empty: () => [],
  large: scopedList,
})
