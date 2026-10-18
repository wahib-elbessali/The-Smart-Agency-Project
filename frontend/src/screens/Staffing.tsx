import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { CircleHelp, Plus, Trash2, UserCheck, UserX } from 'lucide-react'
import { fetchCounters, updateCounter } from '@/api/endpoints/counters'
import { createWorkstationStream } from '@/api/endpoints/streams'
import {
  createWorkstation,
  deleteWorkstation,
  fetchWorkstations,
} from '@/api/endpoints/workstations'
import { fetchZones } from '@/api/endpoints/zones'
import { ApiError, describeApiError } from '@/api/errors'
import { applyWorkstationFrame, unstaffed, type WorkstationsByName } from '@/api/streamMerge'
import type { Counter, Workstation, WorkstationFrame, WorkstationStatus } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { useStream } from '@/hooks/useStream'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StreamStatusBadge } from '@/components/StreamStatusBadge'
import { controlClass } from '@/components/ui/control'
import { Screen } from './Screen'

/**
 * Whether the counters are being manned, live. Added 2026-09-19, the second
 * half of the AI/CV integration (contracts/ai-service.md
 * §/employee_activity).
 *
 * THIS IS NOT ATTENDANCE, and confusing the two would be the expensive
 * mistake. Employee presence answers "did they badge in today?" from the RFID
 * reader at the door. This answers "is anyone at counter 3 right now, while
 * twelve people are waiting?" Somebody can be present by the first measure
 * and away by the second all afternoon, and both readings are true.
 *
 * HOW LITTLE IS BEHIND IT
 *
 * No face recognition, no new model, no calibration: the AI service builds
 * this entirely on /zoning's existing occupancy. A workstation is a name
 * bound to a zone drawn on the Zones screen - so that screen is the setup
 * step for this one, which is why the empty state sends people there.
 *
 * THE THREE STATUSES ARE NOT TWO
 *
 * `present` fires on any sighting. `away` arrives only after the zone has
 * been continuously empty for the service's absence window (300s by
 * default), so it is a slow and deliberate signal rather than a flicker -
 * stepping to the printer does not empty a counter. `unknown` is neither: it
 * means the zone has not been classified yet, and with `zone_known: false`
 * it means nothing has EVER been read there, which is a broken camera rather
 * than a quiet counter. Those are rendered as three different things,
 * because a screen that shows "away" for a camera that has never worked is
 * reporting an unmanned counter that may be perfectly staffed.
 *
 * ROWS COME FROM REST, STATUS COMES FROM THE STREAM
 *
 * The list is the scoped one - the proxy filters it to the caller's branch
 * through the zone's camera, since the AI service has no notion of an agency
 * and its stream carries the whole site. So the stream is used to refresh
 * the status of rows this caller already has, and a frame naming a
 * workstation that is not in their list is ignored rather than rendered.
 * Without that, one manager's wall display would quietly grow another
 * branch's counters.
 */

const STATUS_TONE: Record<WorkstationStatus, Tone> = {
  present: 'ok',
  away: 'warn',
  unknown: 'neutral',
}

const STATUS_LABEL: Record<WorkstationStatus, string> = {
  present: 'Manned',
  away: 'Nobody there',
  unknown: 'Not classified',
}

/**
 * How long ago something happened, from an epoch-SECONDS float.
 *
 * The AI service speaks Unix time where the rest of this dashboard speaks ISO
 * 8601, so the conversion happens here rather than pretending the field is
 * something it is not. Anything under a minute reads as "just now" - a
 * counter that emptied 40 seconds ago and one that emptied 10 are the same
 * fact to the person reading this.
 */
function elapsed(since: number): { minutes: number; text: string } {
  const seconds = Math.max(0, Date.now() / 1000 - since)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) return { minutes, text: 'less than a minute' }
  if (minutes < 60) return { minutes, text: `${minutes} min` }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return { minutes, text: rest === 0 ? `${hours} h` : `${hours} h ${rest} min` }
}

