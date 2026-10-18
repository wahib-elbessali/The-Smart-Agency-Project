import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ImageOff, Pentagon, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import { fetchCalibration } from '@/api/endpoints/calibration'
import { fetchCameraFrame, fetchCameras } from '@/api/endpoints/cameras'
import { createZone, deleteZone, fetchZones, setZoneRestriction } from '@/api/endpoints/zones'
import { ApiError, describeApiError } from '@/api/errors'
import type { Camera, CameraZone, ZoneRestriction } from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field } from '@/components/ui/Field'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import { Screen } from './Screen'

/**
 * Drawing the floor areas the detector counts people inside. Added
 * 2026-09-19, the first half of the AI/CV integration on the frontend
 * (ai/reference_ui, contracts/ai-service.md §/zoning).
 *
 * This is ai/reference_ui/zoning/zone_app.py rebuilt on this side of the
 * backend: click points on a camera's own picture, close the polygon, name
 * it. The reference app is the interaction reference, not the surface - it
 * is a local Flask page that talks to the unauthenticated AI service
 * directly, which this dashboard must never do (project rule, 2026-08-11).
 * Everything here goes through PROPOSED backend proxies; see
 * api/endpoints/zones.ts and BACKEND-ASKS.md §8.
 *
 * WHY THIS SCREEN MATTERS TO THE ONE NEXT TO IT
 *
 * The Occupancy screen reads counts per zone from the AI service's stream.
 * Until now nothing in this application could create a zone, so that screen
 * could only ever report on zones somebody had drawn with the AI service's
 * own tools. This is where they come from.
 *
 * PIXEL AND WORLD MODE
 *
 * The AI service infers a zone's mode from how many cameras it is saved
 * with: one camera is `pixel` - counted against that camera's own raw
 * detections, no calibration anywhere - and two or more is `world`, fused
 * across every camera picked via their shared floor frame, which requires
 * the drawn-on camera (and every other one fused with it) to be calibrated
 * AND aligned or it answers 422. World mode used to be left out on the
 * reasoning that offering it before calibration existed would offer a
 * button whose only outcome was a refusal - calibration is real now (see
 * the Calibration screen), so this screen builds both.
 *
 * THE PICTURE PLAYS UNTIL YOU CLICK, THEN HOLDS STILL
 *
 * The frame is the paper being drawn on: if it kept refreshing under a
 * half-finished polygon, the points would still be in the right pixels but
 * the room beneath them would have walked away. So the first click freezes
 * it, and clearing the points lets it play again.
 *
 * Freezing it BEFORE the first click, which is what this did originally,
 * buys nothing and costs the only thing that makes a camera legible - being
 * able to see it move. Someone drawing a queue area wants to watch the
 * queue for a few seconds first.
 *
 * KEYBOARD
 *
 * Placing a point is a pointer act and there is no honest keyboard
 * equivalent - "arrow keys to nudge a crosshair" would be a worse tool
 * pretending to be an accessible one. What is keyboard-reachable is
 * everything around it: the pickers, undo, clear, save, delete, and a live
 * region that announces each point as it lands, so the polygon's state is
 * legible without seeing the canvas. Said plainly here rather than left for
 * someone to discover.
 */

type Point = [number, number]

/* The live view's cadence, which matches the detectors' update_interval. */
const FRAME_MS = 2_000

