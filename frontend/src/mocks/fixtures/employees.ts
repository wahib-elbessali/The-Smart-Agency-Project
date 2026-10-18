import { registerMock, registerMockWriter } from '../registry'
import type { Employee, EmployeeCreate, EmployeeUpdate, TrackedEmployee } from '@/api/types'
import { makeEmployees } from './people'
import * as store from '../employeeStore'
import { trackLinks } from './security'

/* The normal scenario reads through the writable store, so a row created in
   the admin screen actually appears. empty and large stay frozen - they exist
   to test rendering at the extremes, not to be edited. */
registerMock<Employee[]>('GET /api/employees', {
  normal: () => store.listEmployees(),
  empty: () => [],
  /* 200 rows: a table that reads fine at 10 can still stutter or overflow here,
     and that is exactly what the 'large' scenario is for. */
  large: () => makeEmployees(200),
})

registerMockWriter('POST /api/employees', (body) => store.createEmployee(body as EmployeeCreate))

/* Employee badge-scan tracking link is
 * entirely backend/AI-driven - same reasoning as tickets/tracked's fixture,
 * the mock store has no notion of live tracked people, so always empty is
 * the honest fixture. */
registerMock<TrackedEmployee[]>('GET /api/employees/tracked', {
  /* Only the links someone made by hand on the live map (security.ts):
     the mock has no badge scans linking anyone on its own. */
  normal: () =>
    [...trackLinks].flatMap(([tracking_id, employeeId]) => {
      const employee = store.listEmployees().find((e) => e.id === employeeId)
      return employee
        ? [
            {
              employee_id: employee.id,
              full_name: `${employee.first_name} ${employee.last_name}`,
              tracking_id,
            },
          ]
        : []
    }),
  empty: () => [],
  large: () => [],
})

/* The id is in the path, not the body - same as the real request. Parsing it
   back out keeps the mock path and the HTTP path identical, so nothing extra
   has to be smuggled into the request just to make fixtures work. */
function idFrom(path: string): string {
  return path.split('/').pop() ?? ''
}

registerMockWriter('PUT /api/employees/{id}', (body, path) =>
  store.updateEmployee(idFrom(path), body as EmployeeUpdate),
)

registerMockWriter('DELETE /api/employees/{id}', (_body, path) => {
  store.deleteEmployee(idFrom(path))
  return undefined
})
