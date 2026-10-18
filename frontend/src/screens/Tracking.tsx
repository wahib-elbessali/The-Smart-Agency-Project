import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AlertTriangle, Radar, RotateCcw, UserCheck, UserX, Users } from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchCalibration } from '@/api/endpoints/calibration'
import { fetchCameras } from '@/api/endpoints/cameras'
import { fetchIntruders, fetchZones } from '@/api/endpoints/zones'
import {
  fetchPeopleSources,
  fetchPeopleStatus,
  registerPeopleSources,
  removePeopleSource,
} from '@/api/endpoints/people'
import { createAlertStream, createPeopleStream } from '@/api/endpoints/streams'
import {
  fetchRoster,
  fetchTrackedEmployees,
  linkEmployeeTrack,
  unlinkTrack,
} from '@/api/endpoints/employees'
import { ApiError, describeApiError } from '@/api/errors'
import { fetchTrackedTickets } from '@/api/endpoints/tickets'
import {
  applyAlertFrame,
  applyPeopleFrame,
  INITIAL_PEOPLE_STATE,
  type AlertsByCamera,
  type PeopleLiveState,
} from '@/api/streamMerge'
import type { AlertFrame, PeopleStreamFrame } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { useStream } from '@/hooks/useStream'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { StatTile } from '@/components/ui/StatTile'
import { StreamStatusBadge } from '@/components/StreamStatusBadge'
import { controlClass } from '@/components/ui/control'
import { Screen } from './Screen'
import { trackMarkers } from './trackMarkers'

/**
 * Live map: every tracked person across the calibrated, aligned cameras
 * registered with /people, projected into shared floor coordinates - the
 * actual bird's-eye-view piece of what this project describes itself as
 * having.
 *
 * Built against ai/features/person_tracking/api.py's real, documented spec
 * (checked directly - not the reference console's page, which is a raw
 * client of the AI service this dashboard must never reach directly,
 * project rule, 2026-08-11) and ai/reference_ui/console/index.html's `/people`
 * panel for the interaction shape.
 *
 * BOOTSTRAP IS AUTOMATIC, NOT A BUTTON ON THIS SCREEN
 *
 * There is deliberately no "start tracking" - the real service bootstraps
 * on its own once >=2 registered cameras are calibrated and aligned. What
 * this screen owns is the source registry (which cameras count) and
 * reading the result, not triggering anything.
 *
 * WHAT'S DELIBERATELY MISSING: A ZONE OVERLAY
 *
 * The reference console draws world-mode zone polygons under the dots.
 * That needs the same shared floor frame this map already plots into, and
 * world-mode zones are real now (see the Zones screen) - a later pass can
 * fetch them and overlay polygon_m under the dots. Left out of this pass
 * because it is a second, separable feature, not because it is hard.
 *
 * TICKET LABELS (scenario-planning backlog, Phase B)
 *
 * Most dots will just show their bare AI track id - that's expected, not a
 * bug. A dot only gets relabeled with a ticket number if it was standing in
 * an agency's configured kiosk zone at the exact moment someone took a
 * ticket there (see GET /api/tickets/tracked); anyone who never took a
 * ticket, or took one before a kiosk zone existed, stays anonymous.
 *
 * EMPLOYEE LABELS (scenario-planning backlog, Phase F)
 *
 * A second, independent relabeling source: a dot gets an employee's name if
 * that employee's last badge scan (at a reader with a configured zone) put
 * them in a tracked position (see GET /api/employees/tracked). Unlike the
 * ticket link, this one re-links on every scan, so it can go stale between
 * scans - an accepted trade-off, not a bug. Employee name wins over a ticket
 * number if a track id were ever (implausibly) claimed by both at once.
 */

