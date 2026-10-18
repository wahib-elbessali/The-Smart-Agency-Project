import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, Link2, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  assignCounterService,
  createService,
  deleteService,
  fetchServices,
  updateService,
} from '@/api/endpoints/services'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { ApiError, describeApiError } from '@/api/errors'
import type { Service } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { ServiceForm, type ServiceFormValues } from './ServiceForm'
import { Screen } from './Screen'

/**
 * Service administration - what a visitor's ticket is for, and which counters
 * are assigned to serve it. Added alongside the contract update that made
 * POST /api/tickets require `service_id` (contracts/api.md §3, 2026-08-27).
 *
 * READ is ADMIN, MANAGER, AGENT. WRITE (create/edit/delete, and assigning a
 * counter) is ADMIN, MANAGER only - AGENT sees the list the ticket form also
 * reads from, with no buttons to act on it.
 *
 * Services have no "every agency" list route - only GET
 * /api/agencies/{id}/services. A MANAGER and an AGENT only ever have one
 * agency to ask about; an ADMIN has to pick one, the same way the visitor form
 * makes an ADMIN pick a branch before it can offer a service.
 */

export default function Services() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const canWrite = isAdmin || user?.role === 'MANAGER'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  /* The branch an admin has open, same shared scope every other screen reads
     (UX_AUDIT.md finding 2) - picking one here calls scope.enter() below, so
     leaving for Employees or Devices keeps the same branch instead of
     resetting it. Falls back to the first branch once the list arrives, only
     until the admin has actually chosen one. Everyone else has exactly one
     agency and never sees the picker at all. */
  const agencyId = isAdmin
    ? (scope.agencyId ?? agencies.data?.[0]?.id ?? null)
    : (user?.agency_id ?? null)

  const services = useQuery({
    queryKey: ['services', agencyId],
    queryFn: ({ signal }) => fetchServices(agencyId as string, signal),
    enabled: agencyId !== null,
  })

  const currentAgency = useMemo(
    () => agencies.data?.find((a) => a.id === agencyId) ?? null,
    [agencies.data, agencyId],
  )
  /* The counters this service could be assigned to - from the agency object
     already on hand, not a second fetch of GET /api/services/{id}/points per
     row. */
  const counters = currentAgency?.counters ?? []

  const [editing, setEditing] = useState<Service | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<Service | null>(null)
  const [managingCounters, setManagingCounters] = useState<Service | null>(null)

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    save.reset()
  }

  const save = useMutation({
    mutationFn: (values: ServiceFormValues) =>
      editing ? updateService(editing.id, values) : createService(agencyId as string, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['services', agencyId] })
      closeForm()
    },
  })

  const remove = useMutation({
    mutationFn: (service: Service) => deleteService(service.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['services', agencyId] })
      setConfirmingDelete(null)
    },
  })

  const assign = useMutation({
    mutationFn: ({ counterId, serviceId }: { counterId: string; serviceId: string | null }) =>
      assignCounterService(counterId, { service_id: serviceId }),
    onSuccess: async () => {
      /* Counters are nested on the agency object, not a service - so the
         thing that just went stale is the agency list, not the service one. */
      await queryClient.invalidateQueries({ queryKey: ['agencies'] })
    },
  })

  const rows = services.data ?? []
  const formOpen = creating || editing !== null

  return (
    <Screen
      title="Services"
      description="What a visitor's ticket is for, and which counters serve it."
      actions={
        canWrite && agencyId ? (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add service
          </Button>
        ) : undefined
      }
    >
      {isAdmin && (
        <div className="mb-4 max-w-xs">
          <label
            htmlFor="services_agency"
            className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
          >
            Branch
          </label>
          <select
            id="services_agency"
            className={controlClass()}
            value={agencyId ?? ''}
            onChange={(e) => {
              const agency = (agencies.data ?? []).find((a) => a.id === e.target.value)
              if (agency) scope.enter(agency)
            }}
          >
            {(agencies.data ?? []).map((agency) => (
              <option key={agency.id} value={agency.id}>
                {agency.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <AsyncBoundary
        isPending={services.isPending}
        error={services.error}
        isEmpty={rows.length === 0}
        emptyMessage="No services yet for this branch. Add the first one to get started."
        forbiddenMessage="Services are managed by administrators and managers, and readable by agents. Ask an administrator if you need access."
        onRetry={() => void services.refetch()}
        skeletonRows={4}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {rows.map((service) => {
            const assignedCount = counters.filter((c) => c.service_id === service.id).length
            return (
              <Panel as="section" key={service.id}>
                <PanelHeader
                  action={
                    canWrite && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setManagingCounters(service)}
                          aria-label={`Manage counters for ${service.name}`}
                        >
                          <Link2 className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(service)}
                          aria-label={`Edit ${service.name}`}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmingDelete(service)}
                          aria-label={`Delete ${service.name}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    )
                  }
                >
                  <div className="flex items-center gap-2">
                    <Layers className="text-ink-3 size-4 shrink-0" aria-hidden />
                    <h2 className="text-ink truncate text-sm font-semibold">{service.name}</h2>
                    <Badge tone="neutral">{service.code}</Badge>
                    {!service.is_active && <Badge tone="neutral">Inactive</Badge>}
                  </div>
                  <p className="text-ink-3 mt-1 truncate text-xs">
                    {service.description ?? 'No description'}
                  </p>
                </PanelHeader>
                <PanelBody>
                  <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
                    <Stat label="Point type" value={service.point_type} />
                    <Stat label="Min. points" value={String(service.min_points)} />
                    <Stat
                      label="Assigned"
                      value={`${assignedCount} ${assignedCount === 1 ? 'point' : 'points'}`}
                    />
                  </dl>
                </PanelBody>
              </Panel>
            )
          })}
        </div>
      </AsyncBoundary>

      <Dialog open={formOpen} title={editing ? 'Edit service' : 'Add service'} onClose={closeForm}>
        {formOpen && (
          <ServiceForm
            service={editing}
            pending={save.isPending}
            error={save.error}
            onCancel={closeForm}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this service?"
        description="Refused while a counter or a ticket still references it."
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <div>
            <p className="text-ink-2 text-sm leading-relaxed">
              Deleting <span className="text-ink font-medium">{confirmingDelete.name}</span> cannot
              be undone. If counters are still assigned to it, or tickets still reference it, the
              server refuses the request rather than orphaning them.
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
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(confirmingDelete)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={managingCounters !== null}
        title={managingCounters ? `Counters for ${managingCounters.name}` : ''}
        description="Assigning a counter here also sets its point type to match this service."
        onClose={() => setManagingCounters(null)}
      >
        {managingCounters && (
          <div className="space-y-2">
            {counters.length === 0 && (
              <p className="text-ink-2 text-sm">This branch has no counters configured.</p>
            )}
            {counters.map((counter) => {
              const isAssignedHere = counter.service_id === managingCounters.id
              const isAssignedElsewhere = counter.service_id !== null && !isAssignedHere
              return (
                <div
                  key={counter.id}
                  className="border-line flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-ink text-sm font-medium">
                      {counter.name ?? `Counter ${counter.number}`}
                    </p>
                    <p className="text-ink-3 text-xs">
                      {counter.point_type}
                      {isAssignedElsewhere && ' · assigned to another service'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={isAssignedHere ? 'primary' : 'secondary'}
                    disabled={assign.isPending}
                    onClick={() =>
                      assign.mutate({
                        counterId: counter.id,
                        serviceId: isAssignedHere ? null : managingCounters.id,
                      })
                    }
                  >
                    {isAssignedHere ? 'Assigned' : 'Assign'}
                  </Button>
                </div>
              )
            })}
            {assign.error !== null && (
              <p
                role="alert"
                className="border-warn/30 bg-warn/8 text-warn rounded-lg border p-3 text-sm"
              >
                {assign.error instanceof ApiError
                  ? describeApiError(assign.error)
                  : 'Could not update this assignment.'}
              </p>
            )}
          </div>
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
