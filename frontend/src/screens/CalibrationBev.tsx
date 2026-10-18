import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Grid3x3, RotateCcw } from 'lucide-react'
import { fetchNativeFrame } from '@/api/endpoints/cameras'
import type { Camera, CameraCalibration } from '@/api/types'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'

/**
 * Bird's-eye overlay: every selected camera's own frame, rectified onto ONE
 * shared floor-plane canvas and stacked together. If calibration and
 * alignment are right, a real floor feature (a rug's edge, a tile seam)
 * lands in the SAME canvas position from every camera and looks sharp; if
 * it's off, it visibly doubles/ghosts. This is the actual alignment check
 * by eye, not by number - the coverage-check numbers below are a weak
 * supporting signal, not a substitute for looking at the picture.
 *
 * Reference: ai/reference_ui/calibration/calibration_app.py, lines
 * 639-1322 (_coverage_check, _bev_canvas_transform, _warp_to_bev,
 * _draw_bev_grid, the bev_overlay/coverage_check/bev_single routes).
 *
 * NO BACKEND ENDPOINT FOR THIS EXISTS ANYWHERE, checked both
 * ai/features/calibration/api.py and engine.py. The reference renders a
 * server-side PNG (cv2.warpPerspective + pixel averaging); this rebuilds
 * the same idea client-side instead: a 3x3 planar homography embeds
 * directly into a CSS matrix3d (a known technique - no WebGL needed),
 * GPU-accelerated, and stacking each camera's warped layer at partial
 * opacity is the ghosting effect. That is a real engineering choice made
 * here, not a detail to skip past.
 */

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]]

function multiply3x3(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
    }
  }
  return out as Mat3
}

function applyMat3(H: Mat3, [x, y]: [number, number]): [number, number] {
  const w = H[2][0] * x + H[2][1] * y + H[2][2]
  const px = (H[0][0] * x + H[0][1] * y + H[0][2]) / w
  const py = (H[1][0] * x + H[1][1] * y + H[1][2]) / w
  return [px, py]
}

/** 3x3 -> the 16-value column-major CSS matrix3d() argument list. A planar
 * homography [[a,b,c],[d,e,f],[g,h,i]] embeds as the 4x4
 *   a b 0 c
 *   d e 0 f
 *   0 0 1 0
 *   g h 0 i
 * (z passes through untouched, w' still comes from the bottom row) - this
 * is the standard "2D homography via a 3D CSS transform" embedding. */
function toMatrix3d(H: Mat3): string {
  const [[a, b, c], [d, e, f], [g, h, i]] = H
  const values = [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, i]
  return `matrix3d(${values.join(',')})`
}

/** Sutherland-Hodgman: keep the part of `poly` where a*x + b*y + c >= limit. */
function clipHalfPlane(
  poly: Array<[number, number]>,
  [a, b, c]: [number, number, number],
  limit: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < poly.length; i += 1) {
    const cur = poly[i]
    const nxt = poly[(i + 1) % poly.length]
    const fc = a * cur[0] + b * cur[1] + c
    const fn = a * nxt[0] + b * nxt[1] + c
    if (fc >= limit) out.push(cur)
    if (fc >= limit !== fn >= limit) {
      const t = (limit - fc) / (fn - fc)
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])])
    }
  }
  return out
}

/** How far past the nearest visible floor the canvas and overlay reach. */
const FAR_FACTOR = 7

/**
 * Which part of a camera's frame is floor worth projecting.
 *
 * A ground-plane homography sends the horizon line (Hinv's bottom row = 0) to
 * infinity, so pixels above it are behind the camera or arbitrarily far away.
 * Projecting the raw frame corners - what this used to do - gives a camera
 * that sees the horizon a footprint thousands of metres wide: the overlay
 * shrinks the room to a dot and the area check flags a correct alignment.
 * Same fix as the reference (_camera_world_footprint): clip the frame at the
 * horizon first. `floor` is additionally clipped at FAR_FACTOR times the
 * distance of the nearest visible floor (distance ~ 1/w), which bounds what
 * the canvas has to fit; `horizonFrac` is how much of the frame lies past the
 * horizon, so a camera that crosses it can be called unbounded.
 */
