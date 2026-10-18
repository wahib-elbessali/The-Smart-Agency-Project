import type { Employee, EmployeeCreate, EmployeeUpdate } from '@/api/types'
import { ApiError } from '@/api/errors'
import { AGENCY_ID, makeEmployees } from './fixtures/people'

/**
 * A writable employee list for mock mode.
 *
 * The rest of the mock layer is pure - a key maps to a function returning a
 * fixture - which is right for read-only screens. It is wrong for a screen
 * whose whole purpose is creating and editing: a create would return a
 * plausible response, the list would refetch the same frozen fixture, and the
 * new row would never appear. That looks like a bug in the screen rather than
 * a limitation of the fixtures, which is the worst of both.
 *
 * So this holds state for the session. It also enforces the rules the backend
 * enforces, because a form that only discovers "RFID already used" against a
 * real server is a form nobody has actually tested.
 */

let employees: Employee[] | null = null
let nextId = 1000

function seed(): Employee[] {
  if (employees === null) employees = makeEmployees(10)
  return employees
}

export function listEmployees(): Employee[] {
  return [...seed()]
}

/** Mirrors the 409 the backend raises from its unique constraints. */
function assertUnique(candidate: Partial<Employee>, ignoreId?: string): void {
  const clash = seed().some(
    (e) =>
      e.id !== ignoreId &&
      ((candidate.email != null && e.email === candidate.email) ||
        (candidate.rfid_uid != null && e.rfid_uid === candidate.rfid_uid)),
  )
  if (clash) {
    throw new ApiError('http', 'Email ou carte RFID deja utilise.', 409)
  }
}

export function createEmployee(body: EmployeeCreate): Employee {
  assertUnique({ email: body.email ?? null, rfid_uid: body.rfid_uid ?? null })

  const status = body.status ?? 'ACTIVE'
  const created: Employee = {
    id: `e9000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`,
    agency_id: body.agency_id ?? AGENCY_ID,
    first_name: body.first_name,
    last_name: body.last_name,
    email: body.email ?? null,
    phone: body.phone ?? null,
    position: body.position ?? null,
    rfid_uid: body.rfid_uid ?? null,
    status,
    hire_date: body.hire_date ?? null,
    /* The backend derives this rather than accepting it. */
    is_active: status === 'ACTIVE',
    authorized_zone_ids: body.authorized_zone_ids ?? [],
  }

  seed().unshift(created)
  return created
}

export function updateEmployee(id: string, body: EmployeeUpdate): Employee {
  const list = seed()
  const index = list.findIndex((e) => e.id === id)
  if (index === -1) throw new ApiError('http', 'Employe introuvable.', 404)

  assertUnique({ email: body.email, rfid_uid: body.rfid_uid }, id)

  /* The backend uses exclude_unset, so an absent key is untouched while an
     explicit null clears the field. Object spread reproduces that exactly. */
  const updated: Employee = { ...list[index], ...body }
  updated.is_active = updated.status === 'ACTIVE'

  list[index] = updated
  return updated
}

export function deleteEmployee(id: string): void {
  const list = seed()
  const index = list.findIndex((e) => e.id === id)
  if (index === -1) throw new ApiError('http', 'Employe introuvable.', 404)
  list.splice(index, 1)
}

/** Tests only - module state would otherwise leak between them. */
export function resetEmployeeStore(): void {
  employees = null
  nextId = 1000
}
