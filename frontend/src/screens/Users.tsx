import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  createUser,
  deleteUser,
  fetchUsers,
  updateUser,
  updateUserAccess,
} from '@/api/endpoints/users'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchEmployees } from '@/api/endpoints/employees'
import { ApiError, describeApiError } from '@/api/errors'
import { type Role, type UserAccount, type UserCreate } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Avatar } from '@/components/ui/Avatar'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { UserForm } from './UserForm'
import { Screen } from './Screen'

/**
 * User account administration. ADMIN only - the entire /api/users router is,
 * so a MANAGER who can administer employees still gets a 403 here and sees the
 * refusal state rather than an error.
 *
 * An account is only a login. The person, their card and their attendance
 * history are the employee record, which is why employees come first and why
 * an account can exist with nothing linked to it.
 *
 * A ROLE IS NOT CHANGED HERE, on any row. It is chosen once, when the account
 * is created, and after that it is a fact the table reports rather than a
 * setting the table edits. Asked for on 2026-08-21; the admin-only version of
 * the same rule arrived a day earlier, after an admin demoted their own account
 * in the database trying to preview a manager's screens.
 *
 * ONE ADMIN DOES NOT ADMINISTER ANOTHER either: a peer admin's account cannot
 * be edited or deleted from this screen. What is left on their row is the fact
 * of it - name, email, and the Global badge.
 *
 * The agency IS still changed inline, and stays inline rather than moving into
 * the edit dialog, because PUT accepts no agency and the change has a side
 * effect the caller did not ask for: the linked employee moves with it. It goes
 * through PATCH /access, sending the role the account already has.
 *
 * Neither rule is derivable from the API, and both are stricter than it: the
 * backend will move any account to any role, and lets an admin edit or delete
 * any account except their own. This screen is what holds them.
 *
 * It also means the screen no longer uses what PR #75 added for issue #71 -
 * moving an admin to another role. The route is still the right one for the
 * agency half, because role and agency have to be validated as a pair.
 */

const ROLE_TONE: Record<Role, Tone> = {
  ADMIN: 'danger',
  MANAGER: 'info',
  SECURITY: 'warn',
  AGENT: 'neutral',
  TECHNICIAN: 'neutral',
}

/** Maps the refusals the two PATCH routes can produce. */
function inlineErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not apply that change.'
  if (error.status === 422) {
    return 'Rejected: an admin must have no agency, and every other role must have one.'
  }
  return describeApiError(error)
}

function deleteErrorMessage(error: unknown): string | null {
  if (error == null) return null
  if (!(error instanceof ApiError)) return 'Could not delete.'
  /* "Un ADMIN ne peut pas supprimer son propre compte" - the row's own button
     is disabled, so this is the backstop for a stale session, not the path. */
  if (error.status === 400) return 'You cannot delete your own account.'
  return describeApiError(error)
}