function visibleFloor(
  Hinv: Mat3,
  w: number,
  h: number,
): { floor: Array<[number, number]>; horizonFrac: number; boundedArea: number } {
  const frame: Array<[number, number]> = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ]
  const centre = Hinv[2][0] * (w / 2) + Hinv[2][1] * (h / 2) + Hinv[2][2]
  const sign = centre < 0 ? -1 : 1
  const row: [number, number, number] = [sign * Hinv[2][0], sign * Hinv[2][1], sign * Hinv[2][2]]
  const eps = 1e-9 * Math.max(1, Math.abs(row[2]))
  const belowHorizon = clipHalfPlane(frame, row, eps)
  if (belowHorizon.length < 3) return { floor: [], horizonFrac: 1, boundedArea: 0 }
  const horizonFrac = Math.max(0, 1 - polygonArea(belowHorizon) / (w * h))
  const wNear = Math.max(...belowHorizon.map(([x, y]) => row[0] * x + row[1] * y + row[2]))
  const floor = clipHalfPlane(belowHorizon, row, wNear / FAR_FACTOR)
  return {
    floor,
    horizonFrac,
    boundedArea: polygonArea(belowHorizon.map((p) => applyMat3(Hinv, p))),
  }
}

function polygonArea(points: Array<[number, number]>): number {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}

interface Included {
  camera: Camera
  Hinv: Mat3
  imgW: number
  imgH: number
}

/** World bounding box (union of every included camera's own footprint) -> a
 * uniform similarity matrix S mapping world (x,y) -> canvas pixel (x,y).
 * UNIFORM scale (not stretched per axis), same reasoning as the reference:
 * a real floor tile should still look square in the canvas, a stretched
 * axis would make real skew and misalignment indistinguishable by eye. */
function computeCanvasTransform(
  included: Included[],
  canvasSize: number,
  pad: number,
): { S: Mat3; bounds: { xmin: number; xmax: number; ymin: number; ymax: number } } | null {
  const allCorners = included.flatMap((entry) =>
    visibleFloor(entry.Hinv, entry.imgW, entry.imgH).floor.map((p) => applyMat3(entry.Hinv, p)),
  )
  if (allCorners.length === 0) return null

  const xs = allCorners.map((p) => p[0])
  const ys = allCorners.map((p) => p[1])
  const xmin = Math.min(...xs)
  const xmax = Math.max(...xs)
  const ymin = Math.min(...ys)
  const ymax = Math.max(...ys)
  const span = Math.max(xmax - xmin, ymax - ymin, 1e-6)
  const scale = (canvasSize - 2 * pad) / span

  const S: Mat3 = [
    [scale, 0, pad - xmin * scale],
    [0, scale, pad - ymin * scale],
    [0, 0, 1],
  ]
  return { S, bounds: { xmin, xmax, ymin, ymax } }
}

/**
 * Compare every included camera's own world-floor footprint AREA as a WEAK
 * smoke test for a badly-scaled alignment. READ THIS BEFORE TRUSTING IT,
 * same warning the reference gives: a clean result here is not a green
 * light, it only catches gross scale errors - the reference measured a
 * correct real calibration spanning a wider area ratio (31x) than this
 * check's own flag threshold (20x), so a flagged camera is worth a second
 * look and a clean result proves nothing on its own. A camera that sees past
 * the horizon has an unbounded footprint and is left out of the comparison,
 * as in the reference. Areas are in m² (Hinv maps pixels to centimetres).
 */
