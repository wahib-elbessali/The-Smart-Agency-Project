import { fetchJson } from '../client'
import type {
  Employee,
  EmployeeCreate,
  EmployeeUpdate,
  RosterEntry,
  TrackedEmployee,
} from '../types'

/**
 * Employee endpoints. All of them require ADMIN or MANAGER - SECURITY cannot
 * reach any of this, even though it can read attendance. `fetchTrackedEmployees`
 * is the exception (ADMIN, MANAGER, SECURITY - same roles as /tracking and
 * /tickets/tracked, a monitoring read for the live map rather than an
 * employee-management action).
 *
 * Scoping is the backend's job, not ours. A MANAGER's list is filtered to their
 * agency server-side, creates are forced into it, and touching another agency's
 * employee is a 403. The frontend must not re-filter or it would silently hide
 * rows an ADMIN is entitled to see.
 */

export function fetchEmployees(signal?: AbortSignal): Promise<Employee[]> {
  return fetchJson<Employee[]>(
    { key: 'GET /api/employees', path: '/api/employees', auth: true },
    { signal },
  )
}

export function fetchTrackedEmployees(signal?: AbortSignal): Promise<TrackedEmployee[]> {
  return fetchJson<TrackedEmployee[]>(
    { key: 'GET /api/employees/tracked', path: '/api/employees/tracked', auth: true },
    { signal },
  )
}

/** Active employees' names - SECURITY may read this, unlike the list above. */
export function fetchRoster(signal?: AbortSignal): Promise<RosterEntry[]> {
  return fetchJson<RosterEntry[]>(
    { key: 'GET /api/employees/roster', path: '/api/employees/roster', auth: true },
    { signal },
  )
}

/** Manual fix: this tracked person is this employee. */
export function linkEmployeeTrack(
  employeeId: string,
  trackingId: string,
  signal?: AbortSignal,
): Promise<void> {
  return fetchJson<void>(
    {
      key: 'PUT /api/employees/{id}/tracking',
      path: `/api/employees/${employeeId}/tracking`,
      method: 'PUT',
      auth: true,
    },
    { signal, body: { tracking_id: trackingId } },
  )
}

/** Manual fix: this tracked person is not staff. */
export function unlinkTrack(trackingId: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/employees/tracked/{id}',
      path: `/api/employees/tracked/${encodeURIComponent(trackingId)}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}

export function createEmployee(body: EmployeeCreate, signal?: AbortSignal): Promise<Employee> {
  return fetchJson<Employee>(
    { key: 'POST /api/employees', path: '/api/employees', method: 'POST', auth: true },
    { signal, body },
  )
}

export function updateEmployee(
  id: string,
  body: EmployeeUpdate,
  signal?: AbortSignal,
): Promise<Employee> {
  return fetchJson<Employee>(
    { key: 'PUT /api/employees/{id}', path: `/api/employees/${id}`, method: 'PUT', auth: true },
    { signal, body },
  )
}

/**
 * Hard delete, and it cascades.
 *
 * Employee.attendance is `cascade="all, delete-orphan"`, so removing an
 * employee destroys every attendance record they ever had. There is no undo and
 * no soft-delete flag on this route. Setting status to INACTIVE is the
 * reversible alternative and is what the UI offers first.
 *
 * Returns 204 with no body.
 */
export function deleteEmployee(id: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/employees/{id}',
      path: `/api/employees/${id}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
