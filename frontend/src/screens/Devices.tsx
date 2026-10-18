import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, KeyRound, Pencil, Plus, Thermometer, Trash2 } from 'lucide-react'
import {
  deleteDevice,
  fetchDevices,
  registerDevice,
  rotateDeviceKey,
  updateDevice,
} from '@/api/endpoints/devices'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchZones } from '@/api/endpoints/zones'
import { deleteThreshold, fetchThresholds, upsertThreshold } from '@/api/endpoints/thresholds'
import { ApiError, describeApiError } from '@/api/errors'
import type {
  Device,
  DeviceCreate,
  DeviceRegistration,
  DeviceStatus,
  DeviceUpdate,
  SensorThreshold,
} from '@/api/types'
import { useScope, withinScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { Clock } from '@/components/ui/Time'
import { DeviceForm, type DeviceFormValues } from './DeviceForm'
import { Screen } from './Screen'

/**
 * IoT device administration - registration, status, and the sensor thresholds
 * that decide when a reading becomes an alert. contracts/api.md §9-10, added
 * 2026-08-27.
 *
 * ADMIN, MANAGER and TECHNICIAN throughout, except rotating a key, which is
 * ADMIN and MANAGER only - a technician can register a sensor and read its
 * status, but not mint a new secret for it.
 */

const STATUS_TONE: Record<DeviceStatus, Tone> = {
  ONLINE: 'ok',
  OFFLINE: 'neutral',
  ERROR: 'danger',
  MAINTENANCE: 'warn',
}

export default function Devices() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const canRotateKey = isAdmin || user?.role === 'MANAGER'

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: ({ signal }) => fetchDevices(signal),
  })

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  /* Camera zones for a reader's badge zone. /api/zones is ADMIN and MANAGER
     only, so a technician gets the field read-only rather than a 403. */
  const canReadZones = isAdmin || user?.role === 'MANAGER'
  const cameraZones = useQuery({
    queryKey: ['zones'],
    queryFn: ({ signal }) => fetchZones(signal),
    enabled: canReadZones,
  })

  const [editing, setEditing] = useState<Device | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<Device | null>(null)
  /* Rotating cuts the real device off at once (its key stops working), so it
     is confirmed first - one stray click took a door reader offline in the
     2026-10-18 day test. */
  const [confirmingRotate, setConfirmingRotate] = useState<Device | null>(null)
  const [managingThresholds, setManagingThresholds] = useState<Device | null>(null)
  /* The one and only time a device_key is ever shown - see registerDevice's
     doc comment in api/endpoints/devices.ts. Cleared on close, not stored. */
  const [revealedKey, setRevealedKey] = useState<DeviceRegistration | null>(null)

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    save.reset()
  }

  const save = useMutation({
    mutationFn: async (values: DeviceFormValues) => {
      if (editing) return updateDevice(editing.id, deviceUpdateBody(values))
      const registered = await registerDevice(values.agency_id, deviceCreateBody(values))
      setRevealedKey(registered)
      return registered
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['devices'] })
      closeForm()
    },
  })

  const remove = useMutation({
    mutationFn: (device: Device) => deleteDevice(device.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['devices'] })
      setConfirmingDelete(null)
    },
  })

  const rotate = useMutation({
    mutationFn: (device: Device) => rotateDeviceKey(device.id),
    onSuccess: (registered) => {
      setConfirmingRotate(null)
      setRevealedKey(registered)
    },
  })

  /* Narrowed to the branch an admin has open, if they have one - same as
     Employees and Employee presence. Does nothing at all unless somebody
     chose it, and the bar in AppShell says so while it lasts. */
  const rows = useMemo(
    () => withinScope(devices.data ?? [], scope.agencyId),
    [devices.data, scope.agencyId],
  )
  const formOpen = creating || editing !== null

  return (
    <Screen
      title="IoT devices"
      description="Sensors reporting into the platform, and the thresholds that turn a reading into an alert."
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden />
          Register device
        </Button>
      }
    >
      <AsyncBoundary
        isPending={devices.isPending}
        error={devices.error}
        isEmpty={rows.length === 0}
        emptyMessage="No devices registered yet."
        forbiddenMessage="Devices are managed by administrators, managers and technicians. Ask an administrator if you need access."
        onRetry={() => void devices.refetch()}
        skeletonRows={4}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {rows.map((device) => (
            <Panel as="section" key={device.id}>
              <PanelHeader
                action={
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setManagingThresholds(device)}
                      aria-label={`Manage thresholds for ${device.name}`}
                    >
                      <Thermometer className="size-3.5" aria-hidden />
                    </Button>
                    {canRotateKey && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={rotate.isPending}
                        onClick={() => setConfirmingRotate(device)}
                        aria-label={`Rotate key for ${device.name}`}
                      >
                        <KeyRound className="size-3.5" aria-hidden />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(device)}
                      aria-label={`Edit ${device.name}`}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDelete(device)}
                      aria-label={`Delete ${device.name}`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                }
              >
                <div className="flex items-center gap-2">
                  <Cpu className="text-ink-3 size-4 shrink-0" aria-hidden />
                  <h2 className="text-ink truncate text-sm font-semibold">{device.name}</h2>
                  <Badge tone={STATUS_TONE[device.status]}>{device.status}</Badge>
                </div>
                <p className="text-ink-3 mt-1 truncate text-xs">
                  {device.device_type} · {device.mqtt_client_id}
                </p>
              </PanelHeader>
              <PanelBody>
                <p className="text-ink-3 text-xs">
                  {device.last_seen_at ? (
                    <>
                      Last seen <Clock iso={device.last_seen_at} />
                    </>
                  ) : (
                    'Never reported in'
                  )}
                </p>
              </PanelBody>
            </Panel>
          ))}
        </div>
      </AsyncBoundary>

      <Dialog
        open={formOpen}
        title={editing ? 'Edit device' : 'Register device'}
        description={
          editing
            ? undefined
            : "You'll see the device key exactly once, right after this - there is no way to recover it later."
        }
        onClose={closeForm}
      >
        {formOpen && (
          <DeviceForm
            device={editing}
            agencies={agencies.data ?? []}
            defaultAgencyId={user?.agency_id ?? null}
            canChooseAgency={isAdmin}
            cameraZones={
              cameraZones.isSuccess
                ? cameraZones.data.map((z) => z.name).sort((a, b) => a.localeCompare(b))
                : null
            }
            pending={save.isPending}
            error={save.error}
            onCancel={closeForm}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this device?"
        description="Its thresholds are removed with it. Sensor readings already recorded are not."
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

      <Dialog
        open={confirmingRotate !== null}
        title={`New key for ${confirmingRotate?.name ?? 'this device'}?`}
        description="The current key stops working immediately: the device goes offline until the new key is entered into it."
        onClose={() => {
          setConfirmingRotate(null)
          rotate.reset()
        }}
      >
        {confirmingRotate && (
          <div>
            {rotate.error !== null && (
              <p
                role="alert"
                className="border-warn/30 bg-warn/8 text-warn mb-4 rounded-lg border p-3 text-sm"
              >
                {rotate.error instanceof ApiError
                  ? describeApiError(rotate.error)
                  : 'Could not rotate the key.'}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setConfirmingRotate(null)
                  rotate.reset()
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate(confirmingRotate)}
              >
                {rotate.isPending ? 'Rotating…' : 'Rotate key'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={revealedKey !== null}
        title="Device key"
        description="Shown once. Copy it into the device now - there is no route to recover it later, only to rotate it."
        onClose={() => setRevealedKey(null)}
      >
        {revealedKey && (
          <div>
            <p className="border-line bg-panel-2 tabular text-ink break-all rounded-lg border px-4 py-3 text-sm">
              {revealedKey.device_key}
            </p>
            <p className="text-ink-3 mt-3 text-xs">
              For <span className="text-ink-2">{revealedKey.name}</span>, topic{' '}
              <span className="text-ink-2">{revealedKey.mqtt_topic}</span>.
            </p>
            <div className="mt-6 flex justify-end">
              <Button variant="primary" onClick={() => setRevealedKey(null)}>
                I've stored it
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={managingThresholds !== null}
        title={managingThresholds ? `Thresholds for ${managingThresholds.name}` : ''}
        onClose={() => setManagingThresholds(null)}
      >
        {managingThresholds && <ThresholdsPanel device={managingThresholds} />}
      </Dialog>
    </Screen>
  )
}

function deviceCreateBody(values: DeviceFormValues): DeviceCreate {
  return {
    name: values.name.trim(),
    device_type: values.device_type.trim(),
    mqtt_client_id: values.mqtt_client_id.trim(),
    mqtt_topic: values.mqtt_topic.trim() || null,
  }
}

function deviceUpdateBody(values: DeviceFormValues): DeviceUpdate {
  const topic = values.mqtt_topic.trim()
  return {
    name: values.name.trim(),
    device_type: values.device_type.trim(),
    /* Omitted rather than sent as null when blank: the column is NOT NULL, so
       a literal null would fail at the database rather than in validation.
       Clearing the field in this form means "leave it alone", not "delete
       the topic" - there is no way to have no topic at all. */
    ...(topic ? { mqtt_topic: topic } : {}),
    status: values.status,
    badge_zone_name: values.badge_zone_name || null,
    heartbeat_seconds: values.heartbeat_seconds.trim() ? Number(values.heartbeat_seconds) : null,
  }
}

/**
 * Sensor thresholds for one device. Nested here rather than a separate
 * screen: a threshold means nothing without the device it belongs to, and
 * there are rarely more than a handful per device.
 */
function ThresholdsPanel({ device }: { device: Device }) {
  const queryClient = useQueryClient()

  const thresholds = useQuery({
    queryKey: ['thresholds', device.id],
    queryFn: ({ signal }) => fetchThresholds(device.id, signal),
  })

  const [adding, setAdding] = useState(false)

  const save = useMutation({
    mutationFn: ({
      sensorType,
      unit,
      warningMax,
      criticalMax,
    }: {
      sensorType: string
      unit: string
      warningMax: number | null
      criticalMax: number | null
    }) =>
      upsertThreshold(device.id, sensorType, {
        unit: unit.trim() || null,
        warning_max: warningMax,
        critical_max: criticalMax,
        is_active: true,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['thresholds', device.id] })
      setAdding(false)
    },
  })

  const remove = useMutation({
    mutationFn: (threshold: SensorThreshold) => deleteThreshold(device.id, threshold.sensor_type),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['thresholds', device.id] })
    },
  })

  const rows = thresholds.data ?? []

  return (
    <div className="space-y-3">
      <AsyncBoundary
        isPending={thresholds.isPending}
        error={thresholds.error}
        isEmpty={rows.length === 0 && !adding}
        emptyMessage="No thresholds set for this device yet."
        onRetry={() => void thresholds.refetch()}
        skeletonRows={2}
      >
        <div className="space-y-2">
          {rows.map((threshold) => (
            <div
              key={threshold.id}
              className="border-line flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-ink text-sm font-medium">{threshold.sensor_type}</p>
                <p className="text-ink-3 tabular text-xs">
                  warn ≥ {threshold.warning_max ?? '—'} · critical ≥ {threshold.critical_max ?? '—'}
                  {threshold.unit ? ` ${threshold.unit}` : ''}
                  {!threshold.is_active && ' · inactive'}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(threshold)}
                aria-label={`Remove ${threshold.sensor_type} threshold`}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </AsyncBoundary>

      {adding ? (
        <ThresholdAddForm
          pending={save.isPending}
          error={save.error}
          onCancel={() => {
            setAdding(false)
            save.reset()
          }}
          onSubmit={(v) => save.mutate(v)}
        />
      ) : (
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" aria-hidden />
          Add threshold
        </Button>
      )}
    </div>
  )
}

function ThresholdAddForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: {
    sensorType: string
    unit: string
    warningMax: number | null
    criticalMax: number | null
  }) => void
}) {
  const [sensorType, setSensorType] = useState('')
  const [unit, setUnit] = useState('')
  const [warningMax, setWarningMax] = useState('')
  const [criticalMax, setCriticalMax] = useState('')

  const invalid = sensorType.trim() === '' || (warningMax === '' && criticalMax === '')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (invalid) return
    onSubmit({
      sensorType: sensorType.trim(),
      unit,
      warningMax: warningMax === '' ? null : Number(warningMax),
      criticalMax: criticalMax === '' ? null : Number(criticalMax),
    })
  }

  const message = useMemo(() => {
    if (error == null) return null
    if (!(error instanceof ApiError)) return 'Could not save.'
    if (error.status === 422) {
      return 'Set at least a warning or critical value, and warning must not exceed critical.'
    }
    return describeApiError(error)
  }, [error])

  return (
    <form onSubmit={submit} className="border-line space-y-3 rounded-lg border p-3">
      <div className="grid grid-cols-2 gap-2">
        <input
          aria-label="Sensor type"
          className={controlClass()}
          placeholder="temperature"
          value={sensorType}
          onChange={(e) => setSensorType(e.target.value)}
        />
        <input
          aria-label="Unit"
          className={controlClass()}
          placeholder="C"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          aria-label="Warning max"
          type="number"
          className={controlClass()}
          placeholder="Warning max"
          value={warningMax}
          onChange={(e) => setWarningMax(e.target.value)}
        />
        <input
          aria-label="Critical max"
          type="number"
          className={controlClass()}
          placeholder="Critical max"
          value={criticalMax}
          onChange={(e) => setCriticalMax(e.target.value)}
        />
      </div>
      {message && (
        <p role="alert" className="text-warn text-xs">
          {message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={pending || invalid}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