export default function Tracking() {
  const { state: streamed, status } = useStream<PeopleStreamFrame, PeopleLiveState>(
    'people',
    createPeopleStream,
    applyPeopleFrame,
    () => INITIAL_PEOPLE_STATE,
  )

  /* A slow poll alongside the stream, not instead of it - the stream only
     ever pushes a `state` frame on a phase TRANSITION, and `warnings` is
     computed as part of that transition too, so a warning that would only
     appear on a fresh GET (nothing forces a transition just because it
     changed) doesn't otherwise reach this screen until the next one. The
     same goes for the room and person scale: a screen opened while tracking
     is already running never sees a transition, so they come from here. */
  const polled = useQuery({
    queryKey: ['peopleStatus'],
    queryFn: ({ signal }) => fetchPeopleStatus(signal),
    refetchInterval: 5_000,
  })
  const live = useMemo(
    () => ({
      ...streamed,
      room: streamed.room ?? polled.data?.room ?? null,
      personScale: streamed.personScale ?? polled.data?.person_scale ?? null,
    }),
    [streamed, polled.data],
  )

  /* Who on the map is carrying a weapon or matches the watchlist: the two
     alert feeds, tied to tracks through each camera's person boxes. */
  const weapon = useStream<AlertFrame, AlertsByCamera>(
    'weapon',
    () => createAlertStream('weapon'),
    applyAlertFrame,
    () => ({}),
  )
  const wanted = useStream<AlertFrame, AlertsByCamera>(
    'wanted',
    () => createAlertStream('wanted'),
    applyAlertFrame,
    () => ({}),
  )
  const hinvByCameraName = useCameraCalibrationByName()

  /* Who is standing in a restricted zone they may not be in: the open
     intrusion alerts, each about one tracked person. */
  const intruders = useQuery({
    queryKey: ['intruders'],
    queryFn: ({ signal }) => fetchIntruders(signal),
    refetchInterval: 5_000,
    retry: false,
  })
  const markers = useMemo(() => {
    const span = live.room
      ? Math.max(live.room.xmax - live.room.xmin, live.room.ymax - live.room.ymin)
      : 1000
    const maxDistance = Math.max((live.personScale ?? 0) * 3, span / 12)
    const common = { tracks: live.tracks, boxes: live.boxes, hinvByCameraName, maxDistance }
    const merged = trackMarkers({ ...common, detections: weapon.state, label: (c) => c })
    for (const [id, labels] of trackMarkers({
      ...common,
      detections: wanted.state,
      label: (c) => `watchlist: ${c}`,
    })) {
      merged.set(id, [...(merged.get(id) ?? []), ...labels])
    }
    for (const row of intruders.data ?? []) {
      const label = `intruder: ${row.title.replace(/^Intrusion: /, '')}`
      merged.set(row.tracking_id, [...(merged.get(row.tracking_id) ?? []), label])
    }
    return merged
  }, [
    intruders.data,
    live.tracks,
    live.boxes,
    live.room,
    live.personScale,
    hinvByCameraName,
    weapon.state,
    wanted.state,
  ])

  /* tracking_id -> ticket_number, for relabeling a dot below. Same 5s poll
     as peopleStatus - this is a monitoring label, not something that needs
     the stream's own push latency. */
  const tracked = useQuery({
    queryKey: ['tickets', 'tracked'],
    queryFn: ({ signal }) => fetchTrackedTickets(signal),
    refetchInterval: 5_000,
  })
  const ticketByTrackId = useMemo(
    () => new Map((tracked.data ?? []).map((row) => [row.tracking_id, row.ticket_number])),
    [tracked.data],
  )

  /* tracking_id -> employee full name, same 5s poll as the ticket link
     above - a second, independent monitoring label. */
  const trackedEmployees = useQuery({
    queryKey: ['employees', 'tracked'],
    queryFn: ({ signal }) => fetchTrackedEmployees(signal),
    refetchInterval: 5_000,
  })
  const employeeByTrackId = useMemo(
    () => new Map((trackedEmployees.data ?? []).map((row) => [row.tracking_id, row.full_name])),
    [trackedEmployees.data],
  )

  /* The person picked on the map, for the manual "who is this" fix. */
  const [selected, setSelected] = useState<string | null>(null)
  const selectedTrack = live.tracks.find((t) => t.id === selected) ?? null

  return (
    <Screen
      title="Live map"
      description="Every tracked person, projected onto one shared floor plan."
      actions={<StreamStatusBadge status={status} />}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile label="Phase" value={phaseLabel(live.phase)} />
        <StatTile label="Tracked now" value={String(live.tracks.length)} />
        <StatTile label="Cameras" value={String(polled.data?.cams_bootstrapped?.length ?? '—')} />
        <StatTile
          label="Room proportions"
          value={
            live.room
              ? `${((live.room.xmax - live.room.xmin) / Math.max(live.room.ymax - live.room.ymin, 1)).toFixed(2)} : 1`
              : '—'
          }
        />
      </div>

      {(polled.data?.warnings.length ?? 0) > 0 && (
        <Panel as="section" tone="alert" className="mb-4">
          <PanelBody className="flex gap-3">
            <AlertTriangle className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
            <ul className="text-ink-2 space-y-1 text-sm leading-relaxed">
              {polled.data?.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <Panel as="section">
          <PanelHeader>
            <div className="flex items-center gap-2.5">
              <Radar className="text-ink-3 size-4 shrink-0" aria-hidden />
              <h2 className="text-ink text-sm font-semibold">Floor plan</h2>
            </div>
            <p className="text-ink-3 mt-1 text-xs leading-relaxed">
              {live.phase === 'running'
                ? 'One dot per confirmed track, camera zones in yellow. Scroll to zoom, drag to move.'
                : 'Nothing to plot until tracking is running - see phase above.'}
            </p>
          </PanelHeader>
          <PanelBody className="p-0">
            <FloorPlan
              live={live}
              ticketByTrackId={ticketByTrackId}
              employeeByTrackId={employeeByTrackId}
              markers={markers}
              selected={selected}
              onSelect={setSelected}
            />
          </PanelBody>
        </Panel>

        <div className="space-y-3">
          <WhoIsThis
            key={selectedTrack?.id ?? 'none'}
            trackId={selectedTrack?.id ?? null}
            employee={selectedTrack ? (employeeByTrackId.get(selectedTrack.id) ?? null) : null}
            ticket={selectedTrack ? (ticketByTrackId.get(selectedTrack.id) ?? null) : null}
            onClose={() => setSelected(null)}
          />
          <TrackTable tracks={live.tracks} />
          <SourcesPanel />
        </div>
      </div>
    </Screen>
  )
}

function phaseLabel(phase: PeopleLiveState['phase']): string {
  switch (phase) {
    case 'idle':
      return 'Idle'
    case 'bootstrapping':
      return 'Bootstrapping…'
    case 'running':
      return 'Running'
    case 'error':
      return 'Error'
  }
}

/** Camera calibration (pixel -> floor), keyed by the AI camera NAME that
 * stream frames use. An admin with no branch open sees every branch's
 * cameras. */
function useCameraCalibrationByName(): Map<string, number[][]> {
  const { user } = useSession()
  const scope = useScope()
  const isAdmin = user?.role === 'ADMIN'
  const agencyIds = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin && !scope.agencyId,
  })
  const ids = isAdmin
    ? scope.agencyId
      ? [scope.agencyId]
      : (agencyIds.data ?? []).map((a) => a.id)
    : user?.agency_id
      ? [user.agency_id]
      : []
  const cameras = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['cameras', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchCameras(id, signal),
    })),
  })
  const calibration = useQuery({
    queryKey: ['calibration'],
    queryFn: ({ signal }) => fetchCalibration(signal),
    retry: false,
  })
  /* id:name pairs as one string, so the map below is rebuilt only when the
     cameras actually change, not on every render of a new array. */
  const cameraKey = JSON.stringify(cameras.flatMap((q) => q.data ?? []).map((c) => [c.id, c.name]))
  return useMemo(() => {
    const byId = new Map((calibration.data ?? []).map((c) => [c.camera_id, c.Hinv]))
    const out = new Map<string, number[][]>()
    for (const [id, name] of JSON.parse(cameraKey) as Array<[string, string]>) {
      const H = byId.get(id)
      if (H) out.set(name, H)
    }
    return out
  }, [calibration.data, cameraKey])
}