/**
 * `since` is when the STATUS began, not when the counter emptied.
 *
 * That distinction produced the first wording bug on this screen: a counter
 * flagged five seconds ago was rendered as "empty just now — past the
 * detector's five-minute window", which contradicts itself. The service only
 * declares `away` AFTER the full absence window has already elapsed, so the
 * moment it flips, the counter has in fact been empty for five minutes and a
 * bit. Saying when it was flagged is the honest form; adding the window on
 * top and claiming a total would be arithmetic on a number the service does
 * not publish.
 */
function flaggedLabel(since: number): string {
  const { minutes, text } = elapsed(since)
  return minutes < 1 ? 'flagged just now' : `flagged ${text} ago`
}

function counterLabel(counter: Counter): string {
  return counter.name ?? `Guichet ${counter.number}`
}

export default function Staffing() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()

  /* Which counter each workstation watches (Counter.workstation_name). The
     visitor queue and the staffing cross-check read that link, and before
     this screen offered it, it could only be set through the API. Counters
     belong to one branch: an admin needs a branch open to see them. */
  const agencyId = user?.role === 'ADMIN' ? scope.agencyId : (user?.agency_id ?? null)
  const counters = useQuery({
    queryKey: ['counters', agencyId],
    queryFn: ({ signal }) => fetchCounters(agencyId as string, signal),
    enabled: agencyId !== null,
  })
  const counterFor = (stationName: string) =>
    (counters.data ?? []).find((c) => c.workstation_name === stationName) ?? null

  const link = useMutation({
    /* One counter per workstation: unlink whichever counter had it before. */
    mutationFn: async ({ station, counterId }: { station: string; counterId: string | null }) => {
      const previous = counterFor(station)
      if (previous && previous.id !== counterId) {
        await updateCounter(previous.id, { workstation_name: null })
      }
      if (counterId && previous?.id !== counterId) {
        await updateCounter(counterId, { workstation_name: station })
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['counters', agencyId] }),
  })

  const stations = useQuery({
    queryKey: ['workstations'],
    queryFn: ({ signal }) => fetchWorkstations(signal),
  })

  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: ({ signal }) => fetchZones(signal),
  })

  const { state: live, status: streamStatus } = useStream<WorkstationFrame, WorkstationsByName>(
    'workstations',
    () => createWorkstationStream(),
    applyWorkstationFrame,
    () => ({}),
  )

  /* The scoped list, wearing whatever the feed last said about each row. */
  const rows: Workstation[] = useMemo(
    () =>
      [...(stations.data ?? [])]
        .map((station) => live[station.name] ?? station)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [stations.data, live],
  )

  const byName = useMemo(
    () => Object.fromEntries(rows.map((station) => [station.name, station])),
    [rows],
  )
  const empty = useMemo(() => unstaffed(byName), [byName])

  const [binding, setBinding] = useState(false)

  const bind = useMutation({
    mutationFn: async (values: { name: string; zone: string; counterId: string | null }) => {
      await createWorkstation({ name: values.name, zone: values.zone })
      if (values.counterId)
        await link.mutateAsync({ station: values.name, counterId: values.counterId })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workstations'] })
      setBinding(false)
    },
  })

  const unbind = useMutation({
    mutationFn: (station: Workstation) => deleteWorkstation(station.name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workstations'] })
    },
  })

  const zoneNames = useMemo(
    () => (zones.data ?? []).map((zone) => zone.name).sort((a, b) => a.localeCompare(b)),
    [zones.data],
  )
  const takenNames = useMemo(
    () => new Set((stations.data ?? []).map((station) => station.name)),
    [stations.data],
  )

  return (
    <Screen
      title="Counter staffing"
      description="Whether anyone is actually at each counter, from the zones drawn on the cameras."
      actions={
        <div className="flex items-center gap-2">
          <StreamStatusBadge status={streamStatus} />
          {zoneNames.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => setBinding(true)}>
              <Plus className="size-3.5" aria-hidden />
              Add workstation
            </Button>
          )}
        </div>
      }
    >
      {empty.length > 0 && (
        <Panel as="section" tone="alert" className="mb-4">
          <PanelBody className="flex gap-3">
            <UserX className="text-warn mt-0.5 size-5 shrink-0" aria-hidden />
            <div>
              <h2 className="text-ink text-sm font-semibold">
                {empty.length === 1
                  ? '1 counter has nobody at it'
                  : `${empty.length} counters have nobody at them`}
              </h2>
              <p className="text-ink-2 mt-1 text-sm leading-relaxed">
                {empty.map((station) => station.name).join(', ')} —{' '}
                {empty.length === 1 ? 'empty' : 'each empty'} for at least five continuous minutes,
                which is how long the detector waits before saying so. Not somebody stepping away.
              </p>
            </div>
          </PanelBody>
        </Panel>
      )}

      <AsyncBoundary
        isPending={stations.isPending}
        error={stations.error}
        isEmpty={rows.length === 0}
        emptyMessage={
          zoneNames.length === 0
            ? 'No zones drawn yet. A workstation watches a zone, so draw the area in front of a counter first.'
            : 'No workstations yet. Bind one to a zone and the detector will report whether anyone is standing in it.'
        }
        forbiddenMessage="Counter staffing is read by administrators and managers. Ask an administrator if you need access."
        onRetry={() => void stations.refetch()}
        skeletonRows={3}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {rows.map((station) => (
            <Panel as="section" key={station.name}>
              <PanelHeader
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Unbind ${station.name}`}
                    disabled={unbind.isPending}
                    onClick={() => unbind.mutate(station)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                }
              >
                <div className="flex items-center gap-2">
                  <StatusIcon status={station.status} />
                  <h2 className="text-ink min-w-0 truncate text-sm font-semibold">
                    {station.name}
                  </h2>
                  <Badge tone={STATUS_TONE[station.status]}>{STATUS_LABEL[station.status]}</Badge>
                </div>
                <p className="text-ink-3 mt-1 truncate text-xs">
                  Watching zone <span className="text-ink-2">{station.zone}</span>
                </p>
                {agencyId !== null && counters.isSuccess && (
                  <div className="mt-2 flex items-center gap-2">
                    <label htmlFor={`counter-${station.name}`} className="text-ink-3 text-xs">
                      Counter
                    </label>
                    <select
                      id={`counter-${station.name}`}
                      className={`${controlClass()} h-8 py-0 text-xs`}
                      value={counterFor(station.name)?.id ?? ''}
                      disabled={link.isPending}
                      onChange={(e) =>
                        link.mutate({ station: station.name, counterId: e.target.value || null })
                      }
                    >
                      <option value="">Not linked</option>
                      {counters.data.map((counter) => (
                        <option key={counter.id} value={counter.id}>
                          {counterLabel(counter)}
                          {counter.workstation_name && counter.workstation_name !== station.name
                            ? ` (now ${counter.workstation_name})`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </PanelHeader>

              <PanelBody>
                {/* `zone_known: false` outranks the status: there is no
                    reading at all, so saying anything about the counter
                    would be inventing it. */}
                {!station.zone_known ? (
                  <p className="text-ink-2 text-sm leading-relaxed">
                    Nothing has been measured here yet. The camera behind{' '}
                    <span className="text-ink">{station.zone}</span> has not produced a frame, so
                    this is a camera to check rather than a counter to staff.
                  </p>
                ) : (
                  <p className="text-ink-2 text-sm leading-relaxed">
                    {station.status === 'present' && (
                      <>
                        Somebody has been at this counter for{' '}
                        <span className="text-ink">{elapsed(station.since).text}</span>.
                      </>
                    )}
                    {station.status === 'away' && (
                      <>
                        Nobody there for at least five minutes —{' '}
                        <span className="text-ink">{flaggedLabel(station.since)}</span>. The
                        detector waits out a full five minutes of absence before saying this, so it
                        is not somebody who stepped away.
                      </>
                    )}
                    {station.status === 'unknown' && (
                      <>Waiting for the detector to classify this zone.</>
                    )}
                  </p>
                )}
              </PanelBody>
            </Panel>
          ))}
        </div>
      </AsyncBoundary>

      {link.error != null && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm"
        >
          {link.error instanceof ApiError
            ? describeApiError(link.error)
            : 'Could not link that counter.'}
        </p>
      )}

      {agencyId === null && rows.length > 0 && (
        <p className="text-ink-3 mt-4 text-xs leading-relaxed">
          Open a branch (Agencies, then Open) to link these workstations to its counters.
        </p>
      )}

      {unbind.error != null && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm"
        >
          {unbind.error instanceof ApiError
            ? describeApiError(unbind.error)
            : 'Could not unbind that workstation.'}
        </p>
      )}

      <p className="text-ink-3 mt-4 text-xs leading-relaxed">
        This is not attendance. It says whether a counter is being manned, not who is at it and not
        whether they came to work — {user?.role === 'ADMIN' ? 'the' : 'your'} roster lives on{' '}
        <Link to="/presence" className="text-ink-2 hover:text-accent underline">
          Employee presence
        </Link>
        . Areas are drawn on{' '}
        <Link to="/zones" className="text-ink-2 hover:text-accent underline">
          Zones
        </Link>
        .
      </p>

      <Dialog
        open={binding}
        title="Add a workstation"
        description="A workstation is a name for one zone, watched for whether anyone is standing in it."
        onClose={() => {
          setBinding(false)
          bind.reset()
        }}
      >
        {binding && (
          <BindForm
            zoneNames={zoneNames}
            takenNames={takenNames}
            counters={counters.data ?? []}
            pending={bind.isPending}
            error={bind.error}
            onCancel={() => {
              setBinding(false)
              bind.reset()
            }}
            onSubmit={(values) => bind.mutate(values)}
          />
        )}
      </Dialog>
    </Screen>
  )
}

function StatusIcon({ status }: { status: WorkstationStatus }) {
  if (status === 'present') return <UserCheck className="text-ok size-4 shrink-0" aria-hidden />
  if (status === 'away') return <UserX className="text-warn size-4 shrink-0" aria-hidden />
  return <CircleHelp className="text-ink-3 size-4 shrink-0" aria-hidden />
}

/**
 * The zone is picked, never typed.
 *
 * The AI service answers 422 for a zone that does not exist, and a free-text
 * field would make that the normal way to discover a typo. Picking also makes
 * the dependency visible: no zones, no workstations.
 */
function BindForm({
  zoneNames,
  takenNames,
  counters,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  zoneNames: string[]
  takenNames: Set<string>
  /** This branch's counters; empty when no branch is open. */
  counters: Counter[]
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (values: { name: string; zone: string; counterId: string | null }) => void
}) {
  const [name, setName] = useState('')
  const [zone, setZone] = useState(zoneNames[0] ?? '')
  const [counterId, setCounterId] = useState('')
  const trimmed = name.trim()
  const replacing = trimmed.length > 0 && takenNames.has(trimmed)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (trimmed.length === 0 || zone.length === 0) return
    onSubmit({ name: trimmed, zone, counterId: counterId || null })
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="space-y-4">
        <Field id="workstation_name" label="Name" required hint="What people call this counter.">
          {(props) => (
            <input
              {...props}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          )}
        </Field>

        <Field id="workstation_zone" label="Zone" required>
          {(props) => (
            <select {...props} value={zone} onChange={(e) => setZone(e.target.value)}>
              {zoneNames.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
        </Field>

        {counters.length > 0 && (
          <Field
            id="workstation_counter"
            label="Counter"
            hint="Optional. Which counter this desk is, so the queue knows if anyone is at it."
          >
            {(props) => (
              <select {...props} value={counterId} onChange={(e) => setCounterId(e.target.value)}>
                <option value="">Not linked</option>
                {counters.map((counter) => (
                  <option key={counter.id} value={counter.id}>
                    {counterLabel(counter)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>

      {replacing && (
        <p className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm leading-relaxed">
          A workstation called <span className="font-medium">{trimmed}</span> already exists. Saving
          rebinds it to this zone.
        </p>
      )}

      {error != null && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm"
        >
          {error instanceof ApiError ? describeApiError(error) : 'Could not add this workstation.'}
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || trimmed.length === 0}>
          {pending ? 'Saving…' : replacing ? 'Rebind' : 'Add workstation'}
        </Button>
      </div>
    </form>
  )
}
