import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { AlertTriangle, Building2, Pencil, Plus, PowerOff, Settings2, Trash2 } from 'lucide-react'
import { createAgency, deleteAgency, fetchAgencies, updateAgency } from '@/api/endpoints/agencies'
import { ApiError, describeApiError } from '@/api/errors'
import type { Agency, AgencyCreate } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { AgencyForm } from './AgencyForm'
import { Screen } from './Screen'

/**
 * Agency administration - the branch offices everything else hangs off.
 *
 * This is the root of the data model. An employee, a user, a visitor and a
 * ticket all carry an agency_id, and the opening_time set here is what the
 * presence screen uses to decide whether someone arrived late. Nothing else
 * publishes that value.
 *
 * THE ROLES ARE NOT THE USUAL SPLIT, and the buttons follow them exactly:
 *
 *   read    ADMIN, MANAGER (a manager's list is scoped server-side to its own)
 *   create  ADMIN only
 *   edit    ADMIN, or a MANAGER on its own agency
 *   delete  ADMIN only
 *
 * So a manager can edit the branch they run but cannot create or destroy one.
 * Create and delete are hidden rather than shown-and-refused for a manager,
 * because those are ADMIN-only for every row - there is no case where a manager
 * clicking them succeeds. Edit stays visible for everyone who can see the row,
 * since a manager editing their own agency is exactly what the route allows.
 *
 * The screen is not offered to the other three roles at all - no nav item, and
 * the URL redirects (auth/access.ts). The refusal state below is the backstop
 * for a session whose role changed under it, not the normal way here.
 */

/** "08:30:00" reads as machine output; "08:30" is what a person wrote down. */
function clockOf(value: string | null): string {
  if (!value) return '—'
  const [h, m] = value.split(':')
  return h && m ? `${h}:${m}` : value
}