/** A grid spacing that gives roughly `target` lines across `span`. */
function niceStep(span: number, target = 10): number {
  const raw = span / Math.max(target, 1)
  if (!(raw > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) {
    if (m * magnitude >= raw) return m * magnitude
  }
  return 10 * magnitude
}

function applyH(H: number[][], x: number, y: number): [number, number] {
  const w = H[2][0] * x + H[2][1] * y + H[2][2]
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w]
}

interface MapZone {
  name: string
  polygon: Array<[number, number]>
}

/**
 * The camera zones, in the same floor units as the tracks. A world zone is
 * stored in metres-of-floor-units (polygon_m = units / 100, the AI service's
 * own export); a pixel zone is converted through its camera's calibration
 * when that camera has one, and left off the map when it does not.
 */
function useMapZones(): MapZone[] {
  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: ({ signal }) => fetchZones(signal),
    retry: false,
  })
  const calibration = useQuery({
    queryKey: ['calibration'],
    queryFn: ({ signal }) => fetchCalibration(signal),
    retry: false,
  })
  return useMemo(() => {
    const hinvBy = new Map((calibration.data ?? []).map((c) => [c.camera_id, c.Hinv]))
    const out: MapZone[] = []
    for (const zone of zones.data ?? []) {
      if (zone.polygon_m && zone.polygon_m.length >= 3) {
        out.push({ name: zone.name, polygon: zone.polygon_m.map(([x, y]) => [x * 100, y * 100]) })
      } else if (zone.polygon_px && zone.camera_id && hinvBy.has(zone.camera_id)) {
        const H = hinvBy.get(zone.camera_id) as number[][]
        out.push({ name: zone.name, polygon: zone.polygon_px.map(([x, y]) => applyH(H, x, y)) })
      }
    }
    return out
  }, [zones.data, calibration.data])
}