function coverageCheck(included: Included[]): {
  areas: Record<string, number>
  median: number | null
  flagged: string[]
  unbounded: string[]
} {
  const areas: Record<string, number> = {}
  const unbounded: string[] = []
  for (const entry of included) {
    const view = visibleFloor(entry.Hinv, entry.imgW, entry.imgH)
    if (view.horizonFrac > 0.01) unbounded.push(entry.camera.id)
    else areas[entry.camera.id] = view.boundedArea / 10_000
  }
  const values = Object.values(areas)
  if (values.length < 2) return { areas, median: null, flagged: [], unbounded }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const flagged = Object.entries(areas)
    .filter(([, area]) => median > 1e-9 && (area / median > 20 || area / median < 0.05))
    .map(([id]) => id)
  return { areas, median, flagged, unbounded }
}

const CANVAS_SIZE = 640
const FALLBACK_W = 1920
const FALLBACK_H = 1080

export default function BevMode({
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

  const [selected, setSelected] = useState<Set<string>>(() => new Set(calibrated.map((c) => c.id)))
  const [showGrid, setShowGrid] = useState(true)
  const [singleCamera, setSingleCamera] = useState<string | null>(null)

  const included = useMemo(() => {
    const out: Included[] = []
    for (const camera of calibrated) {
      if (!selected.has(camera.id)) continue
      const entry = byCamera.get(camera.id)
      if (!entry) continue
      const res = entry.diagnostics.calib_res
      out.push({
        camera,
        Hinv: entry.Hinv as Mat3,
        imgW: res?.[0] ?? FALLBACK_W,
        imgH: res?.[1] ?? FALLBACK_H,
      })
    }
    return out
  }, [calibrated, selected, byCamera])

  const transform = useMemo(() => computeCanvasTransform(included, CANVAS_SIZE, 20), [included])
  const coverage = useMemo(() => coverageCheck(included), [included])

  if (calibrated.length === 0) {
    return (
      <Panel as="section">
        <PanelBody className="flex gap-3">
          <AlertTriangle className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <h2 className="text-ink text-sm font-semibold">Calibrate a camera first</h2>
            <p className="text-ink-2 mt-1 text-sm leading-relaxed">
              There is nothing to project onto a shared canvas until at least one camera is
              calibrated.
            </p>
          </div>
        </PanelBody>
      </Panel>
    )
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <Panel as="section">
        <PanelHeader
          action={
            <Button size="sm" variant="ghost" onClick={() => setShowGrid((g) => !g)}>
              <Grid3x3 className="size-3.5" aria-hidden />
              {showGrid ? 'Hide grid' : 'Show grid'}
            </Button>
          }
        >
          <h2 className="text-ink text-sm font-semibold">
            {singleCamera
              ? `${cameras.find((c) => c.id === singleCamera)?.name ?? singleCamera} alone`
              : `Overlay (${included.length} camera${included.length === 1 ? '' : 's'})`}
          </h2>
          <p className="text-ink-3 mt-1 text-xs leading-relaxed">
            A real floor feature should land in the same spot from every camera. Doubling/ghosting
            means they disagree.
          </p>
        </PanelHeader>
        <PanelBody className="p-0">
          <BevCanvas
            included={included}
            transform={transform}
            showGrid={showGrid}
            singleCamera={singleCamera}
          />
        </PanelBody>
      </Panel>

      <div className="space-y-3">
        <Panel as="section">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">Cameras in the overlay</h2>
          </PanelHeader>
          <PanelBody>
            <ul className="space-y-2">
              {calibrated.map((camera) => (
                <li key={camera.id} className="flex items-center gap-2 text-sm">
                  <label className="flex flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(camera.id)}
                      onChange={(e) =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (e.target.checked) next.add(camera.id)
                          else next.delete(camera.id)
                          return next
                        })
                      }
                    />
                    <span className="text-ink-2 min-w-0 flex-1 truncate">{camera.name}</span>
                  </label>
                  <Badge tone={byCamera.get(camera.id)?.aligned ? 'ok' : 'neutral'}>
                    {byCamera.get(camera.id)?.aligned ? 'aligned' : 'unaligned'}
                  </Badge>
                  <Button
                    size="sm"
                    variant={singleCamera === camera.id ? 'primary' : 'ghost'}
                    onClick={() =>
                      setSingleCamera((current) => (current === camera.id ? null : camera.id))
                    }
                  >
                    Alone
                  </Button>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>

        <Panel as="section">
          <PanelHeader>
            <h2 className="text-ink text-sm font-semibold">Coverage check</h2>
            <p className="text-ink-3 mt-1 text-xs leading-relaxed">
              Each camera's own floor-footprint area, compared to the median. A weak signal -
              catches gross scale errors only, a clean result here is not a green light.
            </p>
          </PanelHeader>
          <PanelBody>
            {coverage.unbounded.length > 0 && (
              <p className="text-ink-2 mb-2 text-xs leading-relaxed">
                {coverage.unbounded
                  .map((id) => cameras.find((c) => c.id === id)?.name ?? id)
                  .join(', ')}{' '}
                {coverage.unbounded.length === 1 ? 'sees' : 'see'} past the horizon, so the floor in
                view has no edge to measure. Left out of this comparison - that is normal for a
                camera mounted low or tilted up, not an alignment problem.
              </p>
            )}
            {coverage.median === null ? (
              <p className="text-ink-2 text-sm">
                Need at least 2 cameras whose whole view is floor to compare.
              </p>
            ) : (
              <>
                <ul className="space-y-1">
                  {Object.entries(coverage.areas).map(([id, area]) => (
                    <li key={id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-ink-2 min-w-0 flex-1 truncate">
                        {cameras.find((c) => c.id === id)?.name ?? id}
                      </span>
                      <span className="text-ink tabular text-xs">{area.toFixed(1)} m²</span>
                      {coverage.flagged.includes(id) && <Badge tone="warn">outlier</Badge>}
                    </li>
                  ))}
                </ul>
                {coverage.flagged.length > 0 && (
                  <p className="text-warn mt-2 text-xs leading-relaxed">
                    {coverage.flagged
                      .map((id) => cameras.find((c) => c.id === id)?.name ?? id)
                      .join(', ')}{' '}
                    {coverage.flagged.length === 1 ? 'covers' : 'cover'} a floor area wildly
                    different from the others, which usually means a scale error. Redo the alignment
                    with shared spots spread across the whole room, then check again.
                  </p>
                )}
              </>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  )
}

/**
 * The canvas itself: pan/zoom via CSS transform (scroll to zoom centered on
 * the cursor, drag to pan, entirely client-side - not the browser's native
 * page zoom, which would zoom the whole layout and give no pan control),
 * each included camera's frame warped through matrix3d(S @ Hinv) and
 * stacked at partial opacity for the ghosting effect, plus an SVG grid
 * drawn through the same S so a camera's own distortion (not just
 * disagreement with others) is visible independently.
 */
function BevCanvas({
  included,
  transform,
  showGrid,
  singleCamera,
}: {
  included: Included[]
  transform: { S: Mat3; bounds: { xmin: number; xmax: number; ymin: number; ymax: number } } | null
  showGrid: boolean
  singleCamera: string | null
}) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const cx = event.clientX - rect.left
    const cy = event.clientY - rect.top
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
    const nextZoom = Math.min(8, Math.max(1, zoom * factor))
    /* Zoom centred on the cursor: keep the world point currently under the
       cursor under the cursor after scaling, not the canvas corner. */
    setPan((current) => ({
      x: cx - ((cx - current.x) * nextZoom) / zoom,
      y: cy - ((cy - current.y) * nextZoom) / zoom,
    }))
    setZoom(nextZoom)
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
  }
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    const dx = event.clientX - dragRef.current.x
    const dy = event.clientY - dragRef.current.y
    setPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy })
  }
  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
  }

  const shown = singleCamera
    ? included.filter((entry) => entry.camera.id === singleCamera)
    : included

  return (
    <div
      className="bg-ink/90 relative overflow-hidden"
      style={{ width: CANVAS_SIZE, height: CANVAS_SIZE, maxWidth: '100%', touchAction: 'none' }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="absolute right-2 top-2 z-10">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Reset zoom
        </Button>
      </div>

      <div
        className="absolute inset-0 origin-top-left cursor-grab active:cursor-grabbing"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        {transform &&
          shown.map((entry) => {
            const M = multiply3x3(transform.S, entry.Hinv)
            const opacity = singleCamera ? 1 : Math.max(0.35, 1 / shown.length)
            return (
              <FrameLayer
                key={entry.camera.id}
                cameraId={entry.camera.id}
                matrix={toMatrix3d(M)}
                clip={visibleFloor(entry.Hinv, entry.imgW, entry.imgH).floor}
                opacity={opacity}
              />
            )
          })}

        {showGrid && transform && (
          <svg
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="pointer-events-none absolute inset-0"
          >
            <BevGrid S={transform.S} bounds={transform.bounds} />
          </svg>
        )}
      </div>
    </div>
  )
}

