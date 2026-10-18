import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Camera as CameraIcon, Eye, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchWeaponThreshold, setWeaponThreshold } from '@/api/endpoints/aiAlerts'
import { createCamera, deleteCamera, fetchCameras, updateCamera } from '@/api/endpoints/cameras'
import { ApiError, describeApiError } from '@/api/errors'
import type { Camera, DeviceStatus, WeaponThreshold } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { CameraForm, type CameraFormValues } from './CameraForm'
import { CAMERA_FEATURE_LABEL } from './cameraFeatures'
import { Screen } from './Screen'

/**
 * The cameras the weapon detector watches, and how sure it has to be before
 * anyone is told. contracts/api.md §11-12, added 2026-09-12.
 *
 * WHY THESE TWO SHARE A SCREEN
 *
 * The backend registers every camera here with the AI service by name and
 * stream URL, then filters that service's weapon detections through the one
 * threshold. They are the two halves of "what gets watched, and what counts"
 * - and they carry the same roles (ADMIN, MANAGER, SECURITY), which the Alerts
 * screen does not: that one is open to every role, and a control only three of
 * them may use would have to hide inside it. auth/access.ts explains why a
 * screen is either offered whole or not at all.
 *
 * WHY THERE IS NO PICTURE
 *
 * `stream_url` is RTSP, which no browser plays. The feed goes to the AI
 * service, not here; what this screen can say about a camera is whether the
 * backend has ever heard from it (`status`), and that is what it says.
 *
 * ROLES
 *
 * A guard can add and edit cameras and move the threshold - it is their
 * detector - but only an ADMIN or MANAGER can delete one. The list has no
 * "every branch" route, only per agency, so an ADMIN picks a branch the way
 * Services makes them; everyone else has exactly one. The picker's own read
 * (GET /api/agencies) is ADMIN and MANAGER only, which is a second reason it
 * is never rendered for SECURITY.
 *
 * THE THRESHOLD IS ONE NUMBER FOR EVERY BRANCH
 *
 * Not per agency, not per camera. A MANAGER in Rabat who lowers it lowers it
 * for Casablanca too, and the panel says so, because that is the kind of
 * side effect someone should read before they press Save rather than learn
 * from a colleague afterwards.
 */

const STATUS_TONE: Record<DeviceStatus, Tone> = {
  ONLINE: 'ok',
  OFFLINE: 'neutral',
  ERROR: 'danger',
  MAINTENANCE: 'warn',
}

