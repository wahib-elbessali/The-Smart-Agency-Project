import { fetchJson } from '../client'
import type { Role, UserAccount, UserCreate, UserUpdate } from '../types'

/**
 * User account endpoints. Every one of them is **ADMIN only** - the whole
 * router carries `Depends(require_roles(RoleName.ADMIN))`, so a MANAGER who can
 * administer employees still gets a 403 here.
 *
 * There are five routes rather than two because the backend refuses to let role
 * and agency ride along in a general update. Each has a side effect a plain PUT
 * would hide, so each keeps its own call:
 *
 *   PATCH /role    promoting to ADMIN also clears the account's agency.
 *   PATCH /agency  also moves the linked employee, so a login and the person it
 *                  belongs to can never end up in different agencies.
 *
 * Keeping them separate here means one screen action is one request. A
 * combined save would have to sequence three calls and could leave a user
 * half-updated when the second one fails.
 */

export function fetchUsers(signal?: AbortSignal): Promise<UserAccount[]> {
  return fetchJson<UserAccount[]>(
    { key: 'GET /api/users', path: '/api/users', auth: true },
    { signal },
  )
}

/**
 * Creates an account. `password` is required and min 8 - it is not in the
 * contract, because the documented payload there is the response.
 *
 * The agency rule is inverted from the obvious one: ADMIN must send no
 * agency_id (422 if it does), every other role must send one.
 */
export function createUser(body: UserCreate, signal?: AbortSignal): Promise<UserAccount> {
  return fetchJson<UserAccount>(
    { key: 'POST /api/users', path: '/api/users', method: 'POST', auth: true },
    { signal, body },
  )
}

/** Profile fields only. Role and agency have their own routes below. */
export function updateUser(
  id: string,
  body: UserUpdate,
  signal?: AbortSignal,
): Promise<UserAccount> {
  return fetchJson<UserAccount>(
    { key: 'PUT /api/users/{id}', path: `/api/users/${id}`, method: 'PUT', auth: true },
    { signal, body },
  )
}

/**
 * Sets role and agency together — the route the screen actually uses.
 *
 * Added by PR #75 in answer to issue #71. It validates the **resulting** pair
 * instead of the account's current state, which is what makes it work where the
 * two single-field routes below could not: each of those checks against the
 * half the other one needs changed first, so an ADMIN could never be moved to
 * any other role by any ordering of them.
 *
 * The inverted agency rule is unchanged and still enforced here. Verified by
 * running the route rather than reading it:
 *
 *   {role: MANAGER, agency_id: <real>} on an ADMIN  -> 200
 *   {role: ADMIN,   agency_id: null}   on an AGENT  -> 200, agency cleared
 *   {role: ADMIN,   agency_id: <real>}              -> 422
 *   {role: MANAGER, agency_id: null}                -> 422
 *
 * A linked employee follows the new agency, exactly as it does on /agency.
 */
export function updateUserAccess(
  id: string,
  role: Role,
  agencyId: string | null,
  signal?: AbortSignal,
): Promise<UserAccount> {
  return fetchJson<UserAccount>(
    {
      key: 'PATCH /api/users/{id}/access',
      path: `/api/users/${id}/access`,
      method: 'PATCH',
      auth: true,
    },
    { signal, body: { role, agency_id: agencyId } },
  )
}

/**
 * Changes the role alone, leaving the agency to be derived.
 *
 * Kept because it is part of the documented API, but the screen no longer calls
 * it: it validates the new role against the account's *existing* agency, which
 * is why an ADMIN could not be demoted through it. `updateUserAccess` above
 * supersedes it for anything this dashboard does. The contract now says the
 * same - use /access when both values move.
 */
export function updateUserRole(id: string, role: Role, signal?: AbortSignal): Promise<UserAccount> {
  return fetchJson<UserAccount>(
    {
      key: 'PATCH /api/users/{id}/role',
      path: `/api/users/${id}/role`,
      method: 'PATCH',
      auth: true,
    },
    { signal, body: { role } },
  )
}

/**
 * Moves the account to another agency - and moves its linked employee with it.
 *
 * That second half is the reason this is not a field on the update route: the
 * write touches a row the caller never named. It is also why the same role rule
 * applies here, checked against the role the account has now.
 */
export function updateUserAgency(
  id: string,
  agencyId: string | null,
  signal?: AbortSignal,
): Promise<UserAccount> {
  return fetchJson<UserAccount>(
    {
      key: 'PATCH /api/users/{id}/agency',
      path: `/api/users/${id}/agency`,
      method: 'PATCH',
      auth: true,
    },
    { signal, body: { agency_id: agencyId } },
  )
}

/**
 * Deletes the account. Returns 204 with no body.
 *
 * Unlike deleting an employee this destroys no attendance history - an employee
 * row survives its login being removed, and the card keeps working. An ADMIN
 * cannot delete their own account (400).
 */
export function deleteUser(id: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    { key: 'DELETE /api/users/{id}', path: `/api/users/${id}`, method: 'DELETE', auth: true },
    { signal },
  )
}