export default function Agencies() {
  const navigate = useNavigate()
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()

  const isAdmin = user?.role === 'ADMIN'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
  })

  const [editing, setEditing] = useState<Agency | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<Agency | null>(null)

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    save.reset()
  }

  const save = useMutation({
    mutationFn: (values: AgencyCreate & { is_active?: boolean }) =>
      editing ? updateAgency(editing.id, values) : createAgency(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agencies'] })
      closeForm()
    },
  })

  const remove = useMutation({
    mutationFn: (agency: Agency) => deleteAgency(agency.id),
    onSuccess: async () => {
      /* Everything downstream of an agency is now stale, and the cascade is
         wide: employees, visitors, tickets and every attendance record
         belonging to those employees are gone server-side. Invalidating only
         'agencies' would leave four screens confidently showing rows that no
         longer exist. */
      await queryClient.invalidateQueries({ queryKey: ['agencies'] })
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      await queryClient.invalidateQueries({ queryKey: ['attendance'] })
      await queryClient.invalidateQueries({ queryKey: ['visitors'] })
      await queryClient.invalidateQueries({ queryKey: ['tickets'] })
      setConfirmingDelete(null)
    },
  })

  const rows = useMemo(() => agencies.data ?? [], [agencies.data])
  const formOpen = creating || editing !== null

  return (
    <Screen
      title="Agencies"
      description="Branch offices, their hours, counters and zones."
      actions={
        isAdmin ? (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add agency
          </Button>
        ) : undefined
      }
    >
      <AsyncBoundary
        isPending={agencies.isPending}
        error={agencies.error}
        isEmpty={rows.length === 0}
        emptyMessage="No agencies yet. Create the first one to get started."
        /* GET /api/agencies is ADMIN and MANAGER only; AGENT, SECURITY and
           TECHNICIAN land here. */
        forbiddenMessage="Agencies are managed by administrators and managers. Ask an administrator if you need access."
        onRetry={() => void agencies.refetch()}
        skeletonRows={4}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {rows.map((agency) => (
            <Panel as="section" key={agency.id}>
              <PanelHeader
                action={
                  <div className="flex gap-2">
                    {/* Only an admin has more than one branch to move between,
                        so only an admin is offered the move. A manager is
                        already inside theirs and always was. */}
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant={scope.agencyId === agency.id ? 'primary' : 'ghost'}
                        onClick={() =>
                          scope.agencyId === agency.id
                            ? scope.leave()
                            : scope.enter({ id: agency.id, name: agency.name })
                        }
                      >
                        {scope.agencyId === agency.id ? 'Leave' : 'Open'}
                      </Button>
                    )}
                    {/* The branch's own settings page: counters, door zones,
                        kiosk zone, weapon lockdown and the setup checklist
                        live only there, so it must stay reachable - "Open"
                        scopes the other screens but does not show these. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void navigate(`/agencies/${agency.id}`)}
                    >
                      <Settings2 className="size-3.5" aria-hidden />
                      Settings
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(agency)}
                      aria-label={`Edit ${agency.name}`}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingDelete(agency)}
                        aria-label={`Delete ${agency.name}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    )}
                  </div>
                }
              >
                <div className="flex items-center gap-2">
                  <Building2 className="text-ink-3 size-4 shrink-0" aria-hidden />
                  <h2 className="text-ink min-w-0 truncate text-sm font-semibold">{agency.name}</h2>
                  {!agency.is_active && <Badge tone="neutral">Inactive</Badge>}
                </div>
                <p className="text-ink-3 mt-1 truncate text-xs">
                  {agency.address ?? 'No address set'}
                </p>
              </PanelHeader>

              <PanelBody>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <Stat label="Opens" value={clockOf(agency.opening_time)} />
                  <Stat label="Closes" value={clockOf(agency.closing_time)} />
                  <Stat label="Employees" value={String(agency.employees_count)} />
                  <Stat label="Counters" value={String(agency.counters.length)} />
                </dl>

                {/* Counters are listed rather than counted alone, because
                    whether one is open is what decides if a ticket can be
                    called to it - and a closed counter is a 409 the visitor
                    queue has to explain. */}
                {agency.counters.length > 0 && (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {agency.counters.map((counter) => (
                      <li key={counter.id}>
                        <Badge tone={counter.is_open ? 'ok' : 'neutral'}>
                          {counter.name ?? `Guichet ${counter.number}`}
                          {!counter.is_open && ' · closed'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}

                {agency.zones.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {agency.zones.map((zone) => (
                      <li key={zone.id}>
                        <Badge tone={zone.is_private ? 'warn' : 'info'}>
                          {zone.name}
                          {zone.is_private && ' · private'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelBody>
            </Panel>
          ))}
        </div>
      </AsyncBoundary>

      <Dialog
        open={formOpen}
        title={editing ? 'Edit agency' : 'Add agency'}
        description={
          editing ? undefined : 'Counters and zones can only be set while creating the agency.'
        }
        onClose={closeForm}
      >
        {formOpen && (
          <AgencyForm
            agency={editing}
            pending={save.isPending}
            error={save.error}
            onCancel={closeForm}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this agency?"
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <DeleteConfirmation
            agency={confirmingDelete}
            pending={remove.isPending}
            error={remove.error}
            onCancel={() => {
              setConfirmingDelete(null)
              remove.reset()
            }}
            onDeactivate={() => {
              setEditing(confirmingDelete)
              setConfirmingDelete(null)
            }}
            onConfirm={() => remove.mutate(confirmingDelete)}
          />
        )}
      </Dialog>
    </Screen>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-3 tracked text-[10px] font-medium">{label}</dt>
      <dd className="text-ink tabular mt-1 text-sm">{value}</dd>
    </div>
  )
}

/**
 * The most destructive confirmation in the application.
 *
 * It names counts rather than warning in the abstract. "This also deletes 10
 * employees" is a fact someone can check against what they believe they are
 * doing; "this cannot be undone" is a sentence people click past. The counts
 * are already on the agency record, so there is nothing to fetch.
 *
 * Deactivating is offered as the first real option because it is almost always
 * what was actually wanted - a branch that has closed still has a year of
 * attendance history that payroll and HR have every reason to keep.
 */
function DeleteConfirmation({
  agency,
  pending,
  error,
  onCancel,
  onDeactivate,
  onConfirm,
}: {
  agency: Agency
  pending: boolean
  error: unknown
  onCancel: () => void
  onDeactivate: () => void
  onConfirm: () => void
}) {
  const losses = [
    [agency.employees_count, 'employee', 'employees'],
    [agency.counters.length, 'counter', 'counters'],
    [agency.zones.length, 'zone', 'zones'],
    [agency.devices_count, 'device', 'devices'],
    [agency.cameras_count, 'camera', 'cameras'],
  ] as const

  const listed = losses
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)

  return (
    <div>
      <div className="border-danger/40 bg-danger/10 flex gap-3 rounded-lg border p-4">
        <AlertTriangle className="text-danger mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="text-sm leading-relaxed">
          <p className="text-danger font-medium">
            This deletes everything belonging to {agency.name}.
          </p>
          <p className="text-ink-2 mt-1">
            {listed.length > 0 ? (
              <>
                It removes <span className="text-ink font-medium">{listed.join(', ')}</span>, along
                with every visitor, ticket and alert recorded here — and every attendance record
                those employees ever had.
              </>
            ) : (
              <>
                It removes every visitor, ticket and alert recorded here. This agency currently has
                no employees, counters or devices.
              </>
            )}
          </p>
          <p className="text-ink-2 mt-1">It cannot be undone.</p>
        </div>
      </div>

      <p className="text-ink-2 mt-4 text-sm leading-relaxed">
        If the branch has simply closed, set it to{' '}
        <span className="text-ink font-medium">Inactive</span> instead — everything above is kept
        and the change can be reversed.
      </p>

      {error != null && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm"
        >
          {error instanceof ApiError ? describeApiError(error) : 'Could not delete.'}
        </p>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onDeactivate}>
          <PowerOff className="size-3.5" aria-hidden />
          Set to inactive instead
        </Button>
        <Button variant="danger" disabled={pending} onClick={onConfirm}>
          {pending ? 'Deleting…' : 'Delete permanently'}
        </Button>
      </div>
    </div>
  )
}