/** One camera's frame, warped by CSS matrix3d. transform-origin at the
 * top-left matches the pixel-space origin the homography assumes. */
function FrameLayer({
  cameraId,
  matrix,
  clip,
  opacity,
}: {
  cameraId: string
  matrix: string
  /** Frame-pixel polygon of the floor worth showing; everything past it
   * (sky, or floor too far away to read) would warp into a giant smear. */
  clip: Array<[number, number]>
  opacity: number
}) {
  const frame = useQuery({
    queryKey: ['nativeFrame', cameraId],
    queryFn: ({ signal }) => fetchNativeFrame(cameraId, signal),
    retry: false,
    staleTime: 5_000,
  })

  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!frame.data) return
    const url = URL.createObjectURL(frame.data)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [frame.data])

  if (!src) return null
  return (
    <img
      src={src}
      alt=""
      className="absolute left-0 top-0 origin-top-left mix-blend-screen"
      style={{
        transform: matrix,
        opacity,
        maxWidth: 'none',
        clipPath:
          clip.length >= 3
            ? `polygon(${clip.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ')})`
            : undefined,
      }}
    />
  )
}

function niceStep(span: number, targetLines = 10): number {
  const raw = span / Math.max(targetLines, 1)
  if (raw <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) {
    const step = m * magnitude
    if (step >= raw) return step
  }
  return 10 * magnitude
}