export default function Zones() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'

  const agencies = useQuery({
    queryKey: ['agencies'],
    queryFn: ({ signal }) => fetchAgencies(signal),
    enabled: isAdmin,
  })

  /* The shared branch scope every screen now reads (UX_AUDIT.md finding 2) -
     picking one below calls scope.enter(), same as Services and Cameras.
     Falls back to the first branch only until the admin has chosen one.
     Everyone else has exactly one agency. */
  const agencyId = isAdmin
    ? (scope.agencyId ?? agencies.data?.[0]?.id ?? null)
    : (user?.agency_id ?? null)

  const cameras = useQuery({
    queryKey: ['cameras', agencyId],
    queryFn: ({ signal }) => fetchCameras(agencyId as string, signal),
    enabled: agencyId !== null,
  })

  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: ({ signal }) => fetchZones(signal),
  })

  /* World mode needs to know which cameras are calibrated AND aligned - a
     zone drawn across cameras that don't share a floor frame would look
     valid and read silently wrong (ai/features/zoning/api.py's own
     reasoning for refusing it). Fetched without an agency filter, same as
     the Calibration screen, because calibration itself has no notion of
     agency at all - but `worldEligible` below still only offers cameras
     from `cameraRows`, the currently selected branch, same as the pixel
     camera picker. Not a technical limit (the backend scope check covers
     any camera the caller may touch, branch by branch), a deliberate one:
     fusing cameras across two different branches into one zone is an edge
     case this pass doesn't build UI for, not assumed to be wanted. */
  const calibration = useQuery({
    queryKey: ['calibration'],
    queryFn: ({ signal }) => fetchCalibration(signal),
  })
  const byCalibration = useMemo(
    () => new Map((calibration.data ?? []).map((entry) => [entry.camera_id, entry])),
    [calibration.data],
  )

  const cameraRows = useMemo(
    () => [...(cameras.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [cameras.data],
  )

  const [pickedCameraId, setPickedCameraId] = useState<string | null>(null)
  const camera: Camera | null =
    cameraRows.find((c) => c.id === pickedCameraId) ?? cameraRows[0] ?? null

  /**
   * PIXEL (this camera's own detections, no calibration) or WORLD (fused
   * across 2+ calibrated+aligned cameras, floor metres). Never sent as a
   * flag - the AI service infers it from how many cameras the request
   * names, exactly mirrored by `extraCameraIds.length > 0` below.
   */
  const [drawMode, setDrawMode] = useState<'pixel' | 'world'>('pixel')
  /* Every OTHER camera (besides the one being drawn on) this zone should be
     fused across, world mode only. */
  const [extraCameraIds, setExtraCameraIds] = useState<string[]>([])

  /* Cameras eligible for world mode, site-wide (not just this branch - see
     the calibration query above). Excludes whichever camera is currently
     selected to draw on, since that one is implied. */
  const worldEligible = useMemo(
    () => cameraRows.filter((row) => row.id !== camera?.id && byCalibration.get(row.id)?.aligned),
    [cameraRows, camera?.id, byCalibration],
  )

  /* World mode's own drawn-on camera also has to be aligned - the same
     refusal ai/features/zoning/api.py's _to_world enforces, checked here so
     the screen can say why up front instead of a save-time 422. */
  const cameraWorldReady = camera !== null && byCalibration.get(camera.id)?.aligned === true
  const closeDisabledReason: string | undefined =
    drawMode !== 'world'
      ? undefined
      : !cameraWorldReady
        ? `${camera?.name ?? 'This camera'} is not calibrated and aligned yet - a world zone needs the drawn-on camera aligned to the shared floor frame first. Align it on the Calibration screen, or draw a pixel zone instead.`
        : extraCameraIds.length === 0
          ? 'Pick at least one other camera below to fuse this zone across - that is what makes it a world zone.'
          : undefined

  /* Points are in the frame's own pixels, which is what the AI service
     stores and what a later frame of the same camera can be redrawn with. */
  const [points, setPoints] = useState<Point[]>([])
  const [naming, setNaming] = useState(false)

  /* Switching camera, branch or mode abandons the polygon rather than
     carrying it over: the same coordinates mean a different place on a
     different camera, and silently moving someone's work is worse than
     dropping it. Also clears which extra cameras were picked - a set that
     made sense for the last drawn-on camera may not for this one. */
  useEffect(() => {
    setPoints([])
    setExtraCameraIds([])
  }, [camera?.id, drawMode])

  const save = useMutation({
    mutationFn: (name: string) =>
      createZone({
        name,
        camera_id: camera?.id as string,
        polygon: points,
        extra_camera_ids: drawMode === 'world' ? extraCameraIds : undefined,
      }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['zones'] })
      setPoints([])
      setExtraCameraIds([])
      setNaming(false)
      setLastSaved(saved.warnings.length > 0 ? saved.warnings : null)
    },
  })

  /* Warnings from the AI service, passed through by the proxy. Kept on
     screen after the dialog closes because they describe the zone that was
     just saved, not the act of saving it. */
  const [lastSaved, setLastSaved] = useState<string[] | null>(null)

  const remove = useMutation({
    mutationFn: (zone: CameraZone) => deleteZone(zone.name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['zones'] })
    },
  })

  /* Who may stand in a world zone; someone not allowed opens an intrusion alert. */
  const [restrictWarnings, setRestrictWarnings] = useState<string[]>([])
  const restrict = useMutation({
    mutationFn: (v: { name: string; restriction: ZoneRestriction }) =>
      setZoneRestriction(v.name, v.restriction),
    onSuccess: async (saved) => {
      setRestrictWarnings(saved.warnings ?? [])
      await queryClient.invalidateQueries({ queryKey: ['zones'] })
    },
  })

  const zonesHere = useMemo(
    () =>
      (zones.data ?? [])
        .filter((zone) => zone.camera_id === camera?.id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [zones.data, camera?.id],
  )
  /* Excludes both null-camera cases below (orphans and world zones) - those
     are not "on another camera", they are on no single camera at all, and
     counting them here would tell an admin to go look for them somewhere
     they can never be found. */
  const zonesElsewhere = useMemo(
    () =>
      (zones.data ?? []).filter((zone) => zone.camera_id !== null && zone.camera_id !== camera?.id)
        .length,
    [zones.data, camera?.id],
  )

  /* A PIXEL zone the backend could not match to any camera - e.g. the AI
     service's camera got renamed after the zone was drawn. Not the same
     thing as a world zone (below): this one is broken, camera_id is null
     because something went wrong, not because the mode never had one.
     zonesHere filters strictly on camera_id === camera?.id, so an orphan is
     never listed or deletable under any camera selection unless it gets its
     own section here. Admin-only: exactly the kind of cross-branch leftover
     a non-admin has no standing to act on. */
  const orphanZones = useMemo(
    () => (zones.data ?? []).filter((zone) => zone.mode === 'pixel' && zone.camera_id === null),
    [zones.data],
  )

  /* World zones ALWAYS have camera_id: null, by design - see CameraZone's
     doc comment. Shown in their own always-visible section, everyone who
     can see zones at all (not admin-only like orphans, since this is the
     expected shape of a real zone, not a leftover to clean up). */
  const worldZones = useMemo(
    () => (zones.data ?? []).filter((zone) => zone.mode === 'world'),
    [zones.data],
  )

  const existingNames = useMemo(
    () => new Set((zones.data ?? []).map((zone) => zone.name)),
    [zones.data],
  )

  return (
    <Screen
      title="Zones"
      description="The floor areas the detector counts people inside, drawn on the camera that watches them."
    >
      <div className="mb-4 flex flex-wrap gap-3">
        {isAdmin && (
          <div className="max-w-xs flex-1">
            <label
              htmlFor="zones_agency"
              className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
            >
              Branch
            </label>
            <select
              id="zones_agency"
              className={controlClass()}
              value={agencyId ?? ''}
              onChange={(e) => {
                const agency = (agencies.data ?? []).find((a) => a.id === e.target.value)
                if (agency) scope.enter(agency)
                setPickedCameraId(null)
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

        {cameraRows.length > 0 && (
          <div className="max-w-xs flex-1">
            <label
              htmlFor="zones_camera"
              className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
            >
              Camera
            </label>
            <select
              id="zones_camera"
              className={controlClass()}
              value={camera?.id ?? ''}
              onChange={(e) => setPickedCameraId(e.target.value || null)}
            >
              {cameraRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <span className="text-ink-3 tracked mb-2 block text-[11px] font-medium">Mode</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={drawMode === 'pixel' ? 'primary' : 'secondary'}
              onClick={() => setDrawMode('pixel')}
            >
              Pixel
            </Button>
            <Button
              size="sm"
              variant={drawMode === 'world' ? 'primary' : 'secondary'}
              onClick={() => setDrawMode('world')}
            >
              World
            </Button>
          </div>
        </div>
      </div>

      <AsyncBoundary
        isPending={cameras.isPending}
        error={cameras.error}
        isEmpty={cameraRows.length === 0}
        emptyMessage="No cameras in this branch yet. A zone is drawn on a camera's own picture, so register one first."
        forbiddenMessage="Zones are drawn by administrators and managers. Ask an administrator if you need access."
        onRetry={() => void cameras.refetch()}
        skeletonRows={3}
      >
        {camera && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
            <Drawing
              /* Forces a full remount on camera switch, so a stale frame,
                 stale blob URL and stale `size` (the SVG's coordinate
                 space) cannot briefly outlive the camera they belong to.
                 Without this, placeholderData keeps showing the outgoing
                 camera's frame at its own natural size until the new one
                 loads, and a click during that window records a point
                 against the wrong camera's geometry. */
              key={camera.id}
              camera={camera}
              points={points}
              zones={zonesHere}
              drawing={points.length > 0}
              onAddPoint={(point) => setPoints((current) => [...current, point])}
              onUndo={() => setPoints((current) => current.slice(0, -1))}
              onClear={() => setPoints([])}
              onClose={() => setNaming(true)}
              closeDisabledReason={closeDisabledReason}
            />

            <div className="space-y-3">
              {drawMode === 'world' && (
                <Panel as="section">
                  <PanelHeader>
                    <h2 className="text-ink text-sm font-semibold">Fuse with</h2>
                    <p className="text-ink-3 mt-1 text-xs leading-relaxed">
                      Every camera checked here, plus {camera?.name ?? 'the drawn-on camera'}, will
                      share this zone's floor-metre polygon. Only cameras calibrated AND aligned to
                      the shared frame are selectable.
                    </p>
                  </PanelHeader>
                  <PanelBody>
                    {!cameraWorldReady ? (
                      <p className="text-ink-2 flex gap-2 text-sm leading-relaxed">
                        <AlertTriangle className="text-ink-3 mt-0.5 size-4 shrink-0" aria-hidden />
                        Pick an aligned camera above to draw on before choosing others to fuse it
                        with.
                      </p>
                    ) : worldEligible.length === 0 ? (
                      <p className="text-ink-2 text-sm leading-relaxed">
                        No other camera is calibrated and aligned yet. A world zone needs at least
                        one more - align another camera on the Calibration screen first.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {worldEligible.map((row) => (
                          <li key={row.id} className="flex items-center gap-2 text-sm">
                            <label className="flex flex-1 items-center gap-2">
                              <input
                                type="checkbox"
                                checked={extraCameraIds.includes(row.id)}
                                onChange={(e) =>
                                  setExtraCameraIds((current) =>
                                    e.target.checked
                                      ? [...current, row.id]
                                      : current.filter((id) => id !== row.id),
                                  )
                                }
                              />
                              <span className="text-ink-2 min-w-0 flex-1 truncate">{row.name}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </PanelBody>
                </Panel>
              )}

              {lastSaved && (
                <Panel as="section" tone="alert">
                  <PanelBody>
                    <h2 className="text-warn text-sm font-semibold">Saved, with a warning</h2>
                    <ul className="text-ink-2 mt-2 space-y-1 text-sm leading-relaxed">
                      {lastSaved.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </PanelBody>
                </Panel>
              )}

              <Panel as="section">
                <PanelHeader>
                  <h2 className="text-ink text-sm font-semibold">Zones on {camera.name}</h2>
                  <p className="text-ink-3 mt-1 text-xs">
                    {zonesElsewhere > 0
                      ? `${zonesElsewhere} more on other cameras.`
                      : 'Every zone this branch has is on this camera.'}
                  </p>
                </PanelHeader>
                <PanelBody>
                  {zones.isPending ? (
                    <p className="text-ink-3 text-sm">Loading zones…</p>
                  ) : zones.error ? (
                    <p className="text-ink-2 text-sm">
                      {zones.error instanceof ApiError
                        ? describeApiError(zones.error)
                        : 'Could not read the zones.'}
                    </p>
                  ) : zonesHere.length === 0 ? (
                    <p className="text-ink-2 text-sm leading-relaxed">
                      Nothing drawn on this camera yet. Click three or more points on the picture to
                      trace an area.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {zonesHere.map((zone) => (
                        <ZoneRow
                          key={zone.name}
                          zone={zone}
                          disabled={remove.isPending}
                          onDelete={() => remove.mutate(zone)}
                        />
                      ))}
                    </ul>
                  )}

                  {remove.error != null && (
                    <p
                      role="alert"
                      className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm"
                    >
                      {remove.error instanceof ApiError
                        ? describeApiError(remove.error)
                        : 'Could not delete that zone.'}
                    </p>
                  )}
                </PanelBody>
              </Panel>

              {worldZones.length > 0 && (
                <Panel as="section">
                  <PanelHeader>
                    <h2 className="text-ink text-sm font-semibold">
                      World zones ({worldZones.length})
                    </h2>
                    <p className="text-ink-3 mt-1 text-xs leading-relaxed">
                      Fused across several cameras, on the shared floor frame rather than any one
                      camera's picture - shown here regardless of which camera is picked above,
                      since a world zone genuinely belongs to none of them alone.
                    </p>
                  </PanelHeader>
                  <PanelBody>
                    <ul className="space-y-2">
                      {worldZones.map((zone) => (
                        <ZoneRow
                          key={zone.name}
                          zone={zone}
                          disabled={remove.isPending}
                          onDelete={() => remove.mutate(zone)}
                          restricting={restrict.isPending && restrict.variables?.name === zone.name}
                          onRestrict={(restriction) =>
                            restrict.mutate({ name: zone.name, restriction })
                          }
                          note={
                            zone.converted_from
                              ? `Drawn from ${zone.converted_from.camera}.`
                              : undefined
                          }
                        />
                      ))}
                    </ul>
                    <p className="text-ink-3 mt-3 text-xs leading-relaxed">
                      "Who may be here": with Staff only, anyone the cameras have not linked to an
                      employee (a badge at the gate links them) who stays more than a few seconds
                      raises an intrusion alert; with Nobody, anyone at all does. Only world zones
                      can be watched.
                    </p>
                    {restrictWarnings.map((warning) => (
                      <p key={warning} role="alert" className="text-warn mt-2 text-xs">
                        {warning}
                      </p>
                    ))}
                    {restrict.error != null && (
                      <p role="alert" className="text-warn mt-2 text-xs">
                        {restrict.error instanceof ApiError
                          ? describeApiError(restrict.error)
                          : 'Could not save who may be here.'}
                      </p>
                    )}
                  </PanelBody>
                </Panel>
              )}

              {isAdmin && orphanZones.length > 0 && (
                <Panel as="section" tone="alert">
                  <PanelHeader>
                    <h2 className="text-warn text-sm font-semibold">
                      Zones on no camera ({orphanZones.length})
                    </h2>
                    <p className="text-ink-3 mt-1 text-xs leading-relaxed">
                      The backend could not match these to any registered camera - most likely one
                      got renamed or removed on the AI service's side after the zone was drawn.
                      Shown here regardless of which camera is picked above, since there is no
                      camera to pick that would surface them otherwise.
                    </p>
                  </PanelHeader>
                  <PanelBody>
                    <ul className="space-y-2">
                      {orphanZones.map((zone) => (
                        <ZoneRow
                          key={zone.name}
                          zone={zone}
                          disabled={remove.isPending}
                          onDelete={() => remove.mutate(zone)}
                        />
                      ))}
                    </ul>
                  </PanelBody>
                </Panel>
              )}

              <Panel as="section">
                <PanelBody>
                  <h2 className="text-ink text-sm font-semibold">How a zone is counted</h2>
                  {drawMode === 'pixel' ? (
                    <p className="text-ink-2 mt-2 text-sm leading-relaxed">
                      A person counts when their feet land inside the outline, checked against this
                      camera's own detections. Nothing is measured in metres and no calibration is
                      involved, so a zone here cannot disagree with another camera — it simply does
                      not know about one.
                    </p>
                  ) : (
                    <p className="text-ink-2 mt-2 text-sm leading-relaxed">
                      Counted against person tracking's own live floor positions, fused across every
                      camera picked - not this camera's raw detections alone. Reads 0 until tracking
                      is actually running on the same cameras, which this screen warns about after
                      saving rather than silently.
                    </p>
                  )}
                </PanelBody>
              </Panel>
            </div>
          </div>
        )}
      </AsyncBoundary>

      <Dialog
        open={naming}
        title="Name this zone"
        description="The name is how the occupancy feed reports it."
        onClose={() => {
          setNaming(false)
          save.reset()
        }}
      >
        {naming && (
          <NameForm
            points={points.length}
            existingNames={existingNames}
            pending={save.isPending}
            error={save.error}
            onCancel={() => {
              setNaming(false)
              save.reset()
            }}
            onSubmit={(name) => save.mutate(name)}
          />
        )}
      </Dialog>
    </Screen>
  )
}

/** One zone in a list, with its mode/point-count badges and a delete button.
 * Shared by the current camera's zone list and the orphan-zone panel, which
 * are otherwise identical rows over a differently-filtered list. */
function ZoneRow({
  zone,
  disabled,
  onDelete,
  note,
  restricting,
  onRestrict,
}: {
  zone: CameraZone
  disabled?: boolean
  onDelete: () => void
  /** e.g. "Drawn from {camera}" for a world zone with converted_from. */
  note?: string
  restricting?: boolean
  /** World zones only: who may stand in it. */
  onRestrict?: (restriction: ZoneRestriction) => void
}) {
  return (
    <li className="border-line bg-panel-2 rounded-lg border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">{zone.name}</span>
        {/* Read, not assumed: a world zone drawn with the AI service's own
            tools counts against the shared floor frame, not this picture. */}
        <Badge tone={zone.mode === 'world' ? 'info' : 'neutral'}>{zone.mode}</Badge>
        <span className="text-ink-3 tabular text-xs">
          {zone.polygon_px?.length ?? zone.polygon_m?.length ?? 0} pts
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delete ${zone.name}`}
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
      {note && <p className="text-ink-3 mt-1 text-xs">{note}</p>}
      {onRestrict && (
        <label className="text-ink-2 mt-2 flex items-center gap-2 text-xs">
          Who may be here
          <span className="w-36">
            <select
              aria-label={`Who may be in ${zone.name}`}
              className={controlClass()}
              value={zone.restriction ?? 'anyone'}
              disabled={restricting}
              onChange={(e) => onRestrict(e.target.value as ZoneRestriction)}
            >
              <option value="anyone">Anyone</option>
              <option value="staff">Staff only</option>
              <option value="nobody">Nobody</option>
            </select>
          </span>
          {zone.restriction && zone.restriction !== 'anyone' && <Badge tone="warn">Watched</Badge>}
        </label>
      )}
    </li>
  )
}

/**
 * The picture, the polygon over it, and the three controls that change it.
 *
 * The overlay is an <svg> with viewBox set to the frame's natural size, laid
 * over the <img> with the same object-fit - the same arrangement CameraView
 * uses for detection boxes, for the same reason: every coordinate stays in
 * source pixels and no scaling arithmetic is written by hand. Clicks come
 * back the other way through getScreenCTM().inverse(), which accounts for
 * the letterboxing that object-contain introduces at any other aspect ratio.
 */
function Drawing({
  camera,
  points,
  zones,
  drawing,
  onAddPoint,
  onUndo,
  onClear,
  onClose,
  closeDisabledReason,
}: {
  camera: Camera
  points: Point[]
  zones: CameraZone[]
  drawing: boolean
  onAddPoint: (point: Point) => void
  onUndo: () => void
  onClear: () => void
  onClose: () => void
  /** World mode: no eligible extra camera picked yet. Overrides the normal
   * "3 points needed" status line with why closing is blocked instead. */
  closeDisabledReason?: string
}) {
  /* Plays until the first point of a polygon lands, then holds still: the
     points are in frame pixels, so a picture that kept moving would leave a
     half-drawn zone tracing a room that has walked away. Clearing the points
     lets it play again. Same rule as the calibration canvases. */
  const frame = useQuery({
    queryKey: ['cameraFrame', camera.id],
    queryFn: ({ signal }) => fetchCameraFrame(camera.id, signal),
    retry: false,
    refetchInterval: drawing ? false : FRAME_MS,
    placeholderData: (previous) => previous,
    gcTime: 0,
  })

  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!frame.data) return
    const url = URL.createObjectURL(frame.data)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [frame.data])

  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const noFrame = frame.isError
  const unavailable =
    frame.error instanceof ApiError && frame.error.status === 404
      ? `The detector cannot open ${camera.name}’s stream, so there is no picture to draw on.`
      : 'Could not fetch a picture from this camera.'

  function handleClick(event: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    onAddPoint([Math.round(point.x), Math.round(point.y)])
  }

  return (
    <Panel as="section">
      <PanelHeader
        action={
          <Button
            size="sm"
            variant="ghost"
            /* Refetching under a half-drawn polygon would leave the points
               in the right pixels over a room that has moved. */
            disabled={drawing || frame.isFetching}
            onClick={() => void frame.refetch()}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {frame.isFetching ? 'Refreshing…' : 'Refresh picture'}
          </Button>
        }
      >
        <div className="flex items-center gap-2">
          <Pentagon className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink truncate text-sm font-semibold">{camera.name}</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          Click three or more points to trace an area. The dashed edge is the side that closes it.
        </p>
        <p className="text-ink-3 mt-1 text-xs">
          {drawing
            ? 'Held still while you draw — clear the points to let it play again.'
            : 'Playing. It freezes as soon as you place a point.'}
        </p>
      </PanelHeader>

      <PanelBody flush>
        <div className="bg-ink/90 relative aspect-video w-full overflow-hidden">
          {src && !noFrame ? (
            <img
              src={src}
              alt={`Current frame from ${camera.name}`}
              className="absolute inset-0 h-full w-full object-contain"
              onLoad={(e) =>
                setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
            />
          ) : (
            <div className="text-ink-3 absolute inset-0 grid place-items-center p-6 text-center text-sm">
              <div>
                <ImageOff className="mx-auto mb-2 size-6" aria-hidden />
                {noFrame ? unavailable : 'Waiting for the picture…'}
              </div>
            </div>
          )}

          {size && !noFrame && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${size.w} ${size.h}`}
              preserveAspectRatio="xMidYMid meet"
              className="absolute inset-0 h-full w-full cursor-crosshair"
              onClick={handleClick}
              role="presentation"
            >
              {/* Zones already saved on this camera, so a new one can be
                  drawn next to them rather than blindly on top. */}
              {zones.map((zone) =>
                zone.polygon_px && zone.polygon_px.length > 2 ? (
                  <polygon
                    key={zone.name}
                    points={zone.polygon_px.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="rgba(110, 160, 255, 0.12)"
                    stroke="#6ea0ff"
                    strokeWidth={Math.max(2, Math.round(size.w / 480))}
                  />
                ) : null,
              )}

              <Outline points={points} width={size.w} />
            </svg>
          )}
        </div>
      </PanelBody>

      <PanelBody>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={points.length === 0} onClick={onUndo}>
            <Undo2 className="size-3.5" aria-hidden />
            Undo last point
          </Button>
          <Button size="sm" disabled={points.length === 0} onClick={onClear}>
            Clear
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={points.length < 3 || closeDisabledReason !== undefined}
            onClick={onClose}
          >
            Close zone
          </Button>
          {/* The polygon's state in words, for anyone not reading the
              picture - and announced as it changes. */}
          <p role="status" aria-live="polite" className="text-ink-3 text-xs">
            {points.length >= 3 && closeDisabledReason
              ? closeDisabledReason
              : points.length === 0
                ? 'No points yet.'
                : points.length < 3
                  ? `${points.length} point${points.length === 1 ? '' : 's'} — at least 3 needed.`
                  : `${points.length} points, last at ${points[points.length - 1][0]}, ${points[points.length - 1][1]}.`}
          </p>
        </div>
      </PanelBody>
    </Panel>
  )
}

/** The polygon being drawn: solid where it was clicked, dashed where it will close. */
function Outline({ points, width }: { points: Point[]; width: number }) {
  if (points.length === 0) return null
  const stroke = Math.max(2, Math.round(width / 480))
  const [firstX, firstY] = points[0]
  const [lastX, lastY] = points[points.length - 1]

  return (
    <g>
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(' ')}
        fill={points.length > 2 ? 'rgba(255, 153, 0, 0.12)' : 'none'}
        stroke="#ff9900"
        strokeWidth={stroke}
      />
      {points.length > 2 && (
        <line
          x1={lastX}
          y1={lastY}
          x2={firstX}
          y2={firstY}
          stroke="#ffcc66"
          strokeWidth={stroke}
          strokeDasharray={`${stroke * 4} ${stroke * 4}`}
        />
      )}
      {points.map(([x, y], i) => (
        <circle
          key={`${x}-${y}-${i}`}
          cx={x}
          cy={y}
          r={i === 0 ? stroke * 3 : stroke * 2}
          fill={i === 0 ? '#4ade80' : '#ff9900'}
        />
      ))}
    </g>
  )
}

/**
 * Naming is a dialog rather than the reference app's window.prompt(): a
 * prompt cannot say that the name is already taken, and here that is not a
 * validation error but a destructive one - the AI service REPLACES a zone
 * whose name is re-posted, mode and all. So the collision is said out loud
 * before the button is pressed, and the button changes its word.
 *
 * `existingNames` can only ever be what the CURRENT branch's zone list
 * contains - the AI service's zone store is flat and name-keyed across
 * every branch, but a non-admin cannot see another branch's zones at all,
 * and even an admin only has one branch loaded at a time (see the branch
 * picker above). So a clean check here does not mean the name is actually
 * free site-wide, it means it is free in what this screen can see. Saying
 * so permanently, not only when a collision happens to be visible, is the
 * honest version of this warning until the backend enforces uniqueness
 * itself and returns a real conflict - see the fix list, this is a known
 * gap, not an oversight.
 */
function NameForm({
  points,
  existingNames,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  points: number
  existingNames: Set<string>
  pending: boolean
  error: unknown
  onCancel: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const replacing = trimmed.length > 0 && existingNames.has(trimmed)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (trimmed.length === 0) return
    onSubmit(trimmed)
  }

  return (
    <form onSubmit={handleSubmit}>
      <p className="text-ink-2 mb-4 text-sm leading-relaxed">
        {points} points, closed back to the first one.
      </p>

      <Field
        id="zone_name"
        label="Name"
        required
        hint={replacing ? undefined : 'How the occupancy feed will report this area.'}
      >
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

      {replacing ? (
        <p className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm leading-relaxed">
          A zone called <span className="font-medium">{trimmed}</span> already exists. Saving
          replaces its outline — there is no second copy and no undo.
        </p>
      ) : (
        <p className="text-ink-3 mt-4 text-xs leading-relaxed">
          Not used on this branch's own zone list, but zone names are shared across every branch. A
          same-named zone on another branch, invisible from here, would still be silently replaced.
        </p>
      )}

      {error != null && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn mt-4 rounded-lg border p-3 text-sm"
        >
          {error instanceof ApiError ? describeApiError(error) : 'Could not save this zone.'}
        </p>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || trimmed.length === 0}>
          {pending ? 'Saving…' : replacing ? 'Replace zone' : 'Save zone'}
        </Button>
      </div>
    </form>
  )
}