/**
 * The map itself: an SVG in floor units, each track a labelled dot, every
 * camera zone outlined. Scroll to zoom around the cursor, drag to pan.
 *
 * Floor units are the calibration's own, not metres: the AI service scales
 * the clicked rectangle so its short side is 100, whatever its real size.
 * Everything drawn here is therefore sized from the room's own span (and the
 * tracker's person_scale), never from a fixed metre value - a fixed 0.22
 * radius made every dot invisible in a room a few hundred units across.
 */
function FloorPlan({
  live,
  ticketByTrackId,
  employeeByTrackId,
  markers,
  selected,
  onSelect,
}: {
  live: PeopleLiveState
  ticketByTrackId: Map<string, string>
  employeeByTrackId: Map<string, string>
  /** track id -> what it is flagged for ("pistol", "watchlist: NAME", "intruder: ZONE"). */
  markers: Map<string, string[]>
  selected: string | null
  onSelect: (trackId: string) => void
}) {
  const zones = useMapZones()

  /* xmin/ymin/xmax/ymax - a world BOUNDING BOX, not a width/height pair.
     The view starts at xmin/ymin, not 0/0. */
  const room = useMemo(() => {
    const base = live.room ?? { xmin: 0, xmax: 1200, ymin: 0, ymax: 800 }
    /* Grow the box to include every zone and track, so nothing drawn falls
       outside the starting view. */
    const xs = [base.xmin, base.xmax, ...zones.flatMap((z) => z.polygon.map((p) => p[0]))]
    const ys = [base.ymin, base.ymax, ...zones.flatMap((z) => z.polygon.map((p) => p[1]))]
    return {
      xmin: Math.min(...xs),
      xmax: Math.max(...xs),
      ymin: Math.min(...ys),
      ymax: Math.max(...ys),
    }
  }, [live.room, zones])
  const width = Math.max(room.xmax - room.xmin, 1)
  const height = Math.max(room.ymax - room.ymin, 1)
  const span = Math.max(width, height)
  const step = niceStep(span)
  const dot = live.personScale ? live.personScale * 0.3 : span / 60

  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const box = view ?? { x: room.xmin, y: room.ymin, w: width, h: height }
  /* Text and lines are sized from what is on screen, not from the room, so
     zooming in enlarges the floor but keeps labels readable and the same
     size. Dots keep their floor size (a person's footprint), with a floor so
     they stay visible when zoomed out. */
  const onScreen = Math.max(box.w, box.h)
  const font = onScreen / 40
  const stroke = onScreen / 600
  const dotR = Math.max(dot, onScreen / 120)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const drag = useRef<{ px: number; py: number; box: typeof box } | null>(null)

  function toWorld(clientX: number, clientY: number): [number, number] | null {
    const ctm = svgRef.current?.getScreenCTM()
    if (!ctm) return null
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return [p.x, p.y]
  }

  function handleWheel(event: React.WheelEvent<SVGSVGElement>) {
    const at = toWorld(event.clientX, event.clientY)
    if (!at) return
    const factor = event.deltaY < 0 ? 1 / 1.15 : 1.15
    const w = Math.min(width * 1.5, Math.max(width / 20, box.w * factor))
    const k = w / box.w
    setView({
      x: at[0] - (at[0] - box.x) * k,
      y: at[1] - (at[1] - box.y) * k,
      w,
      h: box.h * k,
    })
  }
  function handlePointerDown(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { px: event.clientX, py: event.clientY, box }
  }
  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const start = drag.current
    const ctm = svgRef.current?.getScreenCTM()
    if (!start || !ctm) return
    setView({
      ...start.box,
      x: start.box.x - (event.clientX - start.px) / ctm.a,
      y: start.box.y - (event.clientY - start.py) / ctm.d,
    })
  }
  function handlePointerUp(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null
  }

  /* The page must not scroll while zooming the map; React's onWheel is
     passive, so the listener goes on the element directly. */
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const stop = (e: WheelEvent) => e.preventDefault()
    svg.addEventListener('wheel', stop, { passive: false })
    return () => svg.removeEventListener('wheel', stop)
  }, [live.phase])

  return (
    <div className="bg-ink/90 relative aspect-video w-full overflow-hidden">
      {live.phase !== 'running' ? (
        <div className="text-ink-3 absolute inset-0 grid place-items-center p-6 text-center text-sm">
          <div>
            <Users className="mx-auto mb-2 size-6" aria-hidden />
            {live.phase === 'idle'
              ? 'Register at least 2 calibrated, aligned cameras below to start.'
              : live.phase === 'bootstrapping'
                ? 'Bootstrapping - recovering scene geometry, a few seconds on a live source.'
                : (live.error ?? 'Tracking stopped with an error.')}
          </div>
        </div>
      ) : (
        <>
          <svg
            ref={svgRef}
            viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 h-full w-full cursor-grab touch-none active:cursor-grabbing"
            role="img"
            aria-label={`${live.tracks.length} tracked person${live.tracks.length === 1 ? '' : 's'} on the floor plan`}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {Array.from(
              { length: Math.min(200, Math.ceil(width / step) + 2) },
              (_, i) => (Math.floor(room.xmin / step) + i) * step,
            ).map((x) => (
              <line
                key={`x${x}`}
                x1={x}
                y1={room.ymin}
                x2={x}
                y2={room.ymax}
                stroke="currentColor"
                strokeWidth={stroke}
                className="text-line"
              />
            ))}
            {Array.from(
              { length: Math.min(200, Math.ceil(height / step) + 2) },
              (_, i) => (Math.floor(room.ymin / step) + i) * step,
            ).map((y) => (
              <line
                key={`y${y}`}
                x1={room.xmin}
                y1={y}
                x2={room.xmax}
                y2={y}
                stroke="currentColor"
                strokeWidth={stroke}
                className="text-line"
              />
            ))}

            {zones.map((zone) => {
              const cx = zone.polygon.reduce((a, p) => a + p[0], 0) / zone.polygon.length
              const cy = zone.polygon.reduce((a, p) => a + p[1], 0) / zone.polygon.length
              return (
                <g key={zone.name}>
                  <polygon
                    points={zone.polygon.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="rgba(250, 204, 21, 0.10)"
                    stroke="#facc15"
                    strokeWidth={stroke * 2}
                  />
                  <text
                    x={cx}
                    y={cy}
                    textAnchor="middle"
                    fontSize={font * 0.8}
                    fontFamily="system-ui, sans-serif"
                    fill="#facc15"
                    stroke="#000"
                    strokeWidth={font * 0.12}
                    paintOrder="stroke"
                  >
                    {zone.name}
                  </text>
                </g>
              )
            })}

            {live.tracks.map((track) => (
              <g
                key={track.id}
                className="cursor-pointer"
                /* Picking a person, not dragging the map: the map's own
                   pointer capture would swallow a click. */
                onPointerDown={(event) => {
                  event.stopPropagation()
                  onSelect(track.id)
                }}
              >
                {selected === track.id && (
                  <circle
                    cx={track.x}
                    cy={track.y}
                    r={dotR * 1.7}
                    fill="none"
                    stroke="#fff"
                    strokeWidth={stroke * 3}
                    strokeDasharray={`${dotR * 0.5} ${dotR * 0.35}`}
                  />
                )}
                {markers.has(track.id) && (
                  <>
                    <circle
                      cx={track.x}
                      cy={track.y}
                      r={dotR * 2}
                      fill="rgba(239, 68, 68, 0.18)"
                      stroke="#ef4444"
                      strokeWidth={stroke * 4}
                    />
                    <text
                      x={track.x + dotR * 1.4}
                      y={track.y + font * 1.1}
                      fontSize={font * 0.85}
                      fontFamily="system-ui, sans-serif"
                      fontWeight={700}
                      fill="#ef4444"
                      stroke="#000"
                      strokeWidth={font * 0.12}
                      paintOrder="stroke"
                    >
                      {(markers.get(track.id) ?? []).join(' · ')}
                    </text>
                  </>
                )}
                <circle
                  cx={track.x}
                  cy={track.y}
                  r={dotR}
                  fill="#6ea0ff"
                  stroke="#fff"
                  strokeWidth={stroke * 2}
                />
                <text
                  x={track.x + dotR * 1.4}
                  y={track.y}
                  fontSize={font}
                  fontFamily="system-ui, sans-serif"
                  fontWeight={600}
                  fill="#fff"
                  stroke="#000"
                  strokeWidth={font * 0.15}
                  paintOrder="stroke"
                >
                  {employeeByTrackId.get(track.id) ?? ticketByTrackId.get(track.id) ?? track.id}
                </text>
              </g>
            ))}
          </svg>
          {view && (
            <div className="absolute top-2 right-2">
              <Button size="sm" variant="ghost" onClick={() => setView(null)}>
                <RotateCcw className="size-3.5" aria-hidden />
                Reset view
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The manual fix for "who is this": the tracker links a person to an
 * employee when they badge, and keeps the link through a short loss of
 * view; when it still gets it wrong, a guard says who it is (or that it is
 * not staff). Every change is written to the audit log.
 */
function WhoIsThis({
  trackId,
  employee,
  ticket,
  onClose,
}: {
  trackId: string | null
  employee: string | null
  ticket: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [employeeId, setEmployeeId] = useState('')
  const roster = useQuery({
    queryKey: ['roster'],
    queryFn: ({ signal }) => fetchRoster(signal),
    staleTime: 60_000,
  })
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['employees', 'tracked'] }),
      queryClient.invalidateQueries({ queryKey: ['intruders'] }),
    ])
  const link = useMutation({
    mutationFn: (v: { employeeId: string; trackId: string }) =>
      linkEmployeeTrack(v.employeeId, v.trackId),
    onSuccess: async () => {
      setEmployeeId('')
      await refresh()
    },
  })
  const unlink = useMutation({
    mutationFn: (id: string) => unlinkTrack(id),
    onSuccess: refresh,
  })
  const error = link.error ?? unlink.error

  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">Who is this?</h2>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          {trackId === null
            ? 'Click a person on the map to say who they are, when the cameras got it wrong.'
            : `Person ${trackId}: ${employee ?? (ticket ? `ticket ${ticket}` : 'not identified')}.`}
        </p>
      </PanelHeader>
      {trackId !== null && (
        <PanelBody className="space-y-2">
          <div className="flex gap-2">
            <select
              aria-label="Employee"
              className={controlClass()}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">This is…</option>
              {(roster.data ?? []).map((row) => (
                <option key={row.employee_id} value={row.employee_id}>
                  {row.full_name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!employeeId || link.isPending}
              onClick={() => link.mutate({ employeeId, trackId })}
            >
              <UserCheck className="size-3.5" aria-hidden />
              Link
            </Button>
          </div>
          <div className="flex gap-2">
            {employee && (
              <Button
                size="sm"
                variant="secondary"
                disabled={unlink.isPending}
                onClick={() => unlink.mutate(trackId)}
              >
                <UserX className="size-3.5" aria-hidden />
                Not staff
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Done
            </Button>
          </div>
          {error != null && (
            <p role="alert" className="text-warn text-xs">
              {error instanceof ApiError ? describeApiError(error) : 'Could not save that.'}
            </p>
          )}
        </PanelBody>
      )}
    </Panel>
  )
}

function TrackTable({ tracks }: { tracks: PeopleLiveState['tracks'] }) {
  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">Raw tracks</h2>
      </PanelHeader>
      <PanelBody className="p-0">
        {tracks.length === 0 ? (
          <p className="text-ink-2 p-4 text-sm">No confirmed tracks.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-3 border-line border-b text-left text-xs">
                <th className="px-3 py-2 font-medium">id</th>
                <th className="px-3 py-2 font-medium">x</th>
                <th className="px-3 py-2 font-medium">y</th>
                <th className="px-3 py-2 font-medium">hits</th>
                <th className="px-3 py-2 font-medium">misses</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track) => (
                <tr key={track.id} className="border-line/60 border-b last:border-0">
                  <td className="text-ink px-3 py-1.5 font-medium">{track.id}</td>
                  <td className="text-ink-2 tabular px-3 py-1.5">{track.x}</td>
                  <td className="text-ink-2 tabular px-3 py-1.5">{track.y}</td>
                  <td className="text-ink-2 tabular px-3 py-1.5">{track.hits}</td>
                  <td className="text-ink-2 tabular px-3 py-1.5">{track.misses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PanelBody>
    </Panel>
  )
}

/**
 * Which cameras belong to /people's tracked scene - its OWN registry,
 * independent of zoning's (see api/endpoints/people.ts). Only calibrated,
 * aligned cameras are offered, same reasoning as Zones' world-mode picker:
 * registering an unaligned camera cannot contribute anything real.
 */
function SourcesPanel() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  /* SECURITY can see this whole screen (a monitoring view, same bucket as
     /alerts) but not edit the source registry - that's configuration, ADMIN
     and MANAGER only (mocks/roles.ts draws the same split). Checked here
     too, not just left to the write call's own 403, so a SECURITY user
     doesn't see live checkboxes that would only ever refuse them. */
  const canEditSources = user?.role === 'ADMIN' || user?.role === 'MANAGER'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })
  const [pickedAgencyId, setPickedAgencyId] = useState<string | null>(null)
  const agencyId = isAdmin
    ? (pickedAgencyId ?? scope.agencyId ?? agencies.data?.[0]?.id ?? null)
    : (user?.agency_id ?? null)

  const cameras = useQuery({
    queryKey: ['cameras', agencyId],
    queryFn: ({ signal }) => fetchCameras(agencyId as string, signal),
    enabled: agencyId !== null,
  })
  const calibration = useQuery({
    queryKey: ['calibration'],
    queryFn: ({ signal }) => fetchCalibration(signal),
  })
  const byCalibration = useMemo(
    () => new Map((calibration.data ?? []).map((entry) => [entry.camera_id, entry])),
    [calibration.data],
  )

  /* sources_known/calibrated/aligned live on GET /people/sources, NOT
     /people/status - the status endpoint's own docstring claims otherwise,
     verified wrong against the running service. */
  const sources = useQuery({
    queryKey: ['peopleSources'],
    queryFn: ({ signal }) => fetchPeopleSources(signal),
  })
  const known = new Set(sources.data?.sources_known ?? [])

  const eligible = useMemo(
    () => (cameras.data ?? []).filter((row) => byCalibration.get(row.id)?.aligned),
    [cameras.data, byCalibration],
  )

  const toggle = useMutation({
    /* Both branches return real but differently-shaped responses
       (removePeopleSource -> {camera, deleted}, registerPeopleSources ->
       PeopleSourcesUpdate) - the response itself isn't used, the query
       invalidation below is what actually refreshes the checkbox state, so
       this is typed void rather than picking one shape to lie about. */
    mutationFn: async (cameraId: string): Promise<void> => {
      if (known.has(cameraId)) await removePeopleSource(cameraId)
      else await registerPeopleSources([cameraId])
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['peopleSources'] })
      await queryClient.invalidateQueries({ queryKey: ['peopleStatus'] })
    },
  })

  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">Tracked cameras</h2>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          Needs 2 or more, calibrated and aligned, before bootstrap can start on its own.
        </p>
      </PanelHeader>
      <PanelBody>
        {isAdmin && (
          <select
            className={controlClass()}
            value={agencyId ?? ''}
            onChange={(e) => setPickedAgencyId(e.target.value || null)}
          >
            {(agencies.data ?? []).map((agency) => (
              <option key={agency.id} value={agency.id}>
                {agency.name}
              </option>
            ))}
          </select>
        )}

        {eligible.length === 0 ? (
          <p className="text-ink-2 mt-3 text-sm leading-relaxed">
            No calibrated, aligned camera in this branch yet - align one on{' '}
            <Link to="/calibration" className="text-ink-2 hover:text-accent underline">
              Calibration
            </Link>{' '}
            first.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {eligible.map((row) => (
              <li key={row.id} className="flex items-center gap-2 text-sm">
                <label className="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={known.has(row.id)}
                    disabled={!canEditSources || toggle.isPending}
                    onChange={() => toggle.mutate(row.id)}
                  />
                  <span className="text-ink-2 min-w-0 flex-1 truncate">{row.name}</span>
                </label>
                {known.has(row.id) && <Badge tone="ok">tracked</Badge>}
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  )
}
