import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import {
  AlertTriangle,
  DoorOpen,
  Grid3x3,
  ImageOff,
  Ruler,
  ScanSearch,
  Trash2,
  Undo2,
} from 'lucide-react'
import { fetchAgencies } from '@/api/endpoints/agencies'
import {
  alignCameras,
  calibrateRect,
  clearGates,
  crossCheckCameras,
  deleteCalibration,
  fetchCalibration,
  fetchGates,
  saveGates,
} from '@/api/endpoints/calibration'
import { fetchCameras, fetchNativeFrame } from '@/api/endpoints/cameras'
import { ApiError, describeApiError } from '@/api/errors'
import type {
  AlignResult,
  Camera,
  CameraCalibration,
  CrossCheckResult,
  Gate,
  SharedPoint,
} from '@/api/types'
import { useScope } from '@/agency/ScopeContext'
import { useSession } from '@/auth/SessionContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { controlClass } from '@/components/ui/control'
import BevMode from './CalibrationBev'
import { Screen } from './Screen'

/**
 * Site calibration: teaching the cameras where the floor is. Added
 * 2026-09-20, from ai/reference_ui/calibration rebuilt on this side of the
 * backend (contracts/ai-service.md §/calibration, proxies in
 * BACKEND-ASKS.md §8b).
 *
 * WHAT IT IS FOR, since nothing on this screen is visible in the product:
 * a pixel is not a place. One camera's "that person is at (410, 620)" means
 * nothing to another camera, and nothing at all in metres. Calibration turns
 * pixels into floor positions; alignment makes every camera agree on the
 * same floor. World-mode zones and person tracking are built on it, and
 * neither can exist until this is done once per site.
 *
 * TWO STEPS, AND THE SECOND IS NOT OPTIONAL
 *
 * 1. CALIBRATE one camera: click 4 points around something that is a right
 *    angle in real life. No measuring, no numbers - the rectangle's true
 *    proportions are inferred from the perspective in those 4 points.
 * 2. ALIGN the cameras: click the same real spot in two or more of them,
 *    record it, repeat. Until this runs, every camera has invented its own
 *    private coordinate system and two cameras can each look perfect while
 *    disagreeing by metres about where the same person is standing.
 *
 * THE REPROJECTION ERROR IS A TRAP AND IS NOT SHOWN AS ACCURACY
 *
 * A 4-point fit is exact by construction, so `px_err` comes back ~0 whether
 * or not the clicked shape really was a right angle. The contract says so
 * outright. Showing it as a score would teach people to trust a calibration
 * that may be badly wrong. What IS worth reading is `aspect_confident`:
 * false means the geometry was too degenerate to infer the shape and a
 * square was guessed, and that is surfaced loudly.
 *
 * Cross-check, entry gates and the bird's-eye overlay are all here now too
 * (see CalibrationBev.tsx for the BEV mode specifically) - each was, at
 * different points, listed here as deliberately left out, until checking
 * showed the feature or its dependency was real and just unbuilt.
 *
 * KEYBOARD: placing a point is a pointer act, as on the Zones screen. Every
 * control around it is reachable, and a live region reads out each point as
 * it lands.
 */

type Point = [number, number]
type Mode = 'calibrate' | 'align' | 'cross_check' | 'gates' | 'bev'

/* Matches the live view's cadence, which matches the detectors' own
   update_interval (ai-service.md GET /config) - polling faster would fetch
   the same frame twice. */
const FRAME_MS = 2_000