/** Fixed-spacing world-space gridlines through S - a straight, evenly
 * spaced grid is what a real floor SHOULD rectify to; visible warping in
 * one camera's own layer is a distortion signal independent of any other
 * camera. */
function BevGrid({
  S,
  bounds,
}: {
  S: Mat3
  bounds: { xmin: number; xmax: number; ymin: number; ymax: number }
}) {
  const step = niceStep(Math.max(bounds.xmax - bounds.xmin, bounds.ymax - bounds.ymin))
  const lines: React.ReactNode[] = []

  for (let x = Math.floor(bounds.xmin / step) * step; x <= bounds.xmax + step; x += step) {
    const [x1, y1] = applyMat3(S, [x, bounds.ymin])
    const [x2, y2] = applyMat3(S, [x, bounds.ymax])
    lines.push(
      <line key={`x${x}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4ade80" strokeWidth={1} />,
    )
  }
  for (let y = Math.floor(bounds.ymin / step) * step; y <= bounds.ymax + step; y += step) {
    const [x1, y1] = applyMat3(S, [bounds.xmin, y])
    const [x2, y2] = applyMat3(S, [bounds.xmax, y])
    lines.push(
      <line key={`y${y}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4ade80" strokeWidth={1} />,
    )
  }

  const origin = applyMat3(S, [0, 0])
  return (
    <>
      {lines}
      <circle cx={origin[0]} cy={origin[1]} r={5} fill="none" stroke="#facc15" strokeWidth={2} />
    </>
  )
}
