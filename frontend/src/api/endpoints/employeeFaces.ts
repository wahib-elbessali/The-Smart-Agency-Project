import { fetchJson } from '../client'

/**
 * An employee's face for badge + face doors - backend/app/api/employee_faces.py.
 * Enrolled under a key tied to the employee, so a door can check that the
 * face is the badge holder's. ADMIN and MANAGER (own branch).
 */

export interface EmployeeFace {
  enrolled: boolean
  photos: number
}

export function fetchEmployeeFace(employeeId: string, signal?: AbortSignal): Promise<EmployeeFace> {
  return fetchJson<EmployeeFace>(
    {
      key: 'GET /api/employees/{id}/face',
      path: `/api/employees/${employeeId}/face`,
      auth: true,
    },
    { signal },
  )
}

/** 422 when the photo does not hold exactly one face. */
export function enrollEmployeeFace(
  employeeId: string,
  image: File,
  signal?: AbortSignal,
): Promise<EmployeeFace> {
  const form = new FormData()
  form.append('image', image)
  return fetchJson<EmployeeFace>(
    {
      key: 'POST /api/employees/{id}/face',
      path: `/api/employees/${employeeId}/face`,
      method: 'POST',
      auth: true,
    },
    { signal, body: form },
  )
}

export function deleteEmployeeFace(employeeId: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/employees/{id}/face',
      path: `/api/employees/${employeeId}/face`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
