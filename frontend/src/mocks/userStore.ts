import type { EmployeeLink, Role, UserAccount, UserCreate, UserUpdate } from '@/api/types'
import { ApiError } from '@/api/errors'
import { AGENCY_ID, AGENCY_ID_RABAT, makeEmployee } from './fixtures/people'

/**
 * A writable account list for mock mode, alongside employeeStore.
 *
 * Same reason as that one: a create has to change what the next read returns,
 * or the screen looks broken. But this store carries more than state. The
 * account rules are the part of this API most likely to be got wrong, and they
 * are unusual enough that a form built against a frozen fixture would look
 * finished and fail on the first real request:
 *
 *   - an ADMIN must have NO agency; every other role must have one
 *   - promoting to ADMIN clears the agency
 *   - moving an account's agency moves its linked employee too
 *   - an employee links to at most one account, in the same agency
 *
 * Every rule below mirrors backend/app/api/users.py, with the same status codes
 * and the same French `detail` strings, so a screen that handles them here
 * handles them against the real backend.
 */

function link(index: number, agencyId = AGENCY_ID): EmployeeLink {
  const employee = makeEmployee(index, agencyId)
  return {
    id: employee.id,
    first_name: employee.first_name,
    last_name: employee.last_name,
    agency_id: employee.agency_id,
    rfid_uid: employee.rfid_uid,
  }
}

/* Ids match the auth fixtures: the signed-in MANAGER is index 1 here and the
   ADMIN is index 2, so "you cannot delete your own account" has a row to
   apply to. */
function seedUsers(): UserAccount[] {
  return [
    {
      id: 'u1000000-0000-4000-8000-000000000001',
      full_name: 'Leila Fassi',
      email: 'leila@agency.com',
      role: 'MANAGER',
      agency_id: AGENCY_ID,
      employee_id: link(1).id,
      is_active: true,
      employee: link(1),
    },
    {
      id: 'u1000000-0000-4000-8000-000000000002',
      full_name: 'Admin Test',
      email: 'admin@test.com',
      role: 'ADMIN',
      /* The one account with no agency, and the reason the column is nullable. */
      agency_id: null,
      employee_id: null,
      is_active: true,
      employee: null,
    },
    {
      id: 'u1000000-0000-4000-8000-000000000003',
      full_name: 'Mehdi Ouazzani',
      email: 'mehdi@agency.com',
      role: 'SECURITY',
      agency_id: AGENCY_ID,
      employee_id: link(4).id,
      is_active: true,
      employee: link(4),
    },
    {
      id: 'u1000000-0000-4000-8000-000000000004',
      full_name: 'Karim Tazi',
      email: 'karim@agency.com',
      role: 'TECHNICIAN',
      agency_id: AGENCY_ID_RABAT,
      /* A login with no person behind it - allowed, and the case a table that
         assumes `employee` is present renders as "undefined undefined". */
      employee_id: null,
      is_active: true,
      employee: null,
    },
    {
      id: 'u1000000-0000-4000-8000-000000000005',
      full_name: 'Nadia Cherkaoui',
      email: 'nadia@agency.com',
      role: 'AGENT',
      agency_id: AGENCY_ID,
      employee_id: null,
      is_active: false,
      employee: null,
    },
  ]
}

let users: UserAccount[] | null = null
let nextId = 1000

function seed(): UserAccount[] {
  if (users === null) users = seedUsers()
  return users
}

export function listUsers(): UserAccount[] {
  return [...seed()]
}

/** Mirrors validate_agency_for_role - note which way round it is. */
function assertAgencyMatchesRole(role: Role, agencyId: string | null): void {
  if (role === 'ADMIN') {
    if (agencyId != null) {
      throw new ApiError('http', 'Un ADMIN est global et ne doit pas avoir d agence', 422)
    }
    return
  }
  if (agencyId == null) {
    throw new ApiError('http', 'Une agence est obligatoire pour ce role', 422)
  }
}

function assertEmailFree(email: string, ignoreId?: string): void {
  const taken = seed().some((u) => u.id !== ignoreId && u.email === email.trim().toLowerCase())
  if (taken) throw new ApiError('http', 'Cette adresse email existe deja', 409)
}