export default function Users() {
  const { user } = useSession()
  const isAdmin = user?.role === 'ADMIN'
  const scope = useScope()
  const queryClient = useQueryClient()

  const users = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => fetchUsers(signal),
  })

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
  })

  /* Only for the optional employee link in the create form. */
  const employees = useQuery({
    queryKey: ['employees'],
    queryFn: ({ signal }) => fetchEmployees(signal),
  })

  const [editing, setEditing] = useState<UserAccount | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<UserAccount | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] })

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    save.reset()
  }

  const save = useMutation({
    mutationFn: (values: UserCreate) => {
      if (!editing) return createUser(values)

      /* PUT accepts neither role nor agency, so they are dropped rather than
         sent and ignored. An empty password box means "leave it alone", which
         is an omitted key - sending "" would be a 422 on min_length=8. */
      return updateUser(editing.id, {
        full_name: values.full_name,
        email: values.email,
        ...(values.password === '' ? {} : { password: values.password }),
        employee_id: values.employee_id ?? null,
      })
    },
    onSuccess: async () => {
      await refresh()
      closeForm()
    },
  })

  /* One route for both controls. Each sends the pair it wants to end up with,
     which is exactly what /access validates. */
  const changeAccess = useMutation({
    mutationFn: ({ id, role, agencyId }: { id: string; role: Role; agencyId: string | null }) =>
      updateUserAccess(id, role, agencyId),
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: (account: UserAccount) => deleteUser(account.id),
    onSuccess: async () => {
      await refresh()
      setConfirmingDelete(null)
    },
  })

  /* Narrowed to the branch an admin has open, same as Employees and Devices
     (UX_AUDIT.md finding 2 - this screen used to be the one exception that
     ignored scope entirely, always showing every account from every agency).
     A global account (agency_id null - an ADMIN) stays visible regardless of
     which branch is open, since it isn't "in" any one of them to begin with. */
  const rows = useMemo(() => {
    const all = users.data ?? []
    if (scope.agencyId === null) return all
    return all.filter(
      (account) => account.agency_id === null || account.agency_id === scope.agencyId,
    )
  }, [users.data, scope.agencyId])

  const formOpen = creating || editing !== null
  const inlineError = inlineErrorMessage(changeAccess.error)

  return (
    <Screen
      title="User accounts"
      description="Who can sign in, what they may reach, and which employee they are."
      actions={
        /* Hidden for anyone else, the way Agencies hides create and delete.
           POST /api/users is ADMIN-only like the rest of the router, so a
           manager reaching this screen meets the refusal state below - and an
           Add button sitting above that refusal is an offer the API will not
           honour, on the one screen where the boundary is the whole point. */
        isAdmin ? (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add account
          </Button>
        ) : undefined
      }
    >
      <AsyncBoundary
        isPending={users.isPending}
        error={users.error}
        isEmpty={rows.length === 0}
        emptyMessage="No accounts yet."
        forbiddenMessage="User accounts are managed by administrators only. Ask an administrator if you need access."
        onRetry={() => void users.refetch()}
        skeletonRows={6}
      >
        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-ink text-sm font-semibold">All accounts</h2>
              <span className="text-ink-3 tabular text-xs">
                {rows.length} {rows.length === 1 ? 'account' : 'accounts'}
              </span>
            </div>
          </PanelHeader>

          {inlineError && (
            <div className="border-line border-b px-6 py-3">
              <p role="alert" className="text-warn text-sm">
                {inlineError}
              </p>
            </div>
          )}

          <PanelBody flush>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  User accounts, with their role, agency and linked employee
                </caption>
                <thead>
                  <tr className="text-ink-3 tracked border-line/70 border-b text-left text-[10px] font-medium">
                    <th scope="col" className="px-6 py-3 font-medium">
                      Account
                    </th>
                    <th scope="col" className="px-6 py-3 font-medium">
                      Role
                    </th>
                    <th scope="col" className="px-6 py-3 font-medium">
                      Agency
                    </th>
                    <th scope="col" className="px-6 py-3 font-medium">
                      Employee
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((account) => {
                    const isSelf = account.id === user?.id
                    /* An admin has no agency by definition, so there is no
                       agency to pick from here - the role control moves them,
                       and asks for a branch on the way out. */
                    const isAdminRow = account.role === 'ADMIN'

                    return (
                      <tr
                        key={account.id}
                        className="border-line/70 hover:bg-panel-2/60 ease-soft border-b transition-colors duration-150 last:border-b-0"
                      >
                        <th scope="row" className="px-6 py-3 text-left font-normal">
                          <div className="flex items-center gap-3">
                            <Avatar name={account.full_name} />
                            <div className="min-w-0">
                              <div className="text-ink flex items-center gap-2 truncate font-medium">
                                {account.full_name}
                                {isSelf && (
                                  <span className="text-ink-3 text-xs font-normal">(you)</span>
                                )}
                              </div>
                              <div className="text-ink-3 truncate text-xs">{account.email}</div>
                            </div>
                          </div>
                        </th>

                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            {/* Read-only. Roles are set when an account is
                                created and are not edited here at all, so this
                                is a fact about the account rather than a
                                control - no dropdown, and nothing disabled that
                                somebody will keep clicking. */}
                            <span className="text-ink text-xs font-medium">{account.role}</span>
                            {/* Colour alone would not carry this, and ADMIN is
                                the one role worth spotting at a glance. */}
                            {isAdminRow && <Badge tone={ROLE_TONE.ADMIN}>Global</Badge>}
                          </div>
                        </td>

                        <td className="px-6 py-3">
                          {isAdminRow ? (
                            /* Not a disabled control: an admin has no agency to
                               show, and offering one would suggest a value could
                               be set here. Changing the role is what moves them. */
                            <span
                              className="text-ink-3 text-xs"
                              title="An admin is global. Change the role to place them in a branch."
                            >
                              No branch
                            </span>
                          ) : (
                            <select
                              aria-label={`Agency for ${account.full_name}`}
                              className="border-line-control bg-panel-2 text-ink rounded-lg border px-2 py-1 text-xs"
                              value={account.agency_id ?? ''}
                              disabled={changeAccess.isPending}
                              /* Role stays as it is; only the agency half moves. */
                              onChange={(e) =>
                                changeAccess.mutate({
                                  id: account.id,
                                  role: account.role,
                                  agencyId: e.target.value === '' ? null : e.target.value,
                                })
                              }
                            >
                              {(agencies.data ?? []).map((agency) => (
                                <option key={agency.id} value={agency.id}>
                                  {agency.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>

                        <td className="text-ink-2 px-6 py-3">
                          {account.employee ? (
                            <span>
                              {account.employee.first_name} {account.employee.last_name}
                            </span>
                          ) : (
                            <span className="text-ink-3" title="This login is not tied to a person">
                              Not linked
                            </span>
                          )}
                        </td>

                        <td className="px-6 py-3">
                          <div className="flex justify-end gap-2">
                            {/* One admin does not administer another. Their own
                                row keeps Edit - a name, an email and a password
                                are yours to change - and every other control on
                                an admin row is gone: no role, no branch, no
                                edit, no delete. Asked for on 2026-08-20, and
                                stricter than the API, which lets an admin edit
                                and delete any account but their own. */}
                            {(!isAdminRow || isSelf) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditing(account)}
                                aria-label={`Edit ${account.full_name}`}
                              >
                                <Pencil className="size-3.5" aria-hidden />
                              </Button>
                            )}
                            {/* Hidden for another admin, disabled for yourself.
                                The difference is deliberate: deleting yourself
                                is a thing you might reasonably try, and the
                                disabled control with its reason answers it -
                                where deleting a peer admin is not on offer at
                                all. */}
                            {isAdminRow && !isSelf ? null : (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={isSelf}
                                title={isSelf ? 'You cannot delete your own account' : undefined}
                                onClick={() => setConfirmingDelete(account)}
                                aria-label={`Delete ${account.full_name}`}
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                              </Button>
                            )}
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
        title={editing ? 'Edit account' : 'Add account'}
        description={
          editing
            ? 'Role and agency are changed from the table, one at a time.'
            : 'An account is a login. Link it to an employee to connect it to a card.'
        }
        onClose={closeForm}
      >
        {formOpen && (
          <UserForm
            user={editing}
            agencies={agencies.data ?? []}
            employees={employees.data ?? []}
            pending={save.isPending}
            error={save.error}
            onCancel={closeForm}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this account?"
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <div>
            {/* Unlike an employee, this destroys no history. Saying so is the
                point: the two confirmations look alike and mean very different
                things, and overstating this one teaches people to click past
                the one that matters. */}
            <div className="border-line bg-panel-2 flex gap-3 rounded-lg border p-4">
              <AlertTriangle className="text-ink-3 mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="text-sm leading-relaxed">
                <p className="text-ink font-medium">
                  {confirmingDelete.full_name} will no longer be able to sign in.
                </p>
                <p className="text-ink-2 mt-1">
                  {confirmingDelete.employee
                    ? `Their employee record (${confirmingDelete.employee.first_name} ${confirmingDelete.employee.last_name}) and its attendance history are not touched, and their card keeps working.`
                    : 'No employee record is linked, so nothing else changes.'}
                </p>
              </div>
            </div>

            {remove.error !== null && (
              <p
                role="alert"
                className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm"
              >
                {deleteErrorMessage(remove.error)}
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
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(confirmingDelete)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete account'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Screen>
  )
}
