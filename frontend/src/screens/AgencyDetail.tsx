import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ArrowLeft,
  Building2,
  Cpu,
  DoorClosed,
  IdCard,
  Layers,
  MonitorCheck,
  Pencil,
  Plus,
  ScanFace,
  Timer,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { fetchAgencies, fetchAgency, updateAgency } from '@/api/endpoints/agencies'
import {
  createCounter,
  deleteCounter,
  fetchCounters,
  updateCounter,
} from '@/api/endpoints/counters'
import {
  createAccessZone,
  deleteAccessZone,
  fetchAccessZones,
  updateAccessZone,
} from '@/api/endpoints/accessZones'
import { fetchCameras } from '@/api/endpoints/cameras'
import { fetchDevices } from '@/api/endpoints/devices'
import { fetchZones } from '@/api/endpoints/zones'
import { fetchEmployees } from '@/api/endpoints/employees'
import { fetchServices } from '@/api/endpoints/services'
import { ApiError, describeApiError } from '@/api/errors'
import type {
  Agency,
  Camera,
  Counter,
  DeviceStatus,
  EmployeeStatus,
  Zone,
  ZoneAccessMode,
} from '@/api/types'
import { useScope, withinScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { Screen } from './Screen'
import { SetupChecklist } from './SetupChecklist'

/**
 * One agency, everything about it in one place - what "press an agency, see
 * everything related to it (services, guichets...), switch to another and
 * check everything" asked for (2026-08-30). Reads ADMIN, MANAGER, same as
 * /agencies itself: auth/access.ts inherits the parent route's rule for any
 * nested path, since this is the same data one level deeper.
 *
 * Visiting this page also opens the branch in ScopeContext, the same effect
 * clicking "Open" on the Agencies list has - so Employees, Services and
 * Devices are already narrowed to it if the admin goes there next. There is
 * no separate "Open" button here because arriving at this screen already
 * means the branch is the thing being looked at.
 */

const EMPLOYEE_STATUS_TONE: Record<EmployeeStatus, Tone> = {
  ACTIVE: 'ok',
  INACTIVE: 'neutral',
  ON_LEAVE: 'warn',
}

const DEVICE_STATUS_TONE: Record<DeviceStatus, Tone> = {
  ONLINE: 'ok',
  OFFLINE: 'neutral',
  ERROR: 'danger',
  MAINTENANCE: 'warn',
}

function clockOf(value: string | null): string {
  if (!value) return '—'
  const [h, m] = value.split(':')
  return h && m ? `${h}:${m}` : value
}

export default function AgencyDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useSession()
  const scope = useScope()
  const isAdmin = user?.role === 'ADMIN'
  const canWrite = isAdmin || user?.role === 'MANAGER'

  const agency = useQuery({
    queryKey: ['agencies', id],
    queryFn: ({ signal }) => fetchAgency(id, signal),
  })

  /* Only an admin has more than one branch to switch between. */
  const allAgencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  const services = useQuery({
    queryKey: ['services', id],
    queryFn: ({ signal }) => fetchServices(id, signal),
    enabled: agency.isSuccess,
  })

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: ({ signal }) => fetchDevices(signal),
  })

  const employees = useQuery({
    queryKey: ['employees'],
    queryFn: ({ signal }) => fetchEmployees(signal),
  })

  const agencyDevices = useMemo(() => withinScope(devices.data ?? [], id), [devices.data, id])
  const agencyEmployees = useMemo(() => withinScope(employees.data ?? [], id), [employees.data, id])

  const agencyId = agency.data?.id
  const agencyName = agency.data?.name
  /* Same effect as pressing "Open" on the Agencies list - see the module
     comment. Re-runs if the id changes, i.e. switching branches from the
     picker below without leaving this screen.

     THE GUARD IS LOAD-BEARING, not a micro-optimisation: scope.enter() sets
     state in ScopeProvider, which rebuilds `scope` as a new object on every
     call. That makes `scope` itself an unstable dependency - satisfying it
     honestly (rather than just naming scope.enter, which the linter does not
     accept as sufficient) means this effect re-runs every time scope changes,
     and scope changes every time this effect runs. Without the guard that is
     an infinite render loop, not a lint nitpick; the check below is what
     breaks the cycle once the scope already matches this branch. */
  useEffect(() => {
    if (agencyId && agencyName && scope.agencyId !== agencyId) {
      scope.enter({ id: agencyId, name: agencyName })
    }
  }, [agencyId, agencyName, scope])

  return (
    <Screen
      title={agency.data?.name ?? 'Branch'}
      description="Everything at this branch: hours, counters, services, employees and devices."
      actions={
        <Link to="/agencies">
          <Button size="sm">
            <ArrowLeft className="size-3.5" aria-hidden />
            All agencies
          </Button>
        </Link>
      }
    >
      <AsyncBoundary
        isPending={agency.isPending}
        error={agency.error}
        forbiddenMessage="Agencies are managed by administrators and managers. Ask an administrator if you need access."
        onRetry={() => void agency.refetch()}
        skeletonRows={5}
      >
        {agency.data && (
          <div className="space-y-4">
            {isAdmin && (allAgencies.data?.length ?? 0) > 1 && (
              <div className="max-w-xs">
                <label
                  htmlFor="agency_switch"
                  className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
                >
                  Switch branch
                </label>
                <select
                  id="agency_switch"
                  className={controlClass()}
                  value={agency.data.id}
                  onChange={(e) => void navigate(`/agencies/${e.target.value}`)}
                >
                  {(allAgencies.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Panel as="section">
              <PanelHeader>
                <div className="flex items-center gap-2">
                  <Building2 className="text-ink-3 size-4 shrink-0" aria-hidden />
                  <h2 className="text-ink text-sm font-semibold">{agency.data.name}</h2>
                  {!agency.data.is_active && <Badge tone="neutral">Inactive</Badge>}
                </div>
                <p className="text-ink-3 mt-1 text-xs">{agency.data.address ?? 'No address set'}</p>
              </PanelHeader>
              <PanelBody>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <Stat label="Opens" value={clockOf(agency.data.opening_time)} />
                  <Stat label="Closes" value={clockOf(agency.data.closing_time)} />
                  <Stat label="Employees" value={String(agency.data.employees_count)} />
                  <Stat label="Counters" value={String(agency.data.counters.length)} />
                </dl>
              </PanelBody>
            </Panel>

            <SetupChecklist agencyId={id} />

            <CountersPanel agencyId={id} canWrite={canWrite} />

            <AccessZonesPanel agencyId={id} canWrite={canWrite} />

            <KioskZonePanel
              agencyId={id}
              current={agency.data.kiosk_zone_name}
              faceCameraId={agency.data.kiosk_face_camera_id ?? null}
              canWrite={canWrite}
            />

            <QueueWarningsPanel
              key={`${agency.data.id}-${agency.data.queue_depth_warning}-${agency.data.oldest_wait_warning_seconds}`}
              agencyId={id}
              agency={agency.data}
              canWrite={canWrite}
            />

            <WeaponLockdownPanel
              agencyId={id}
              enabled={agency.data.weapon_lockdown_enabled}
              canWrite={canWrite}
            />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <SectionPanel
                icon={<Layers className="text-ink-3 size-4 shrink-0" aria-hidden />}
                title="Services"
                count={services.data?.length}
                manageHref="/services"
                manageLabel="Manage services"
                isPending={services.isPending}
                error={services.error}
                emptyMessage="No services configured yet."
              >
                {services.data?.map((service) => (
                  <li
                    key={service.id}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="text-ink truncate">{service.name}</span>
                    <div className="flex shrink-0 gap-2">
                      <Badge tone="neutral">{service.code}</Badge>
                      {!service.is_active && <Badge tone="neutral">Inactive</Badge>}
                    </div>
                  </li>
                ))}
              </SectionPanel>

              <SectionPanel
                icon={<IdCard className="text-ink-3 size-4 shrink-0" aria-hidden />}
                title="Employees"
                count={agencyEmployees.length}
                manageHref="/employees"
                manageLabel="Manage employees"
                isPending={employees.isPending}
                error={employees.error}
                emptyMessage="No employees at this branch yet."
              >
                {agencyEmployees.map((employee) => (
                  <li
                    key={employee.id}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="text-ink truncate">
                      {employee.first_name} {employee.last_name}
                    </span>
                    <Badge tone={EMPLOYEE_STATUS_TONE[employee.status] ?? 'neutral'}>
                      {employee.status}
                    </Badge>
                  </li>
                ))}
              </SectionPanel>

              <SectionPanel
                icon={<Cpu className="text-ink-3 size-4 shrink-0" aria-hidden />}
                title="Devices"
                count={agencyDevices.length}
                manageHref="/devices"
                manageLabel="Manage devices"
                isPending={devices.isPending}
                error={devices.error}
                emptyMessage="No devices registered at this branch yet."
              >
                {agencyDevices.map((device) => (
                  <li
                    key={device.id}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="text-ink truncate">{device.name}</span>
                    <Badge tone={DEVICE_STATUS_TONE[device.status]}>{device.status}</Badge>
                  </li>
                ))}
              </SectionPanel>
            </div>
          </div>
        )}
      </AsyncBoundary>
    </Screen>
  )
}

/**
 * The one autonomous action this system can take on its own (scenario-planning
 * backlog, Phase H). Off by default: a weapon alert then only notifies people.
 * On: once a weapon is still there 4 seconds after first being seen - a single frame can be a
 * pistol/smartphone flicker - every door device (type DOOR or ACCESS_SENSORS) in this branch is
 * sent a lock command. Unlocking is always manual, from Manual controls.
 *
 * The warning below is deliberate, not boilerplate: locking doors during an
 * emergency can conflict with fire-egress rules, which this software cannot
 * judge - that call belongs to whoever is responsible for the building.
 */
function WeaponLockdownPanel({
  agencyId,
  enabled,
  canWrite,
}: {
  agencyId: string
  enabled: boolean
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (next: boolean) => updateAgency(agencyId, { weapon_lockdown_enabled: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agencies'] })
    },
  })

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Weapon lockdown</h2>
          <Badge tone={enabled ? 'warn' : 'neutral'}>{enabled ? 'Automatic' : 'Notify only'}</Badge>
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-wrap items-center gap-3">
        <p className="text-ink-2 min-w-0 flex-1 text-sm leading-relaxed">
          {enabled
            ? 'A weapon still in view 4 seconds after it is first seen locks every door device at this branch automatically. Never while a fire or gas alert is open, and doors are not re-locked automatically afterwards. Unlock or re-lock from Manual controls.'
            : 'A weapon alert only notifies people. Turn this on to also lock every door device automatically.'}{' '}
          <span className="text-ink-3 text-xs">
            Locking doors in an emergency can conflict with fire-egress rules - confirm that with
            whoever is responsible for the building before enabling.
          </span>
        </p>
        {canWrite && (
          <Button
            size="sm"
            variant={enabled ? 'secondary' : 'primary'}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!enabled)}
          >
            {enabled ? 'Switch to notify only' : 'Enable automatic lockdown'}
          </Button>
        )}
      </PanelBody>
      {toggle.isError && (
        <PanelBody>
          <p className="text-bad text-xs" role="alert">
            {toggle.error instanceof ApiError
              ? describeApiError(toggle.error)
              : 'Could not change this setting.'}
          </p>
        </PanelBody>
      )}
    </Panel>
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
 * One consolidated section - services, employees or devices. Each reads its
 * own query independently (isPending/error are already scoped to this
 * section rather than the whole page) so one slow or refused list does not
 * block the other two from rendering.
 */
function SectionPanel({
  icon,
  title,
  count,
  manageHref,
  manageLabel,
  isPending,
  error,
  emptyMessage,
  children,
}: {
  icon: ReactNode
  title: string
  count: number | undefined
  manageHref: string
  manageLabel: string
  isPending: boolean
  error: unknown
  emptyMessage: string
  children: React.ReactNode
}) {
  const isEmpty = !isPending && !error && (count ?? 0) === 0

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {icon}
            <h2 className="text-ink text-sm font-semibold">{title}</h2>
          </div>
          {count !== undefined && <span className="text-ink-3 tabular text-xs">{count}</span>}
        </div>
      </PanelHeader>
      <PanelBody>
        {isPending ? (
          <p className="text-ink-3 text-sm">Loading…</p>
        ) : error ? (
          <p className="text-warn text-sm">Could not load {title.toLowerCase()}.</p>
        ) : isEmpty ? (
          <p className="text-ink-3 text-sm">{emptyMessage}</p>
        ) : (
          <ul className="divide-line/70 -my-2 divide-y">{children}</ul>
        )}

        <Link to={manageHref} className="mt-3 inline-block">
          <Button size="sm">{manageLabel}</Button>
        </Link>
      </PanelBody>
    </Panel>
  )
}

/**
 * Counters (guichets/bureaux), full CRUD - UX_AUDIT.md finding 4. Lives on
 * this screen rather than getting its own nav item: a counter has no
 * identity apart from the branch it belongs to, the same reasoning that
 * keeps Services and Employees summarised here too, except a counter had no
 * "Manage" screen to link out to at all until this was written.
 */
function CountersPanel({ agencyId, canWrite }: { agencyId: string; canWrite: boolean }) {
  const queryClient = useQueryClient()

  const counters = useQuery({
    queryKey: ['counters', agencyId],
    queryFn: ({ signal }) => fetchCounters(agencyId, signal),
  })

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Counter | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<Counter | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['counters', agencyId] })

  const create = useMutation({
    mutationFn: (values: { number: number; name: string }) =>
      createCounter(agencyId, { number: values.number, name: values.name || null }),
    onSuccess: async () => {
      await refresh()
      setAdding(false)
    },
  })

  const cameras = useQuery({
    queryKey: ['cameras', agencyId],
    queryFn: ({ signal }) => fetchCameras(agencyId, signal),
  })

  const update = useMutation({
    mutationFn: ({
      id,
      name,
      isOpen,
      emotionCameraId,
    }: {
      id: string
      name?: string | null
      isOpen?: boolean
      emotionCameraId?: string | null
    }) =>
      updateCounter(id, {
        ...(name !== undefined && { name }),
        ...(isOpen !== undefined && { is_open: isOpen }),
        ...(emotionCameraId !== undefined && { emotion_camera_id: emotionCameraId }),
      }),
    onSuccess: async () => {
      await refresh()
      setEditing(null)
    },
  })

  const remove = useMutation({
    mutationFn: (counter: Counter) => deleteCounter(counter.id),
    onSuccess: async () => {
      await refresh()
      setConfirmingDelete(null)
    },
  })

  const rows = counters.data ?? []

  return (
    <Panel as="section">
      <PanelHeader
        action={
          canWrite && (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden />
              Add counter
            </Button>
          )
        }
      >
        <div className="flex items-center gap-2.5">
          <MonitorCheck className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Counters</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs">
          Guichets and bureaux at this branch - add, rename, open or close them here.
        </p>
      </PanelHeader>
      <PanelBody>
        {counters.isPending ? (
          <p className="text-ink-3 text-sm">Loading…</p>
        ) : counters.error ? (
          <p className="text-warn text-sm">Could not load counters.</p>
        ) : rows.length === 0 ? (
          <p className="text-ink-3 text-sm">No counters at this branch yet.</p>
        ) : (
          <ul className="divide-line/70 -my-1.5 divide-y">
            {rows.map((counter) => {
              const label = counter.name ?? `Guichet ${counter.number}`
              return (
                <li key={counter.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge tone={counter.is_open ? 'ok' : 'neutral'}>
                      {counter.is_open ? 'Open' : 'Closed'}
                    </Badge>
                    <span className="text-ink truncate text-sm">{label}</span>
                    <span className="text-ink-3 tabular text-xs">#{counter.number}</span>
                  </div>
                  {canWrite && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: counter.id, isOpen: !counter.is_open })}
                      >
                        {counter.is_open ? 'Close' : 'Open'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(counter)}
                        aria-label={`Edit ${label}`}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingDelete(counter)}
                        aria-label={`Delete ${label}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </PanelBody>

      <Dialog
        open={adding}
        title="Add counter"
        onClose={() => {
          setAdding(false)
          create.reset()
        }}
      >
        {adding && (
          <CounterAddForm
            takenNumbers={new Set(rows.map((c) => c.number))}
            pending={create.isPending}
            error={create.error}
            onCancel={() => {
              setAdding(false)
              create.reset()
            }}
            onSubmit={(values) => create.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={editing !== null}
        title="Edit counter"
        onClose={() => {
          setEditing(null)
          update.reset()
        }}
      >
        {editing && (
          <CounterRenameForm
            counter={editing}
            cameras={cameras.data ?? []}
            pending={update.isPending}
            error={update.error}
            onCancel={() => {
              setEditing(null)
              update.reset()
            }}
            onSubmit={(values) =>
              update.mutate({
                id: editing.id,
                name: values.name || null,
                emotionCameraId: values.emotionCameraId,
              })
            }
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this counter?"
        description="Tickets already served here keep their record - only the counter itself goes."
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <div>
            {remove.error !== null && (
              <p
                role="alert"
                className="border-warn/30 bg-warn/8 text-warn mb-4 rounded-lg border p-3 text-sm"
              >
                {remove.error instanceof ApiError
                  ? describeApiError(remove.error)
                  : 'Could not delete.'}
              </p>
            )}
            <div className="flex justify-end gap-2">
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
    </Panel>
  )
}

function CounterAddForm({
  takenNumbers,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  takenNumbers: Set<number>
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: { number: number; name: string }) => void
}) {
  const [number, setNumber] = useState('')
  const [name, setName] = useState('')
  const parsed = Number(number)
  const numberTaken = number.trim() !== '' && Number.isInteger(parsed) && takenNumbers.has(parsed)
  const invalid = number.trim() === '' || !Number.isInteger(parsed) || parsed < 1 || numberTaken

  function submit(event: FormEvent) {
    event.preventDefault()
    if (invalid) return
    onSubmit({ number: parsed, name: name.trim() })
  }

  const message = useMemo(() => {
    if (numberTaken) return 'That number is already used at this branch.'
    if (error == null) return null
    if (!(error instanceof ApiError)) return 'Could not add this counter.'
    return describeApiError(error)
  }, [error, numberTaken])

  return (
    <form onSubmit={submit}>
      <div className="space-y-4">
        <Field id="counter_number" label="Number" required>
          {(props) => (
            <input
              {...props}
              type="number"
              min={1}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field id="counter_name" label="Name" hint="Optional. Shown instead of the bare number.">
          {(props) => (
            <input
              {...props}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          )}
        </Field>
      </div>

      {message && (
        <p role="alert" className="text-warn mt-4 text-sm">
          {message}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || invalid}>
          {pending ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </form>
  )
}

function CounterRenameForm({
  counter,
  cameras,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  counter: Counter
  cameras: Camera[]
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: { name: string; emotionCameraId: string | null }) => void
}) {
  const [name, setName] = useState(counter.name ?? '')
  const [emotionCameraId, setEmotionCameraId] = useState(counter.emotion_camera_id ?? '')

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit({ name: name.trim(), emotionCameraId: emotionCameraId || null })
  }

  const message = useMemo(() => {
    if (error == null) return null
    if (!(error instanceof ApiError)) return 'Could not rename this counter.'
    return describeApiError(error)
  }, [error])

  return (
    <form onSubmit={submit}>
      <Field id="counter_rename" label="Name" hint="Blank falls back to showing the bare number.">
        {(props) => (
          <input
            {...props}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            autoFocus
          />
        )}
      </Field>

      {/* Before this, settable only through the API. A satisfaction reading
          counts toward this counter only if it comes from this camera. */}
      <div className="mt-4">
        <Field
          id="counter_emotion_camera"
          label="Satisfaction camera"
          hint="The camera facing visitors at this counter. Its readings count toward this counter's satisfaction."
        >
          {(props) => (
            <select
              {...props}
              value={emotionCameraId}
              onChange={(e) => setEmotionCameraId(e.target.value)}
            >
              <option value="">None</option>
              {cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {message && (
        <p role="alert" className="text-warn mt-4 text-sm">
          {message}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

/**
 * Door access zones - the rooms an RFID door reader guards. Same gap the
 * counters panel closed: a zone could only be written inside POST /agencies,
 * so a branch could never add a room afterwards, and the employee form had
 * nothing to grant access from. Who may enter each one is set per employee.
 */
function AccessZonesPanel({ agencyId, canWrite }: { agencyId: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const zones = useQuery({
    queryKey: ['access-zones', agencyId],
    queryFn: ({ signal }) => fetchAccessZones(agencyId, signal),
  })

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Zone | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<Zone | null>(null)

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['access-zones', agencyId] }),
      queryClient.invalidateQueries({ queryKey: ['agencies', agencyId] }),
      queryClient.invalidateQueries({ queryKey: ['employees'] }),
    ])

  const cameras = useQuery({
    queryKey: ['cameras', agencyId],
    queryFn: ({ signal }) => fetchCameras(agencyId, signal),
  })

  const save = useMutation({
    mutationFn: (values: AccessZoneValues) => {
      const body = {
        name: values.name,
        is_private: values.isPrivate,
        access_mode: values.accessMode,
        door_camera_id: values.doorCameraId,
      }
      return editing ? updateAccessZone(editing.id, body) : createAccessZone(agencyId, body)
    },
    onSuccess: async () => {
      await refresh()
      setAdding(false)
      setEditing(null)
    },
  })

  const remove = useMutation({
    mutationFn: (zone: Zone) => deleteAccessZone(zone.id),
    onSuccess: async () => {
      await refresh()
      setConfirmingDelete(null)
    },
  })

  const closeForm = () => {
    setAdding(false)
    setEditing(null)
    save.reset()
  }
  const rows = zones.data ?? []

  return (
    <Panel as="section">
      <PanelHeader
        action={
          canWrite && (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden />
              Add room
            </Button>
          )
        }
      >
        <div className="flex items-center gap-2.5">
          <DoorClosed className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Badge rooms</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs">
          Rooms with a badge reader on the door. Who may enter each one is set on the employee. (Not
          the camera zones drawn on the Zones screen.)
        </p>
      </PanelHeader>
      <PanelBody>
        {zones.isPending ? (
          <p className="text-ink-3 text-sm">Loading…</p>
        ) : zones.error ? (
          <p className="text-warn text-sm">Could not load badge rooms.</p>
        ) : rows.length === 0 ? (
          <p className="text-ink-3 text-sm">No badge rooms at this branch yet.</p>
        ) : (
          <ul className="divide-line/70 -my-1.5 divide-y">
            {rows.map((zone) => (
              <li key={zone.id} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-ink truncate text-sm">{zone.name}</span>
                  {zone.is_private && <Badge tone="warn">Private</Badge>}
                  {zone.access_mode === 'rfid_face' && <Badge tone="info">Badge + face</Badge>}
                </div>
                {canWrite && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(zone)}
                      aria-label={`Edit ${zone.name}`}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDelete(zone)}
                      aria-label={`Delete ${zone.name}`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </PanelBody>

      <Dialog
        open={adding || editing !== null}
        title={editing ? 'Edit badge room' : 'Add badge room'}
        onClose={closeForm}
      >
        {(adding || editing) && (
          <AccessZoneForm
            zone={editing}
            cameras={cameras.data ?? []}
            pending={save.isPending}
            error={save.error}
            onCancel={closeForm}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this badge room?"
        description="Every employee loses access to it, and a reader set to it stays locked."
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <div>
            {remove.error !== null && (
              <p
                role="alert"
                className="border-warn/30 bg-warn/8 text-warn mb-4 rounded-lg border p-3 text-sm"
              >
                {remove.error instanceof ApiError
                  ? describeApiError(remove.error)
                  : 'Could not delete.'}
              </p>
            )}
            <div className="flex justify-end gap-2">
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
    </Panel>
  )
}

interface AccessZoneValues {
  name: string
  isPrivate: boolean
  accessMode: ZoneAccessMode
  doorCameraId: string | null
}

function AccessZoneForm({
  zone,
  cameras,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  zone: Zone | null
  cameras: Camera[]
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: AccessZoneValues) => void
}) {
  const [name, setName] = useState(zone?.name ?? '')
  const [isPrivate, setIsPrivate] = useState(zone?.is_private ?? false)
  const [accessMode, setAccessMode] = useState<ZoneAccessMode>(zone?.access_mode ?? 'rfid')
  const [doorCameraId, setDoorCameraId] = useState(zone?.door_camera_id ?? '')
  const needsCamera = accessMode === 'rfid_face' && doorCameraId === ''
  const invalid = name.trim().length < 2 || needsCamera

  function submit(event: FormEvent) {
    event.preventDefault()
    if (invalid) return
    onSubmit({ name: name.trim(), isPrivate, accessMode, doorCameraId: doorCameraId || null })
  }

  const message = useMemo(() => {
    if (error == null) return null
    if (!(error instanceof ApiError)) return 'Could not save this badge room.'
    if (error.status === 409) return 'This branch already has a badge room with that name.'
    return describeApiError(error)
  }, [error])

  return (
    <form onSubmit={submit}>
      <div className="space-y-4">
        <Field
          id="access_zone_name"
          label="Name"
          required
          hint="At least 2 characters, e.g. Coffre or Bureau de direction."
        >
          {(props) => (
            <input
              {...props}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
          )}
        </Field>
        <label className="text-ink flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          Private (staff only)
        </label>
        <Field
          id="access_zone_mode"
          label="Opens with"
          hint="Badge + face: the door camera checks once, when the badge is tapped, that the face is the badge holder's."
        >
          {(props) => (
            <select
              {...props}
              value={accessMode}
              onChange={(e) => setAccessMode(e.target.value as ZoneAccessMode)}
            >
              <option value="rfid">Badge</option>
              <option value="rfid_face">Badge + face</option>
            </select>
          )}
        </Field>
        {accessMode === 'rfid_face' && (
          <Field
            id="access_zone_camera"
            label="Door camera"
            required
            error={needsCamera ? 'Pick the camera facing this door.' : undefined}
            hint="A camera at face height by the door. Untick its detections on Cameras so it only does this."
          >
            {(props) => (
              <select
                {...props}
                value={doorCameraId}
                onChange={(e) => setDoorCameraId(e.target.value)}
              >
                <option value="">Select a camera…</option>
                {cameras.map((camera) => (
                  <option key={camera.id} value={camera.id}>
                    {camera.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>

      {message && (
        <p role="alert" className="text-warn mt-4 text-sm">
          {message}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || invalid}>
          {pending ? 'Saving…' : zone ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  )
}

/**
 * Which camera zone is "standing at the kiosk". A ticket printed while
 * someone is tracked inside it gets linked to that person, and the kiosk
 * camera captures their face for returning-visitor recognition. Before this
 * panel the field could only be set through the API.
 */
function KioskZonePanel({
  agencyId,
  current,
  faceCameraId,
  canWrite,
}: {
  agencyId: string
  current: string | null
  faceCameraId: string | null
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: ({ signal }) => fetchZones(signal),
  })
  const cameras = useQuery({
    queryKey: ['cameras', agencyId],
    queryFn: ({ signal }) => fetchCameras(agencyId, signal),
  })

  /* An admin sees every branch's zones; keep the ones drawn on this
     branch's cameras (a world zone names its camera in converted_from). */
  const options = useMemo(() => {
    const ids = new Set((cameras.data ?? []).map((c) => c.id))
    const names = new Set((cameras.data ?? []).map((c) => c.name))
    return (zones.data ?? [])
      .filter(
        (z) =>
          (z.camera_id !== null && ids.has(z.camera_id)) ||
          (z.converted_from != null && names.has(z.converted_from.camera)),
      )
      .map((z) => z.name)
      .sort((a, b) => a.localeCompare(b))
  }, [zones.data, cameras.data])

  const save = useMutation({
    mutationFn: (name: string | null) => updateAgency(agencyId, { kiosk_zone_name: name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agencies', agencyId] }),
  })

  /* Which camera sees faces at the kiosk: the returning-visitor capture and
     the watchlist-to-ticket link use it. Unset falls back to the camera the
     kiosk zone was drawn on - often an overhead one that barely sees faces. */
  const saveFaceCamera = useMutation({
    mutationFn: (cameraId: string | null) =>
      updateAgency(agencyId, { kiosk_face_camera_id: cameraId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agencies', agencyId] }),
  })

  const missing = current !== null && zones.isSuccess && !options.includes(current)

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center gap-2.5">
          <ScanFace className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Kiosk camera zone</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs">
          The camera zone (drawn on the Zones screen) in front of the ticket kiosk, and the camera
          that sees visitors&apos; faces there. Tickets are linked to the person tracked in the
          zone; the face camera recognises returning visitors and watchlist matches at the kiosk.
        </p>
      </PanelHeader>
      <PanelBody className="flex flex-wrap items-center gap-3">
        {zones.isPending || cameras.isPending ? (
          <p className="text-ink-3 text-sm">Loading…</p>
        ) : zones.error || cameras.error ? (
          <p className="text-warn text-sm">Could not load this branch&apos;s camera zones.</p>
        ) : (
          <>
            <label htmlFor="kiosk_zone" className="sr-only">
              Kiosk zone
            </label>
            <select
              id="kiosk_zone"
              className={controlClass()}
              value={current ?? ''}
              disabled={!canWrite || save.isPending}
              onChange={(e) => save.mutate(e.target.value || null)}
            >
              <option value="">Not set</option>
              {missing && <option value={current}>{current} (zone no longer exists)</option>}
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {options.length === 0 && (
              <span className="text-ink-3 text-sm">
                Draw a zone around the kiosk on the{' '}
                <Link to="/zones" className="text-accent underline">
                  Zones
                </Link>{' '}
                screen first.
              </span>
            )}
            <label htmlFor="kiosk_face_camera" className="text-ink-3 ml-2 text-xs">
              Face camera
            </label>
            <select
              id="kiosk_face_camera"
              className={controlClass()}
              value={faceCameraId ?? ''}
              disabled={!canWrite || saveFaceCamera.isPending}
              onChange={(e) => saveFaceCamera.mutate(e.target.value || null)}
            >
              <option value="">The kiosk zone&apos;s camera</option>
              {(cameras.data ?? []).map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.name}
                </option>
              ))}
            </select>
            {(save.error !== null || saveFaceCamera.error !== null) && (
              <span role="alert" className="text-warn text-sm">
                Could not save.
              </span>
            )}
          </>
        )}
      </PanelBody>
    </Panel>
  )
}

/**
 * When a service's queue counts as busy (amber) or backed up (red), by how
 * many are waiting or how long the oldest has waited. The Visitor queue and
 * Insights screens read these; before this panel they could only be set
 * through the API. Blank turns that check off. Waits are edited in minutes
 * and stored in seconds.
 */
function QueueWarningsPanel({
  agencyId,
  agency,
  canWrite,
}: {
  agencyId: string
  agency: Agency
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const minutes = (seconds: number | null) => (seconds == null ? '' : String(seconds / 60))
  const [depthWarning, setDepthWarning] = useState(agency.queue_depth_warning?.toString() ?? '')
  const [depthCritical, setDepthCritical] = useState(agency.queue_depth_critical?.toString() ?? '')
  const [waitWarning, setWaitWarning] = useState(minutes(agency.oldest_wait_warning_seconds))
  const [waitCritical, setWaitCritical] = useState(minutes(agency.oldest_wait_critical_seconds))

  const whole = (value: string) => (value.trim() === '' ? null : Number(value))
  const values = {
    depthWarning: whole(depthWarning),
    depthCritical: whole(depthCritical),
    waitWarning: whole(waitWarning),
    waitCritical: whole(waitCritical),
  }
  const problem = (() => {
    for (const v of Object.values(values)) {
      if (v !== null && !(Number.isInteger(v) && v >= 1)) return 'Use whole numbers of 1 or more.'
    }
    if (values.depthWarning && values.depthCritical && values.depthCritical <= values.depthWarning)
      return 'The red waiting count must be higher than the amber one.'
    if (values.waitWarning && values.waitCritical && values.waitCritical <= values.waitWarning)
      return 'The red wait must be longer than the amber one.'
    return null
  })()

  const save = useMutation({
    mutationFn: () =>
      updateAgency(agencyId, {
        queue_depth_warning: values.depthWarning,
        queue_depth_critical: values.depthCritical,
        oldest_wait_warning_seconds: values.waitWarning === null ? null : values.waitWarning * 60,
        oldest_wait_critical_seconds:
          values.waitCritical === null ? null : values.waitCritical * 60,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agencies'] }),
  })

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    unit: string,
  ) => (
    <Field id={id} label={label} hint={unit}>
      {(props) => (
        <input
          {...props}
          type="number"
          min={1}
          value={value}
          disabled={!canWrite}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </Field>
  )

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center gap-2.5">
          <Timer className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Queue warnings</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs">
          When a service&apos;s queue shows as getting busy (amber) or backed up (red). Leave a
          field blank to turn that check off.
        </p>
      </PanelHeader>
      <PanelBody>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {field(
            'queue_depth_warning',
            'Amber at',
            depthWarning,
            setDepthWarning,
            'people waiting',
          )}
          {field(
            'queue_depth_critical',
            'Red at',
            depthCritical,
            setDepthCritical,
            'people waiting',
          )}
          {field(
            'oldest_wait_warning',
            'Amber after',
            waitWarning,
            setWaitWarning,
            'minutes, oldest wait',
          )}
          {field(
            'oldest_wait_critical',
            'Red after',
            waitCritical,
            setWaitCritical,
            'minutes, oldest wait',
          )}
        </div>
        {(problem || save.error != null) && (
          <p role="alert" className="text-warn mt-3 text-sm">
            {problem ??
              (save.error instanceof ApiError ? describeApiError(save.error) : 'Could not save.')}
          </p>
        )}
        {canWrite && (
          <div className="mt-4 flex items-center gap-3">
            <Button
              size="sm"
              variant="primary"
              disabled={problem !== null || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {save.isSuccess && <span className="text-ink-3 text-xs">Saved.</span>}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