export default function Calibration() {
  const { user } = useSession()
  const scope = useScope()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'

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

  const cameraRows = useMemo(
    () => [...(cameras.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [cameras.data],
  )
  const byCamera = useMemo(
    () => new Map((calibration.data ?? []).map((entry) => [entry.camera_id, entry])),
    [calibration.data],
  )

  const [mode, setMode] = useState<Mode>('calibrate')

  return (
    <Screen
      title="Calibration"
      description="Teaching the cameras where the floor is, so they can agree on where somebody is standing."
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {isAdmin && (
          <div className="max-w-xs flex-1">
            <label
              htmlFor="calibration_agency"
              className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
            >
              Branch
            </label>
            <select
              id="calibration_agency"
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
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={mode === 'calibrate' ? 'primary' : 'secondary'}
            onClick={() => setMode('calibrate')}
          >
            1. Calibrate a camera
          </Button>
          <Button
            size="sm"
            variant={mode === 'align' ? 'primary' : 'secondary'}
            onClick={() => setMode('align')}
          >
            2. Align the cameras
          </Button>
          <Button
            size="sm"
            variant={mode === 'cross_check' ? 'primary' : 'secondary'}
            onClick={() => setMode('cross_check')}
          >
            <ScanSearch className="size-3.5" aria-hidden />
            Cross-check
          </Button>
          <Button
            size="sm"
            variant={mode === 'gates' ? 'primary' : 'secondary'}
            onClick={() => setMode('gates')}
          >
            <DoorOpen className="size-3.5" aria-hidden />
            Entry gates
          </Button>
          <Button
            size="sm"
            variant={mode === 'bev' ? 'primary' : 'secondary'}
            onClick={() => setMode('bev')}
          >
            <Grid3x3 className="size-3.5" aria-hidden />
            Bird's-eye view
          </Button>
        </div>
      </div>

      <AsyncBoundary
        isPending={cameras.isPending}
        error={cameras.error}
        isEmpty={cameraRows.length === 0}
        emptyMessage="No cameras in this branch yet. Calibration is per camera, so register one first."
        forbiddenMessage="Calibration is done by administrators and managers. Ask an administrator if you need access."
        onRetry={() => void cameras.refetch()}
        skeletonRows={3}
      >
        {mode === 'calibrate' && (
          <CalibrateMode
            cameras={cameraRows}
            byCamera={byCamera}
            onSaved={() => void queryClient.invalidateQueries({ queryKey: ['calibration'] })}
          />
        )}
        {mode === 'align' && (
          <AlignMode
            cameras={cameraRows}
            byCamera={byCamera}
            onAligned={() => void queryClient.invalidateQueries({ queryKey: ['calibration'] })}
          />
        )}
        {mode === 'cross_check' && <CrossCheckMode cameras={cameraRows} byCamera={byCamera} />}
        {mode === 'gates' && <GatesMode cameras={cameraRows} byCamera={byCamera} />}
        {mode === 'bev' && <BevMode cameras={cameraRows} byCamera={byCamera} />}
      </AsyncBoundary>

      {/* Where this actually gets used, for anyone wondering why they are
          clicking floor tiles. */}
      <p className="text-ink-3 mt-4 text-xs leading-relaxed">
        Zones spanning several cameras and person tracking both need this done.{' '}
        <Link to="/zones" className="text-ink-2 hover:text-accent underline">
          Zones
        </Link>{' '}
        drawn on a single camera do not.
      </p>
    </Screen>
  )
}

/* ---------------------------------------------------------------- step 1 */

function CalibrateMode({
  cameras,
  byCamera,
  onSaved,
}: {
  cameras: Camera[]
  byCamera: Map<string, CameraCalibration>
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [pickedId, setPickedId] = useState<string | null>(null)
  const camera = cameras.find((c) => c.id === pickedId) ?? cameras[0] ?? null

  const [points, setPoints] = useState<Point[]>([])
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    setPoints([])
  }, [camera?.id])

  const save = useMutation({
    mutationFn: () =>
      calibrateRect({
        camera_id: camera?.id as string,
        points,
        img_w: size?.w as number,
        img_h: size?.h as number,
      }),
    onSuccess: () => {
      setPoints([])
      onSaved()
    },
  })

  const forget = useMutation({
    mutationFn: (cameraId: string) => deleteCalibration(cameraId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['calibration'] })
    },
  })

  const current = camera ? byCamera.get(camera.id) : undefined

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <div>
        <div className="mb-3 max-w-xs">
          <label
            htmlFor="calibration_camera"
            className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
          >
            Camera
          </label>
          <select
            id="calibration_camera"
            className={controlClass()}
            value={camera?.id ?? ''}
            onChange={(e) => setPickedId(e.target.value || null)}
          >
            {cameras.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </div>

        {camera && (
          <FrameCanvas
            /* Forces a full remount on camera switch - without it,
               placeholderData keeps the outgoing camera's frame (and the
               size/coordinate space derived from it) on screen until the
               new one loads, and a click in that window would be recorded
               against the wrong camera's geometry. Same bug, same fix, as
               Zones.tsx's Drawing component; AlignMode's own FrameCanvas
               below doesn't need this, it renders one stable instance per
               calibrated camera rather than switching which camera a
               single instance shows. */
            key={camera.id}
            camera={camera}
            points={points}
            maxPoints={4}
            onAddPoint={(point) => setPoints((current) => [...current, point])}
            onMovePoint={(index, point) =>
              setPoints((current) => current.map((p, i) => (i === index ? point : p)))
            }
            onSize={setSize}
            hint="Click 3 corners of something you are sure is a right angle in real life — a floor tile, a rug, a doormat. Any rectangle works; you do not need a square and you do not measure anything. The 4th corner places itself once you have 3 — if the guess is off, drag it or click where the real corner is."
            footer={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={points.length === 0}
                  onClick={() => setPoints((current) => current.slice(0, -1))}
                >
                  <Undo2 className="size-3.5" aria-hidden />
                  Undo last point
                </Button>
                <Button size="sm" disabled={points.length === 0} onClick={() => setPoints([])}>
                  Clear
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={points.length !== 4 || size === null || save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? 'Saving…' : 'Compute and save'}
                </Button>
                <p role="status" aria-live="polite" className="text-ink-3 text-xs">
                  {points.length === 0
                    ? 'No corners yet — 3 needed, the 4th places itself.'
                    : points.length < 3
                      ? `${points.length} of 3 corners.`
                      : 'All 4 corners placed — drag the blue one, or click where it should be, if it is not quite right.'}
                </p>
              </div>
            }
          />
        )}

        {save.error != null && (
          <p
            role="alert"
            className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm"
          >
            {save.error instanceof ApiError
              ? describeApiError(save.error)
              : 'Could not compute this calibration.'}
          </p>
        )}

        {save.data && <RectResult result={save.data} />}
      </div>

      <div className="space-y-3">
        <Panel as="section">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">This branch's cameras</h2>
            <p className="text-ink-3 mt-1 text-xs">
              Calibrated is per camera. Aligned is the whole site agreeing.
            </p>
          </PanelHeader>
          <PanelBody>
            <ul className="space-y-2">
              {cameras.map((row) => {
                const entry = byCamera.get(row.id)
                return (
                  <li
                    key={row.id}
                    className="border-line bg-panel-2 flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    <span className="text-ink min-w-0 flex-1 truncate text-sm">{row.name}</span>
                    {entry ? (
                      <>
                        <Badge tone={entry.aligned ? 'ok' : 'warn'}>
                          {entry.aligned ? 'aligned' : 'not aligned'}
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Forget calibration for ${row.name}`}
                          disabled={forget.isPending}
                          onClick={() => forget.mutate(row.id)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <Badge tone="neutral">not calibrated</Badge>
                    )}
                  </li>
                )
              })}
            </ul>
          </PanelBody>
        </Panel>

        {current && <Diagnostics entry={current} />}

        <Panel as="section">
          <PanelBody>
            <h2 className="text-ink text-sm font-semibold">Why the error figure is missing</h2>
            <p className="text-ink-2 mt-2 text-sm leading-relaxed">
              A four-point fit always reports near-zero reprojection error, whether or not the shape
              you clicked really was a right angle. It says the maths ran, not that it is correct —
              so it is not shown as a score. What matters is whether the shape's proportions could
              be inferred, which is stated above when a calibration is saved.
            </p>
          </PanelBody>
        </Panel>
      </div>
    </div>
  )
}

function RectResult({
  result,
}: {
  result: { aspect_confident?: boolean; inferred_aspect?: number; aspect_source?: string }
}) {
  const confident = result.aspect_confident !== false
  return (
    <Panel as="section" tone={confident ? 'neutral' : 'alert'} className="mt-3">
      <PanelBody>
        <h2 className="text-ink text-sm font-semibold">
          {confident ? 'Calibrated' : 'Calibrated, but the shape was guessed'}
        </h2>
        <p className="text-ink-2 mt-2 text-sm leading-relaxed">
          {confident ? (
            <>
              The rectangle's proportions were inferred from its own perspective —{' '}
              <span className="text-ink tabular">{result.inferred_aspect}</span> wide for every 1
              tall. This camera still has to be aligned with the others before anything can use it.
            </>
          ) : (
            <>
              Saved, but the camera could not tell the rectangle's real shape from this view, so it
              treated it as a square. Nothing to redo if you align this camera next using 4 or more
              shared spots - alignment replaces this guess. Otherwise, click a bigger rectangle that
              fills more of the picture.
            </>
          )}
        </p>
      </PanelBody>
    </Panel>
  )
}

/** The AI service's fit string ("full homography from 6 shared points
 * (pixels -> cam cam1 world)") in plain words. Unknown shapes pass through. */
function describeFit(fit: string): string {
  if (fit.startsWith('full homography')) return 'full perspective (best)'
  if (fit.startsWith('affine')) return 'partial - add a 4th shared spot to fix perspective'
  if (fit.startsWith('similarity')) return 'rough - add more shared spots'
  return fit
}

function Diagnostics({ entry }: { entry: CameraCalibration }) {
  const d = entry.diagnostics
  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">What this camera knows</h2>
      </PanelHeader>
      <PanelBody>
        <dl className="space-y-2 text-sm">
          <Row
            label="Shape"
            value={
              d.aspect_superseded
                ? 'replaced by alignment'
                : d.aspect_confident === false
                  ? 'guessed (square assumed)'
                  : 'measured'
            }
          />
          {d.inferred_aspect !== undefined && !d.aspect_superseded && (
            <Row label="Proportions" value={`${d.inferred_aspect} : 1`} />
          )}
          {d.calib_res && <Row label="Measured at" value={`${d.calib_res[0]}×${d.calib_res[1]}`} />}
          <Row label="Aligned" value={entry.aligned ? 'yes' : 'not yet'} />
          {d.fit && <Row label="Alignment fit" value={describeFit(d.fit)} />}
          {d.aligned_with_n_points !== undefined && (
            <Row label="Shared points used" value={String(d.aligned_with_n_points)} />
          )}
        </dl>
      </PanelBody>
    </Panel>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-3 text-xs">{label}</dt>
      <dd className="text-ink tabular text-sm">{value}</dd>
    </div>
  )
}

/* ---------------------------------------------------------------- step 2 */

/**
 * Alignment: the same real spot, clicked in several cameras.
 *
 * The accumulated list is held here and sent WHOLE every time, because the
 * service re-solves from scratch - sending only the newest point would throw
 * away every earlier one. A camera that cannot be reached comes back
 * `aligned: false` with the call still returning 200, so the results are
 * read per camera rather than assumed from the status code.
 */
function AlignMode({
  cameras,
  byCamera,
  onAligned,
}: {
  cameras: Camera[]
  byCamera: Map<string, CameraCalibration>
  onAligned: () => void
}) {
  const calibrated = useMemo(
    () => cameras.filter((camera) => byCamera.has(camera.id)),
    [cameras, byCamera],
  )

  const [pending, setPending] = useState<SharedPoint>({})
  const [recorded, setRecorded] = useState<SharedPoint[]>([])

  /**
   * Recording a shared LINE instead of a shared POINT - for when no single
   * real spot is crisp enough to click precisely across cameras, but a real
   * straight edge is (a wall, a curb, a line painted on the floor). Feeds
   * the exact same `recorded` list and the exact same POST /calibration/align
   * call above, no separate backend endpoint - this is purely a different
   * way of accumulating shared points. Reference:
   * ai/reference_ui/calibration/calibration_app.py's /mark_align_line.
   */
  const [inputMode, setInputMode] = useState<'point' | 'line'>('point')
  const [curLine, setCurLine] = useState<Record<string, Point[]>>({})
  const [lineResult, setLineResult] = useState<string | null>(null)
  const LINE_MAX_POINTS = 20

  function finishLine() {
    const counts = Object.fromEntries(
      Object.entries(curLine).map(([cam, pts]) => [cam, pts.length]),
    )
    const commonCams = Object.keys(counts).filter((cam) => counts[cam] >= 2)

    if (commonCams.length < 2) {
      setLineResult('Need at least 2 points recorded in at least 2 cameras to feed this in.')
      return
    }
    /* Paired by list position - the SAME real line has to be clicked in the
       SAME direction in every camera, or point i in one camera is not point
       i in another. Reference's own comment flags this as the real risk
       here: a line clicked left-to-right in one camera and right-to-left in
       another silently produces confidently wrong shared points, nothing
       about the shape of the data reveals the mistake. Requiring every
       common camera to have recorded the EXACT SAME count (not just >=2,
       matching the reference's own gate) is a cheap partial guard - it
       cannot catch a same-count reversal, but it does catch the more common
       slip of stopping a click or two early or late in one camera. */
    const uniqueCounts = new Set(commonCams.map((cam) => counts[cam]))
    if (uniqueCounts.size !== 1) {
      setLineResult(
        `Cameras ${commonCams.join(', ')} recorded different point counts (${commonCams
          .map((cam) => `${cam}: ${counts[cam]}`)
          .join(
            ', ',
          )}) along this line - they need to match exactly before this can be paired up. Undo or clear and re-click so every camera has the same number of points.`,
      )
      return
    }

    const n = counts[commonCams[0]]
    const newShared: SharedPoint[] = []
    for (let i = 0; i < n; i += 1) {
      const point: SharedPoint = {}
      for (const cam of commonCams) point[cam] = curLine[cam][i]
      newShared.push(point)
    }
    setRecorded((current) => [...current, ...newShared])
    setLineResult(
      `${n} shared point${n === 1 ? '' : 's'} added from this line, across ${commonCams.length} cameras. Make sure the line was clicked in the same direction in each - a reversed click order pairs the wrong points without looking wrong here.`,
    )
    setCurLine({})
  }

  const run = useMutation({
    mutationFn: () => alignCameras(recorded),
    onSuccess: () => onAligned(),
  })

  const pendingCount = Object.keys(pending).length

  /**
   * How many recorded spots each pair of cameras has in common.
   *
   * This is the number the solve actually turns on, and it used to be
   * invisible until after the attempt: record one spot, press align, and
   * read "no chain of >=2-point camera pairs connects this camera back to
   * the reference" - which is accurate, arrives too late, and sounds like a
   * fault rather than "click one more spot".
   *
   * Two is the threshold because one matched point fixes position and
   * nothing else: rotation and scale are still free, so there are infinitely
   * many ways to place the other camera's floor that satisfy it. The service
   * refuses instead of guessing.
   */
  const pairCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const point of recorded) {
      const ids = Object.keys(point).sort()
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const key = `${ids[i]}|${ids[j]}`
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
    }
    return counts
  }, [recorded])

  const readyPairs = useMemo(
    () => [...pairCounts.values()].filter((n) => n >= 2).length,
    [pairCounts],
  )

  if (calibrated.length < 2) {
    return (
      <Panel as="section">
        <PanelBody className="flex gap-3">
          <AlertTriangle className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <h2 className="text-ink text-sm font-semibold">Calibrate at least two cameras first</h2>
            <p className="text-ink-2 mt-1 text-sm leading-relaxed">
              Alignment reconciles cameras with each other, so there is nothing to reconcile until
              two of them have been calibrated on their own.{' '}
              {calibrated.length === 1 && 'One is done.'}
            </p>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  return (
    <div>
      <Panel as="section" className="mb-3">
        <PanelBody>
          <div className="mb-3 flex gap-2">
            <Button
              size="sm"
              variant={inputMode === 'point' ? 'primary' : 'secondary'}
              onClick={() => setInputMode('point')}
            >
              Shared point
            </Button>
            <Button
              size="sm"
              variant={inputMode === 'line' ? 'primary' : 'secondary'}
              onClick={() => setInputMode('line')}
            >
              Shared line
            </Button>
          </div>

          {inputMode === 'point' ? (
            <>
              <h2 className="text-ink text-sm font-semibold">Click one real spot in each camera</h2>
              <p className="text-ink-2 mt-2 text-sm leading-relaxed">
                Pick something you can identify in more than one view — a corner of a mat, a chair
                leg, a mark on the floor. Click it in each camera that can see it, then record it.
                Repeat with a few different spots. Two cameras need at least 2 spots in common to be
                tied together, and 4 or more lets the alignment repair a camera's own rectangle
                outright.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={pendingCount < 2}
                  onClick={() => {
                    setRecorded((current) => [...current, pending])
                    setPending({})
                  }}
                >
                  Record this spot
                </Button>
                <Button size="sm" disabled={pendingCount === 0} onClick={() => setPending({})}>
                  Clear this spot
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  /* Not "at least one spot": a single spot cannot tie any pair
                     together, so offering the solve there only produces the
                     refusal above. */
                  disabled={readyPairs === 0 || run.isPending}
                  onClick={() => run.mutate()}
                >
                  {run.isPending ? 'Aligning…' : 'Align the cameras'}
                </Button>
                <p role="status" aria-live="polite" className="text-ink-3 text-xs">
                  {pendingCount > 0
                    ? `This spot is marked in ${pendingCount} camera${pendingCount === 1 ? '' : 's'} — 2 needed to record it.`
                    : recorded.length === 0
                      ? 'No spots recorded yet.'
                      : readyPairs === 0
                        ? `${recorded.length} spot${recorded.length === 1 ? '' : 's'} recorded — no two cameras share 2 yet, which is the minimum to tie a pair together.`
                        : `${recorded.length} spot${recorded.length === 1 ? '' : 's'} recorded.`}
                </p>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-ink text-sm font-semibold">
                Click the same real straight line in each camera
              </h2>
              <p className="text-ink-2 mt-2 text-sm leading-relaxed">
                For when no single spot is crisp enough to click precisely, but a real straight edge
                is — a wall, a curb, a painted line. Click several points along it in each camera
                that can see it, <span className="text-ink font-medium">in the same direction</span>{' '}
                every time (e.g. always left to right). "Finish this line" pairs the clicks up by
                order and feeds them in as ordinary shared points below.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={Object.keys(curLine).length === 0}
                  onClick={finishLine}
                >
                  Finish this line
                </Button>
                <Button
                  size="sm"
                  disabled={Object.keys(curLine).length === 0}
                  onClick={() => {
                    setCurLine({})
                    setLineResult(null)
                  }}
                >
                  Clear this line
                </Button>
                <p role="status" aria-live="polite" className="text-ink-3 text-xs">
                  {Object.keys(curLine).length === 0
                    ? 'No points on this line yet.'
                    : Object.entries(curLine)
                        .map(
                          ([cam, pts]) =>
                            `${cameras.find((c) => c.id === cam)?.name ?? cam}: ${pts.length}`,
                        )
                        .join(', ')}
                </p>
              </div>
              {lineResult && (
                <p className="text-ink-2 mt-2 text-xs leading-relaxed">{lineResult}</p>
              )}
              <Button
                size="sm"
                variant="primary"
                className="mt-3"
                disabled={readyPairs === 0 || run.isPending}
                onClick={() => run.mutate()}
              >
                {run.isPending ? 'Aligning…' : 'Align the cameras'}
              </Button>
            </>
          )}

          {recorded.length > 0 && (
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => setRecorded([])}>
              Start over — clears every recorded point and line
            </Button>
          )}
        </PanelBody>
      </Panel>

      {recorded.length > 0 && (
        <Panel as="section" className="mb-3">
          <PanelBody>
            <h3 className="text-ink-2 text-xs font-medium">Spots shared, camera by camera</h3>
            <ul className="mt-2 space-y-1">
              {calibrated.flatMap((a, i) =>
                calibrated.slice(i + 1).map((b) => {
                  const key = [a.id, b.id].sort().join('|')
                  const count = pairCounts.get(key) ?? 0
                  return (
                    <li key={key} className="flex items-center gap-2 text-sm">
                      <span className="text-ink-2 min-w-0 flex-1 truncate">
                        {a.name} ↔ {b.name}
                      </span>
                      <Badge tone={count >= 2 ? 'ok' : 'neutral'}>
                        {count >= 2 ? `${count} spots` : `${count} of 2`}
                      </Badge>
                    </li>
                  )
                }),
              )}
            </ul>
          </PanelBody>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {inputMode === 'point'
          ? calibrated.map((camera) => (
              <FrameCanvas
                key={camera.id}
                camera={camera}
                points={pending[camera.id] ? [pending[camera.id]] : []}
                maxPoints={1}
                onAddPoint={(point) =>
                  setPending((current) => ({ ...current, [camera.id]: point }))
                }
                hint="Click the same real spot you clicked in the other cameras."
              />
            ))
          : calibrated.map((camera) => (
              <FrameCanvas
                key={camera.id}
                camera={camera}
                points={curLine[camera.id] ?? []}
                maxPoints={LINE_MAX_POINTS}
                onAddPoint={(point) =>
                  setCurLine((current) => ({
                    ...current,
                    [camera.id]: [...(current[camera.id] ?? []), point],
                  }))
                }
                hint="Click points along the same real straight edge, in the same direction as every other camera."
              />
            ))}
      </div>

      {run.error != null && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm"
        >
          {run.error instanceof ApiError
            ? describeApiError(run.error)
            : 'Could not align the cameras.'}
        </p>
      )}

      {run.data && <AlignReport result={run.data} cameras={cameras} />}
    </div>
  )
}

function AlignReport({ result, cameras }: { result: AlignResult; cameras: Camera[] }) {
  const nameOf = (id: string) => cameras.find((camera) => camera.id === id)?.name ?? id
  const entries = Object.entries(result.results)
  const failed = entries.filter(([, value]) => !value.aligned)
  /* The contract calls this `results_warning`; the service emits
     `reference_warning`. Both are read so neither is silently dropped. */
  const referenceWarning = result.reference_warning ?? result.results_warning

  return (
    <Panel as="section" tone={failed.length > 0 ? 'alert' : 'neutral'} className="mt-3">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">
          {failed.length === 0
            ? 'Every camera is on the same floor now'
            : `${failed.length} camera${failed.length === 1 ? '' : 's'} could not be reached`}
        </h2>
        <p className="text-ink-3 mt-1 text-xs">
          Everything was reconciled onto {nameOf(result.reference)}.
        </p>
      </PanelHeader>
      <PanelBody>
        <ul className="space-y-2">
          {entries.map(([cameraId, value]) => (
            <li
              key={cameraId}
              className="border-line bg-panel-2 rounded-lg border px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="text-ink min-w-0 flex-1 truncate font-medium">
                  {nameOf(cameraId)}
                </span>
                {value.reference && <Badge tone="info">reference</Badge>}
                <Badge tone={value.aligned ? 'ok' : 'warn'}>
                  {value.aligned ? 'aligned' : 'not aligned'}
                </Badge>
              </div>
              {value.error && <p className="text-ink-2 mt-1.5 text-xs">{value.error}</p>}
              {value.aligned && !value.reference && (
                <p className="text-ink-3 mt-1.5 text-xs">
                  Tied to {nameOf(value.via ?? '')} with {value.n_points} shared spot
                  {value.n_points === 1 ? '' : 's'}
                  {value.order_reversed && ' — point order was reversed to fit better'}.
                </p>
              )}
            </li>
          ))}
        </ul>

        {referenceWarning && (
          <p className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm leading-relaxed">
            {referenceWarning}
          </p>
        )}
        {result.weak_fits && (
          <p className="text-ink-2 mt-3 text-sm leading-relaxed">{result.weak_fits}</p>
        )}

        {result.residual_checks.length > 0 && (
          <p className="text-ink-3 mt-3 text-xs leading-relaxed">
            Across the spots you recorded, the cameras now place the same point within{' '}
            <span className="text-ink-2 tabular">
              {formatDistance(
                Math.max(
                  0,
                  ...result.residual_checks.flatMap((check) =>
                    check.pairs.map((pair) => pair.distance_cm),
                  ),
                ),
              )}
            </span>{' '}
            of each other at worst (as a share of the calibration rectangle&apos;s short side).
            Under 5% is good; tens of percent mean the alignment did not take.
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}

/* ------------------------------------------------------------------ both */

/**
 * A camera's picture with clickable points on it.
 *
 * The frame is NATIVE resolution here, not the detector-scaled one the live
 * view uses: the clicked points are sent with `img_w`/`img_h` and the
 * service assumes the image centre is the principal point, so points
 * measured on a resized frame describe a camera that does not exist.
 *
 * Fetched once and never refetched - the picture is the thing being
 * measured, and swapping it under placed points would silently move them to
 * a different room.
 */
function FrameCanvas({
  camera,
  points,
  maxPoints,
  onAddPoint,
  onMovePoint,
  onSize,
  hint,
  footer,
}: {
  camera: Camera
  points: Point[]
  maxPoints: number
  onAddPoint: (point: Point) => void
  /** Only meaningful with maxPoints === 4 - see the 4th-corner drag below.
   * AlignMode's single-point mode has no use for it and passes nothing. */
  onMovePoint?: (index: number, point: Point) => void
  onSize?: (size: { w: number; h: number }) => void
  hint: string
  footer?: React.ReactNode
}) {
  /**
   * LIVE UNTIL YOU CLICK, FROZEN AFTER.
   *
   * The picture has to hold still while you measure: points are stored in
   * frame pixels, so a picture that kept moving would leave your corners
   * pinned to a room that has walked away. But holding still BEFORE the
   * first click buys nothing and costs the only thing that makes a camera
   * legible - seeing it move. So it plays until a point lands, and clearing
   * the points starts it again.
   */
  const frozen = points.length > 0
  const frame = useQuery({
    queryKey: ['nativeFrame', camera.id],
    queryFn: ({ signal }) => fetchNativeFrame(camera.id, signal),
    retry: false,
    refetchInterval: frozen ? false : FRAME_MS,
    /* Keeps the last picture up while the next arrives, so the preview does
       not blink through a skeleton twice a second. */
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
      ? `The detector cannot open ${camera.name}’s stream, so there is nothing to measure.`
      : 'Could not fetch a picture from this camera.'

  /**
   * THE 4TH CORNER: AUTO-PLACED, THEN DRAGGABLE.
   *
   * A homography needs 4 point correspondences; 3 points plus "it's a right
   * angle" is still 2 degrees of freedom short, which is what the aspect
   * inference (calibrateRect's vanishing-point math) is left guessing at.
   * Reference: ai/reference_ui/calibration/calibration_app.py's own docstring
   * calls dragging this corner into its real position "strictly more
   * reliable" than trusting that inference alone - it is the recovery path
   * for a low-confidence read, not a nice-to-have.
   *
   * The moment a 3rd point lands, a 4th is placed by parallelogram
   * completion (corner4 = corner1 + corner3 - corner2, exact same formula
   * the reference uses) and immediately becomes this point set's 4th entry,
   * same as if it had been clicked. From there it can be dragged to wherever
   * the real corner actually is - the auto-placement is only exact for a
   * near-front-on view, a real rectangle does not project to an exact
   * parallelogram under general perspective, which is why it is draggable
   * rather than trusted outright.
   */
  const autoPlaceFourth = maxPoints === 4 && onMovePoint !== undefined
  const placedAutoFourthFor = useRef<string | null>(null)
  useEffect(() => {
    if (!autoPlaceFourth) return
    if (points.length !== 3) {
      /* Not at exactly 3 - reset the guard so a later sequence that lands on
         the same 3 coordinates again (e.g. cleared and re-clicked identically)
         still re-triggers, instead of being mistaken for the same in-flight
         render this guard exists to deduplicate. */
      placedAutoFourthFor.current = null
      return
    }
    /* Guards against re-adding a 5th point if this effect re-runs for a
       reason other than "the 3rd point just landed" - e.g. a parent
       re-render with the same 3 points. */
    const signature = points.map(([x, y]) => `${x},${y}`).join('|')
    if (placedAutoFourthFor.current === signature) return
    placedAutoFourthFor.current = signature
    const [p1, p2, p3] = points
    onAddPoint([p1[0] + p3[0] - p2[0], p1[1] + p3[1] - p2[1]])
  }, [autoPlaceFourth, points, onAddPoint])

  const [draggingHandle, setDraggingHandle] = useState(false)

  function pointFromEvent(event: { clientX: number; clientY: number }): Point | null {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return null
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    return [Math.round(point.x), Math.round(point.y)]
  }

  function handleFourthPointerDown(event: React.PointerEvent<SVGCircleElement>) {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingHandle(true)
  }
  function handleFourthPointerMove(event: React.PointerEvent<SVGCircleElement>) {
    if (!draggingHandle || !onMovePoint) return
    const point = pointFromEvent(event)
    if (point) onMovePoint(3, point)
  }
  function handleFourthPointerUp(event: React.PointerEvent<SVGCircleElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId)
    setDraggingHandle(false)
  }

  /* Once the 4th corner exists, a click puts it there - dragging a small
     handle is fiddly, and on a touch screen it is the only precise option
     besides a click. The click that ends a drag lands where the handle
     already is, so the two never fight. */
  const canRepositionFourth = autoPlaceFourth && points.length === 4

  function handleClick(event: React.MouseEvent<SVGSVGElement>) {
    const point = pointFromEvent(event)
    if (!point) return
    if (canRepositionFourth && onMovePoint) {
      onMovePoint(3, point)
      return
    }
    if (points.length >= maxPoints) return
    onAddPoint(point)
  }

  return (
    <Panel as="section">
      <PanelHeader>
        <div className="flex items-center gap-2.5">
          <Ruler className="text-ink-3 size-4 shrink-0" aria-hidden />
          <h2 className="text-ink truncate text-sm font-semibold">{camera.name}</h2>
        </div>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">{hint}</p>
        <p className="text-ink-3 mt-1 text-xs">
          {frozen ? (
            <span className="text-ink-2">
              Held still while you measure — clear the points to let it play again.
            </span>
          ) : (
            'Playing. It freezes as soon as you place a point.'
          )}
        </p>
      </PanelHeader>

      <PanelBody className="p-0">
        <div className="bg-ink/90 relative aspect-video w-full overflow-hidden">
          {src && !noFrame ? (
            <img
              src={src}
              alt={`Current frame from ${camera.name}`}
              className="absolute inset-0 h-full w-full object-contain"
              onLoad={(e) => {
                const next = {
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                }
                setSize(next)
                onSize?.(next)
              }}
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
              className={`absolute inset-0 h-full w-full ${
                points.length >= maxPoints && !canRepositionFourth
                  ? 'cursor-default'
                  : 'cursor-crosshair'
              }`}
              onClick={handleClick}
              role="presentation"
            >
              {points.length > 1 && (
                <polygon
                  points={points.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="rgba(255, 153, 0, 0.12)"
                  stroke="#ff9900"
                  strokeWidth={Math.max(2, Math.round(size.w / 480))}
                />
              )}
              {points.map(([x, y], i) => {
                /* The auto-placed/draggable 4th corner - stable key (not
                   coordinate-based like the others) so dragging doesn't
                   remount the element mid-drag and drop pointer capture. */
                const isDraggableFourth = autoPlaceFourth && i === 3 && points.length === 4
                return (
                  <g key={isDraggableFourth ? 'fourth-corner' : `${x}-${y}-${i}`}>
                    <circle
                      cx={x}
                      cy={y}
                      r={Math.max(5, Math.round(size.w / (isDraggableFourth ? 130 : 160)))}
                      fill={i === 0 ? '#4ade80' : isDraggableFourth ? '#6ea0ff' : '#ff9900'}
                      stroke={isDraggableFourth ? '#fff' : undefined}
                      strokeWidth={isDraggableFourth ? 2 : undefined}
                      className={
                        isDraggableFourth ? 'cursor-grab active:cursor-grabbing' : undefined
                      }
                      onPointerDown={isDraggableFourth ? handleFourthPointerDown : undefined}
                      onPointerMove={isDraggableFourth ? handleFourthPointerMove : undefined}
                      onPointerUp={isDraggableFourth ? handleFourthPointerUp : undefined}
                    />
                    {maxPoints > 1 && (
                      <text
                        x={x + Math.max(8, Math.round(size.w / 120))}
                        y={y}
                        fontSize={Math.max(16, Math.round(size.w / 45))}
                        fontFamily="system-ui, sans-serif"
                        fontWeight={600}
                        fill="#fff"
                        stroke="#000"
                        strokeWidth={Math.max(2, Math.round(size.w / 400))}
                        paintOrder="stroke"
                      >
                        {i + 1}
                        {isDraggableFourth ? ' (drag or click)' : ''}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
          )}
        </div>
      </PanelBody>

      {footer && <PanelBody>{footer}</PanelBody>}
    </Panel>
  )
}

/* ---------------------------------------------------------------- step 3 */

/**
 * Read-only verification that an alignment actually worked, as opposed to
 * step 2 which computes and SAVES one. A 4-point exact fit's reprojection
 * error is always ~0 by construction regardless of whether the alignment is
 * actually right - two independently-calibrated cameras anchored to
 * different physical tiles will each look perfect on their own and produce
 * zero fused detections downstream. This is the check that catches that
 * before relying on it: click the same real point in 2+ ALREADY ALIGNED
 * cameras, and see whether they actually agree on where it is.
 */
function CrossCheckMode({
  cameras,
  byCamera,
}: {
  cameras: Camera[]
  byCamera: Map<string, CameraCalibration>
}) {
  const aligned = useMemo(
    () => cameras.filter((camera) => byCamera.get(camera.id)?.aligned),
    [cameras, byCamera],
  )

  const [pending, setPending] = useState<SharedPoint>({})
  const pendingCount = Object.keys(pending).length

  const check = useMutation({
    mutationFn: () => crossCheckCameras(pending),
  })

  if (aligned.length < 2) {
    return (
      <Panel as="section">
        <PanelBody className="flex gap-3">
          <AlertTriangle className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <h2 className="text-ink text-sm font-semibold">Align at least two cameras first</h2>
            <p className="text-ink-2 mt-1 text-sm leading-relaxed">
              Cross-checking an unaligned camera doesn't verify anything - it has no shared frame
              yet to verify against. {aligned.length === 1 && 'One aligned camera so far.'}
            </p>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  return (
    <div>
      <Panel as="section" className="mb-3">
        <PanelBody>
          <h2 className="text-ink text-sm font-semibold">Click one real spot in each camera</h2>
          <p className="text-ink-2 mt-2 text-sm leading-relaxed">
            Pick something you can identify in two or more views, then check. This does not save
            anything - it reads back where each camera currently thinks that point is, in the shared
            floor frame alignment already computed. If the alignment is right, every camera should
            place it at roughly the same spot.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={pendingCount < 2 || check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check'}
            </Button>
            <Button
              size="sm"
              disabled={pendingCount === 0}
              onClick={() => {
                setPending({})
                check.reset()
              }}
            >
              Clear
            </Button>
            <p role="status" aria-live="polite" className="text-ink-3 text-xs">
              {pendingCount === 0
                ? 'No spot marked yet.'
                : `Marked in ${pendingCount} camera${pendingCount === 1 ? '' : 's'} — 2 needed.`}
            </p>
          </div>
        </PanelBody>
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {aligned.map((camera) => (
          <FrameCanvas
            key={camera.id}
            camera={camera}
            points={pending[camera.id] ? [pending[camera.id]] : []}
            maxPoints={1}
            onAddPoint={(point) => setPending((current) => ({ ...current, [camera.id]: point }))}
            hint="Click the same real spot you clicked in the other cameras."
          />
        ))}
      </div>

      {check.error != null && (
        <p
          role="alert"
          className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm"
        >
          {check.error instanceof ApiError
            ? describeApiError(check.error)
            : 'Could not run the cross-check.'}
        </p>
      )}

      {check.data && <CrossCheckResultPanel result={check.data} cameras={cameras} />}
    </div>
  )
}

/**
 * How far apart two cameras place one clicked spot, in words.
 *
 * The AI service's `distance_cm` is not real centimetres: calibration scales
 * the clicked rectangle so its SHORT side is 1 m (100 units) whatever its
 * real size (ai/features/calibration/engine.py, target_m), and nothing ever
 * asks for that size. So the number is only meaningful relative to that
 * rectangle, and it is shown that way. The bands are guidance, not a verdict:
 * a few percent is click precision; past ~15% one person can read as two.
 */
function crossCheckVerdict(units: number): { tone: Tone; label: string } {
  if (units < 5) return { tone: 'ok', label: 'Agree' }
  if (units < 15) return { tone: 'warn', label: 'Roughly agree' }
  return { tone: 'danger', label: 'Disagree' }
}

/** Calibration units -> share of the calibration rectangle's short side. */
function formatDistance(units: number): string {
  return `${units < 10 ? units.toFixed(1) : units.toFixed(0)}%`
}

function CrossCheckResultPanel({
  result,
  cameras,
}: {
  result: CrossCheckResult
  cameras: Camera[]
}) {
  /* The proxy translates camera names back to our ids; show names. */
  const nameOf = (id: string) => cameras.find((camera) => camera.id === id)?.name ?? id
  const worst = Math.max(0, ...result.pairs.map((pair) => pair.distance_cm))
  const verdict = crossCheckVerdict(worst)
  return (
    <Panel as="section" className="mt-3">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">How closely the cameras agree</h2>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          How far apart the cameras place the spot you clicked, as a share of the short side of the
          rectangle you calibrated with. Under 5% is good - a few percent is just click precision.
          Over 15% means the same person could show up twice: redo the alignment with spots spread
          across the room.
        </p>
      </PanelHeader>
      <PanelBody>
        <ul className="space-y-1.5">
          {result.pairs.map((pair) => {
            const v = crossCheckVerdict(pair.distance_cm)
            return (
              <li
                key={`${pair.cam_a}-${pair.cam_b}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-ink-2 min-w-0 truncate">
                  {nameOf(pair.cam_a)} and {nameOf(pair.cam_b)}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-ink tabular">{formatDistance(pair.distance_cm)} off</span>
                  <Badge tone={v.tone}>{v.label}</Badge>
                </span>
              </li>
            )
          })}
        </ul>
        {result.pairs.length > 1 && (
          <p className="text-ink-3 mt-3 text-xs">
            Worst pair: {formatDistance(worst)} ({verdict.label.toLowerCase()}).
          </p>
        )}
      </PanelBody>
    </Panel>
  )
}

/* ---------------------------------------------------------------- step 4 */

/**
 * Entry/exit gates: a marked real-world doorway or entry point, single
 * camera, single click, no multi-camera agreement needed unlike alignment.
 * Used by /people's tracker as a revival prior - an unmatched detection far
 * from every marked gate is assumed to be an existing tracked person whose
 * position drifted, not someone new walking in. No gates marked at all is a
 * safe default; every gate-dependent part of the tracker just doesn't apply
 * that logic.
 *
 * WHY SAVED GATES CANNOT BE SHOWN ON THE PICTURE
 *
 * Once saved, a gate is a camera-agnostic world coordinate - the same shape
 * the real service stores it as (features/calibration/api.py's GATES file),
 * and GET /calibration/gates only ever returns that. There is no reverse
 * mapping available to this screen from a saved world coordinate back to
 * "which camera, which pixel" - that would need either a dedicated
 * projection endpoint (the reference tool's local-only /gates_pixels) or
 * this screen holding every camera's Hinv, neither of which exists here.
 * So this screen is honestly append-only within a session: mark new points,
 * save, and saving REPLACES the entire list - said plainly rather than
 * implied to be additive when it is not.
 */
function GatesMode({
  cameras,
  byCamera,
}: {
  cameras: Camera[]
  byCamera: Map<string, CameraCalibration>
}) {
  const calibrated = useMemo(
    () => cameras.filter((camera) => byCamera.has(camera.id)),
    [cameras, byCamera],
  )

  const existing = useQuery({
    queryKey: ['gates'],
    queryFn: ({ signal }) => fetchGates(signal),
  })

  const [pickedId, setPickedId] = useState<string | null>(null)
  const camera = calibrated.find((c) => c.id === pickedId) ?? calibrated[0] ?? null

  const [pendingGates, setPendingGates] = useState<Record<string, Point[]>>({})
  const GATE_MAX_POINTS = 50

  const save = useMutation({
    mutationFn: () => {
      const entries: Gate[] = Object.entries(pendingGates)
        .filter(([, points]) => points.length > 0)
        .map(([cam, points]) => ({ camera: cam, points }))
      return saveGates(entries)
    },
    onSuccess: () => {
      setPendingGates({})
      void existing.refetch()
    },
  })

  const clear = useMutation({
    mutationFn: () => clearGates(),
    onSuccess: () => void existing.refetch(),
  })

  const pendingCount = Object.values(pendingGates).reduce((n, pts) => n + pts.length, 0)

  if (calibrated.length === 0) {
    return (
      <Panel as="section">
        <PanelBody className="flex gap-3">
          <AlertTriangle className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <h2 className="text-ink text-sm font-semibold">Calibrate a camera first</h2>
            <p className="text-ink-2 mt-1 text-sm leading-relaxed">
              A gate needs one calibrated camera to convert its pixel click into a floor coordinate
              - no alignment required, just calibration.
            </p>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <div>
        <div className="mb-3 max-w-xs">
          <label
            htmlFor="gates_camera"
            className="text-ink-3 tracked mb-2 block text-[11px] font-medium"
          >
            Camera
          </label>
          <select
            id="gates_camera"
            className={controlClass()}
            value={camera?.id ?? ''}
            onChange={(e) => setPickedId(e.target.value || null)}
          >
            {calibrated.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </div>

        {camera && (
          <FrameCanvas
            key={camera.id}
            camera={camera}
            points={pendingGates[camera.id] ?? []}
            maxPoints={GATE_MAX_POINTS}
            onAddPoint={(point) =>
              setPendingGates((current) => ({
                ...current,
                [camera.id]: [...(current[camera.id] ?? []), point],
              }))
            }
            hint="Click a doorway or entry point - wherever people actually walk in from. As many as you like, on as many cameras as you like."
            footer={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={!pendingGates[camera.id]?.length}
                  onClick={() =>
                    setPendingGates((current) => ({
                      ...current,
                      [camera.id]: (current[camera.id] ?? []).slice(0, -1),
                    }))
                  }
                >
                  <Undo2 className="size-3.5" aria-hidden />
                  Undo last point
                </Button>
                <Button
                  size="sm"
                  disabled={!pendingGates[camera.id]?.length}
                  onClick={() => setPendingGates((current) => ({ ...current, [camera.id]: [] }))}
                >
                  Clear this camera
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pendingCount === 0 || save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? 'Saving…' : 'Save gates'}
                </Button>
                <p role="status" aria-live="polite" className="text-ink-3 text-xs">
                  {pendingCount === 0
                    ? 'No new points marked yet.'
                    : `${pendingCount} new point${pendingCount === 1 ? '' : 's'} to save.`}
                </p>
              </div>
            }
          />
        )}

        {save.error != null && (
          <p
            role="alert"
            className="border-warn/30 bg-warn/8 text-warn mt-3 rounded-lg border p-3 text-sm"
          >
            {save.error instanceof ApiError
              ? describeApiError(save.error)
              : 'Could not save these gates.'}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Panel as="section" tone="alert">
          <PanelBody>
            <h2 className="text-warn text-sm font-semibold">Saving replaces the whole list</h2>
            <p className="text-ink-2 mt-2 text-sm leading-relaxed">
              There is no way for this screen to show a previously saved gate on a camera's picture
              - once saved, a gate is a floor coordinate with no camera or pixel attached to it
              anymore, and nothing here can project it back. Mark every gate you want kept, across
              however many cameras, before saving.
            </p>
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">Currently saved</h2>
          </PanelHeader>
          <PanelBody>
            {existing.isPending ? (
              <p className="text-ink-3 text-sm">Loading…</p>
            ) : existing.error ? (
              <p className="text-ink-2 text-sm">
                {existing.error instanceof ApiError
                  ? describeApiError(existing.error)
                  : 'Could not read the saved gates.'}
              </p>
            ) : (
              <p className="text-ink-2 text-sm leading-relaxed">
                {existing.data?.length
                  ? `${existing.data.length} gate${existing.data.length === 1 ? '' : 's'} saved, as world coordinates only.`
                  : 'No gates saved yet - the tracker treats every unmatched detection as a possibly-new person.'}
              </p>
            )}
            {(existing.data?.length ?? 0) > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-3"
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {clear.isPending ? 'Clearing…' : 'Clear all saved gates'}
              </Button>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  )
}
