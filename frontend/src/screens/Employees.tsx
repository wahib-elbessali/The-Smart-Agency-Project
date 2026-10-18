import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Pencil, Plus, Trash2, UserPlus } from 'lucide-react'
import {
  createEmployee,
  deleteEmployee,
  fetchEmployees,
  updateEmployee,
} from '@/api/endpoints/employees'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { ApiError, describeApiError } from '@/api/errors'
import type { Employee, EmployeeCreate } from '@/api/types'
import { useScope, withinScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Avatar } from '@/components/ui/Avatar'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { EmployeeForm } from './EmployeeForm'
import { Screen } from './Screen'

/**
 * Employee administration.
 *
 * The plan document puts this before the users module, and the ordering is
 * real: an employee is the person, with the RFID card and the attendance
 * history, while a user is only a login. Presence and IoT both hang off
 * employees, so they have to exist first.
 *
 * Every route here is ADMIN or MANAGER. A MANAGER's list is scoped to their own
 * agency by the backend and their creates are forced into it - so the agency
 * picker is hidden for them rather than shown and ignored.
 */

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'ok',
  INACTIVE: 'neutral',
  ON_LEAVE: 'warn',
}

export default function Employees() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'

  const employees = useQuery({
    queryKey: ['employees'],
    queryFn: ({ signal }) => fetchEmployees(signal),
  })

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    /* Only an admin picks an agency; a manager's is forced server-side. */
    enabled: isAdmin,
  })

  const [editing, setEditing] = useState<Employee | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<Employee | null>(null)

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    save.reset()
  }

  const save = useMutation({
    mutationFn: (values: EmployeeCreate) => {
      if (!editing) return createEmployee(values)

      /* An update must not carry a null agency_id. The column is NOT NULL, so
         clearing it fails at the database rather than in validation - and an
         employee always belongs to an agency anyway. Omitting the key leaves
         it untouched, which is what editing anything else should do. */
      const { agency_id, ...rest } = values
      return updateEmployee(editing.id, agency_id ? { ...rest, agency_id } : rest)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      closeForm()
    },
  })

  const remove = useMutation({
    mutationFn: (employee: Employee) => deleteEmployee(employee.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      /* Attendance is cascade-deleted with the employee, so the presence screen
         is now wrong until it refetches. */
      await queryClient.invalidateQueries({ queryKey: ['attendance'] })
      setConfirmingDelete(null)
    },
  })

  /* Narrowed to the branch an admin has open, if they have one. Not a
     permission - the rows are all theirs to see - so it does nothing at all
     unless somebody chose it, and the bar in AppShell says so while it lasts. */
  const rows = useMemo(
    () => withinScope(employees.data ?? [], scope.agencyId),
    [employees.data, scope.agencyId],
  )
  const formOpen = creating || editing !== null

  return (
    <Screen
      title="Employees"
      description="The people an agency employs, their cards and their status."
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden />
          Add employee
        </Button>
      }
    >
      <AsyncBoundary
        isPending={employees.isPending}
        error={employees.error}
        isEmpty={rows.length === 0}
        emptyMessage="No employees yet. Add the first one to get started."
        forbiddenMessage="Employees are managed by administrators and managers. Ask an administrator if you need access."
        onRetry={() => void employees.refetch()}
        skeletonRows={6}
      >
        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-ink text-sm font-semibold">
                {isAdmin ? 'All agencies' : 'Your agency'}
              </h2>
              <span className="text-ink-3 tabular text-xs">
                {rows.length} {rows.length === 1 ? 'employee' : 'employees'}
              </span>
            </div>
          </PanelHeader>
          <PanelBody flush>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Employees, with their card and status</caption>
                <thead>
                  <tr className="text-ink-3 tracked border-line/70 border-b text-left text-[10px] font-medium">
                    <th scope="col" className="px-6 py-3 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-6 py-3 font-medium">
                      Position
                    </th>
                    <th scope="col" className="px-6 py-3 font-medium">
                      Card
                    </th>
                    <th scope="col" className="px-6 py-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((employee) => {
                    const name = `${employee.first_name} ${employee.last_name}`
                    return (
                      <tr
                        key={employee.id}
                        className="border-line/70 hover:bg-panel-2/60 ease-soft border-b transition-colors duration-150 last:border-b-0"
                      >
                        <th scope="row" className="px-6 py-3 text-left font-normal">
                          <div className="flex items-center gap-3">
                            <Avatar name={name} />
                            <div className="min-w-0">
                              <div className="text-ink truncate font-medium">{name}</div>
                              {employee.email && (
                                <div className="text-ink-3 truncate text-xs">{employee.email}</div>
                              )}
                            </div>
                          </div>
                        </th>
                        <td className="text-ink-2 px-6 py-3">
                          {employee.position ?? <span className="text-ink-3">—</span>}
                        </td>
                        <td className="text-ink-2 px-6 py-3 font-mono text-[0.8125rem]">
                          {employee.rfid_uid ?? (
                            <span
                              className="text-ink-3 font-sans"
                              title="Cannot check in without a card"
                            >
                              No card
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3">
                          <Badge tone={STATUS_TONE[employee.status] ?? 'neutral'}>
                            {employee.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditing(employee)}
                              aria-label={`Edit ${name}`}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmingDelete(employee)}
                              aria-label={`Delete ${name}`}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </PanelBody>
        </Panel>
      </AsyncBoundary>

      <Dialog
        open={formOpen}
        title={editing ? 'Edit employee' : 'Add employee'}
        description={editing ? undefined : 'They can be given an RFID card now or later.'}
        onClose={closeForm}
      >
        {formOpen && (
          <EmployeeForm
            employee={editing}
            agencies={agencies.data ?? []}
            defaultAgencyId={user?.agency_id ?? null}
            canChooseAgency={isAdmin}
            pending={save.isPending}
            error={save.error}
            onCancel={closeForm}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this employee?"
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <div>
            {/* The API hard-deletes, and Employee.attendance cascades with it.
                Saying so plainly matters more than the confirmation step: most
                people clicking this want INACTIVE, which keeps the history. */}
            <div className="border-danger/40 bg-danger/10 flex gap-3 rounded-lg border p-4">
              <AlertTriangle className="text-danger mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="text-sm leading-relaxed">
                <p className="text-danger font-medium">
                  This also deletes their entire attendance history.
                </p>
                <p className="text-ink-2 mt-1">
                  Deleting {confirmingDelete.first_name} {confirmingDelete.last_name} removes every
                  check-in and check-out ever recorded for them. It cannot be undone.
                </p>
              </div>
            </div>

            <p className="text-ink-2 mt-4 text-sm leading-relaxed">
              If you only want to stop them appearing as present, set their status to{' '}
              <span className="text-ink font-medium">INACTIVE</span> instead — the record and its
              history stay.
            </p>

            {remove.error !== null && (
              <p
                role="alert"
                className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm"
              >
                {remove.error instanceof ApiError
                  ? describeApiError(remove.error)
                  : 'Could not delete.'}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button
                onClick={() => {
                  setConfirmingDelete(null)
                  remove.reset()
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setEditing(confirmingDelete)
                  setConfirmingDelete(null)
                }}
              >
                <UserPlus className="size-3.5" aria-hidden />
                Set to inactive instead
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(confirmingDelete)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete permanently'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Screen>
  )
}