/** Mirrors link_employee: one account per employee, and same agency. */
function resolveLink(
  employeeId: string | null | undefined,
  agencyId: string | null,
  ignoreId?: string,
): EmployeeLink | null {
  if (employeeId == null) return null

  const alreadyLinked = seed().some((u) => u.id !== ignoreId && u.employee_id === employeeId)
  if (alreadyLinked) throw new ApiError('http', 'Cet employe est deja lie a un compte', 409)

  const known = seed().find((u) => u.employee?.id === employeeId)?.employee
  const employee = known ?? { ...link(0), id: employeeId, agency_id: agencyId ?? AGENCY_ID }

  if (agencyId != null && employee.agency_id !== agencyId) {
    throw new ApiError(
      'http',
      'L employe et l utilisateur doivent appartenir a la meme agence',
      422,
    )
  }
  return employee
}

export function createUser(body: UserCreate): UserAccount {
  /* Role defaults to AGENT server-side, so the check has to use the same
     default or the mock would accept a payload the backend rejects. */
  const role: Role = body.role ?? 'AGENT'
  const agencyId = body.agency_id ?? null

  assertAgencyMatchesRole(role, agencyId)
  assertEmailFree(body.email)
  const employee = resolveLink(body.employee_id, agencyId)

  const created: UserAccount = {
    id: `u9000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`,
    full_name: body.full_name.trim(),
    email: body.email.trim().toLowerCase(),
    role,
    agency_id: agencyId,
    employee_id: employee?.id ?? null,
    is_active: true,
    employee,
  }

  seed().unshift(created)
  return created
}

function indexOf(id: string): number {
  const index = seed().findIndex((u) => u.id === id)
  if (index === -1) throw new ApiError('http', 'Utilisateur introuvable', 404)
  return index
}

export function updateUser(id: string, body: UserUpdate): UserAccount {
  const list = seed()
  const index = indexOf(id)
  const current = list[index]

  if (body.email != null) assertEmailFree(body.email, id)

  /* exclude_unset: an absent employee_id keeps the link, an explicit null
     clears it. `in` distinguishes the two; `??` would not. */
  const employee =
    'employee_id' in body ? resolveLink(body.employee_id, current.agency_id, id) : current.employee

  const updated: UserAccount = {
    ...current,
    ...(body.full_name != null ? { full_name: body.full_name.trim() } : {}),
    ...(body.email != null ? { email: body.email.trim().toLowerCase() } : {}),
    ...(body.is_active != null ? { is_active: body.is_active } : {}),
    employee,
    employee_id: employee?.id ?? null,
  }

  list[index] = updated
  return updated
}

export function updateUserRole(id: string, role: Role): UserAccount {
  const list = seed()
  const index = indexOf(id)
  const current = list[index]

  /* The backend passes the account's CURRENT agency when the new role is not
     ADMIN. That is what makes demoting an admin impossible: theirs is null, so
     this throws 422 and no ordering of calls avoids it. Reproduced rather than
     smoothed over - a mock that allows what the API forbids is worse than no
     mock, because the screen gets written against the wrong rule. */
  assertAgencyMatchesRole(role, role === 'ADMIN' ? null : current.agency_id)

  const updated: UserAccount = {
    ...current,
    role,
    agency_id: role === 'ADMIN' ? null : current.agency_id,
  }
  list[index] = updated
  return updated
}

/**
 * PATCH /access - role and agency together, validated as the resulting pair.
 *
 * The difference from updateUserRole below is the whole reason the route
 * exists: this checks the pair you are asking for, not the one the account
 * currently has. So demoting an admin works here and does not there.
 */
export function updateUserAccess(id: string, role: Role, agencyId: string | null): UserAccount {
  const list = seed()
  const index = indexOf(id)
  const current = list[index]

  assertAgencyMatchesRole(role, agencyId)

  const updated: UserAccount = {
    ...current,
    role,
    agency_id: agencyId,
    /* A linked employee follows the new agency. The backend only moves them
       when the new agency is non-null, so an account promoted to ADMIN keeps
       its employee where it is. */
    employee:
      current.employee && agencyId != null
        ? { ...current.employee, agency_id: agencyId }
        : current.employee,
  }
  list[index] = updated
  return updated
}

export function updateUserAgency(id: string, agencyId: string | null): UserAccount {
  const list = seed()
  const index = indexOf(id)
  const current = list[index]

  /* Validated against the role the account has now, not a new one. */
  assertAgencyMatchesRole(current.role, agencyId)

  const updated: UserAccount = {
    ...current,
    agency_id: agencyId,
    /* The linked employee moves too. */
    employee:
      current.employee && agencyId != null
        ? { ...current.employee, agency_id: agencyId }
        : current.employee,
  }
  list[index] = updated
  return updated
}

export function deleteUser(id: string): void {
  seed().splice(indexOf(id), 1)
}

/** Tests only - module state would otherwise leak between them. */
export function resetUserStore(): void {
  users = null
  nextId = 1000
}