export default function Cameras() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const canDelete = isAdmin || user?.role === 'MANAGER'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  /* The shared branch scope every screen now reads (UX_AUDIT.md finding 2) -
     picking one below calls scope.enter(), same as Services and Zones. Falls
     back to the first branch only until the admin has chosen one. Everyone
     else has exactly one agency. */
  const agencyId = isAdmin
    ? (scope.agencyId ?? agencies.data?.[0]?.id ?? null)
    : (user?.agency_id ?? null)

  const cameras = useQuery({
    queryKey: ['cameras', agencyId],
    queryFn: ({ signal }) => fetchCameras(agencyId as string, signal),
    enabled: agencyId !== null,
  })

  const [editing, setEditing] = useState<Camera | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<Camera | null>(null)

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    save.reset()
  }

  const save = useMutation({
    mutationFn: (values: CameraFormValues) =>
      editing ? updateCamera(editing.id, values) : createCamera(agencyId as string, values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cameras', agencyId] })
      closeForm()
    },
  })

  const remove = useMutation({
    mutationFn: (camera: Camera) => deleteCamera(camera.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cameras', agencyId] })
      setConfirmingDelete(null)
    },
  })

  const rows = useMemo(
    () => [...(cameras.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [cameras.data],
  )
  const formOpen = creating || editing !== null

  return (
    <Screen
      title="Cameras"
      description="What the weapon detector watches, and how sure it must be before it raises an alert."
      actions={
        agencyId ? (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add camera
          </Button>
        ) : undefined
      }
    >
      {isAdmin && (
        <div className="mb-4 max-w-xs">
          <label
            htmlFor="cameras_agency"
            className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
          >
            Branch
          </label>
          <select
            id="cameras_agency"
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

      <div className="mb-4">
        <WeaponThresholdPanel />
      </div>

      <AsyncBoundary
        isPending={cameras.isPending}
        error={cameras.error}
        isEmpty={rows.length === 0}
        emptyMessage="No cameras registered for this branch yet. Add the first one and the detector will start watching it."
        forbiddenMessage="Cameras are managed by administrators, managers and security staff. Ask an administrator if you need access."
        onRetry={() => void cameras.refetch()}
        skeletonRows={3}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {rows.map((camera) => (
            <Panel as="section" key={camera.id}>
              <PanelHeader
                action={
                  <div className="flex gap-2">
                    {/* The live picture lives one level down (CameraView.tsx)
                        rather than on this card: a grid of six polling images
                        is a lot of requests for a screen whose job is the
                        list, and a guard watching one camera wants it big. */}
                    <Link
                      to={`/cameras/${camera.id}`}
                      aria-label={`View ${camera.name}`}
                      className="text-ink-2 hover:surface-glass-2 hover:text-ink ease-soft inline-flex size-8 items-center justify-center rounded-lg transition-colors duration-150"
                    >
                      <Eye className="size-3.5" aria-hidden />
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(camera)}
                      aria-label={`Edit ${camera.name}`}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    {canDelete && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingDelete(camera)}
                        aria-label={`Delete ${camera.name}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    )}
                  </div>
                }
              >
                <div className="flex items-center gap-2">
                  <CameraIcon className="text-ink-3 size-4 shrink-0" aria-hidden />
                  <h2 className="text-ink truncate font-mono text-sm font-medium">{camera.name}</h2>
                  <Badge tone={STATUS_TONE[camera.status]}>{camera.status}</Badge>
                </div>
                {/* Said in words because OFFLINE on a camera that was set up an
                    hour ago reads as broken, and usually is not: the backend
                    marks a camera ONLINE only once the detector has sent it
                    something, and a quiet feed sends nothing. */}
                <p className="text-ink-3 mt-1 text-xs">
                  {camera.status === 'ONLINE'
                    ? 'The detector has reported from this camera.'
                    : 'Nothing received from the detector for this camera yet.'}
                </p>
              </PanelHeader>
              <PanelBody>
                <dl>
                  <dt className="text-ink-3 tracked text-[10px] font-medium">Stream</dt>
                  <dd className="text-ink mt-1 truncate font-mono text-xs">
                    {camera.stream_url ?? 'No stream URL'}
                  </dd>
                  <dt className="text-ink-3 tracked mt-3 text-[10px] font-medium">Detections</dt>
                  <dd className="text-ink-2 mt-1 text-xs">
                    {camera.ai_features == null
                      ? 'All'
                      : camera.ai_features.length === 0
                        ? 'None'
                        : camera.ai_features.map((f) => CAMERA_FEATURE_LABEL[f]).join(', ')}
                  </dd>
                </dl>
              </PanelBody>
            </Panel>
          ))}
        </div>
      </AsyncBoundary>

      <Dialog open={formOpen} title={editing ? 'Edit camera' : 'Add camera'} onClose={closeForm}>
        {formOpen && (
          <CameraForm
            camera={editing}
            pending={save.isPending}
            error={save.error}
            onCancel={closeForm}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmingDelete !== null}
        title="Delete this camera?"
        description="The detector stops watching it as soon as the backend re-syncs."
        onClose={() => {
          setConfirmingDelete(null)
          remove.reset()
        }}
      >
        {confirmingDelete && (
          <div>
            <p className="text-ink-2 text-sm leading-relaxed">
              Deleting <span className="text-ink font-medium">{confirmingDelete.name}</span> cannot
              be undone. Alerts already raised from it are kept; no new ones will come from it.
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
    </Screen>
  )
}

/** Field(gt=0, le=1) on the request - the same rule, stated before the round trip. */
function confidenceError(raw: string): string | undefined {
  if (raw.trim() === '') return 'Required.'
  const value = Number(raw)
  if (!Number.isFinite(value)) return 'Enter a number.'
  if (value <= 0 || value > 1) return 'Greater than 0 and at most 1.'
  return undefined
}

/**
 * The one global weapon-detection threshold.
 *
 * Kept in the contract's own unit - a fraction between 0 and 1 - rather than
 * converted to a percentage, so the number on screen is the number in the
 * request and in the backend's logs, and nobody has to wonder which of the
 * two a colleague meant.
 *
 * `draft` is null until the person types: the field shows the server value
 * until then, and Save has nothing to do. That is what makes "did I change
 * anything?" answerable without comparing two numbers by eye.
 */
function WeaponThresholdPanel() {
  const queryClient = useQueryClient()
  const threshold = useQuery({
    queryKey: ['weaponThreshold'],
    queryFn: ({ signal }) => fetchWeaponThreshold(signal),
  })
  const [draft, setDraft] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (body: WeaponThreshold) => setWeaponThreshold(body),
    onSuccess: (saved) => {
      queryClient.setQueryData(['weaponThreshold'], saved)
      setDraft(null)
    },
  })

  const serverValue = threshold.data?.confidence
  const shown = draft ?? (serverValue === undefined ? '' : String(serverValue))
  const error = draft === null ? undefined : confidenceError(draft)
  const changed = draft !== null && Number(draft) !== serverValue

  function submit(event: FormEvent) {
    event.preventDefault()
    if (draft === null || error) return
    save.mutate({ confidence: Number(draft) })
  }

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center gap-2">
          <ShieldAlert className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink text-sm font-semibold">Weapon detection threshold</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs">
          Detections below this confidence are dropped before they become alerts. One value for
          every branch and every camera - changing it here changes it everywhere.
        </p>
      </PanelHeader>
      <PanelBody>
        {threshold.isError ? (
          <p role="alert" className="text-warn text-sm">
            {threshold.error instanceof ApiError
              ? describeApiError(threshold.error)
              : 'Could not load the threshold.'}
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field
                id="weapon_confidence"
                label="Minimum confidence"
                required
                error={error}
                hint="Between 0 and 1. Higher means fewer, surer alerts."
              >
                {(props) => (
                  <input
                    {...props}
                    type="number"
                    min={0.01}
                    max={1}
                    step={0.01}
                    inputMode="decimal"
                    value={shown}
                    disabled={threshold.isPending}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!changed || error !== undefined || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {save.error !== null && (
              <p role="alert" className="text-warn w-full text-sm">
                {save.error instanceof ApiError
                  ? describeApiError(save.error)
                  : 'Could not save the threshold.'}
              </p>
            )}
          </form>
        )}
      </PanelBody>
    </Panel>
  )
}
