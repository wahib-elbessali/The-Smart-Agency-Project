import { registerMock, registerMockWriter } from '../registry'
import type { Role, UserAccount, UserCreate, UserUpdate } from '@/api/types'
import * as store from '../userStore'

/**
 * Field names from GET /api/users, corrected against
 * backend/app/schemas/user.py - the contract documents the response only, so
 * `password` on the create payload is not in it at all.
 *
 * `normal` reads through the writable store so a created account actually
 * appears in the list. `empty` and `large` stay frozen: they exist to test
 * rendering at the extremes, not to be edited.
 */

registerMock<UserAccount[]>('GET /api/users', {
  normal: () => store.listUsers(),
  /* An empty user list cannot really happen - somebody had to sign in to see
     this screen - but the boundary has to render something rather than an
     empty table with a header. */
  empty: () => [],
  large: () =>
    Array.from({ length: 120 }, (_, i) => ({
      ...store.listUsers()[i % 5],
      id: `u2000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      full_name: `Compte ${i + 1}`,
      email: `compte${i + 1}@agency.com`,
    })),
})

registerMockWriter('POST /api/users', (body) => store.createUser(body as UserCreate))

/** The id is in the path, not the body - same as the real request. */
function idFrom(path: string): string {
  return (
    path
      .replace(/\/(role|agency|access)$/, '')
      .split('/')
      .pop() ?? ''
  )
}

registerMockWriter('PUT /api/users/{id}', (body, path) =>
  store.updateUser(idFrom(path), body as UserUpdate),
)

registerMockWriter('PATCH /api/users/{id}/access', (body, path) => {
  const { role, agency_id } = body as { role: Role; agency_id: string | null }
  return store.updateUserAccess(idFrom(path), role, agency_id)
})

registerMockWriter('PATCH /api/users/{id}/role', (body, path) =>
  store.updateUserRole(idFrom(path), (body as { role: Role }).role),
)

registerMockWriter('PATCH /api/users/{id}/agency', (body, path) =>
  store.updateUserAgency(idFrom(path), (body as { agency_id: string | null }).agency_id),
)

registerMockWriter('DELETE /api/users/{id}', (_body, path) => {
  store.deleteUser(idFrom(path))
  return undefined
})
