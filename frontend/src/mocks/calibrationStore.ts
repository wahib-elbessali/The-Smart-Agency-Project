import type {
  AlignResult,
  CalibrationRectRequest,
  CalibrationRectResult,
  CameraCalibration,
  CrossCheckResult,
  Gate,
  SharedPoint,
} from '@/api/types'
import { ApiError } from '@/api/errors'

/**
 * Calibration state for mock mode.
 *
 * WHAT THIS DOES NOT DO, said plainly so nobody reads the numbers as real:
 * there is no homography here, no vanishing-point inference, no BFS over
 * camera pairs. Perspective geometry is the AI service's job and faking it
 * would produce numbers that look authoritative and mean nothing.
 *
 * What it does reproduce is the BEHAVIOUR the screen has to get right, which
 * is where the frontend bugs live:
 *
 *   - exactly 4 points or 422
 *   - a camera is calibrated but NOT aligned until alignment runs
 *   - alignment needs >=2 calibrated cameras (400 otherwise) and >=2 shared
 *     points tying a camera to the reference, or that camera comes back
 *     `aligned: false` WITH the call still returning 200
 *   - fewer than 4 shared points leaves the camera's own rectangle in charge,
 *     which is what `weak_fits` warns about
 *
 * The aspect is a crude ratio of the clicked quad's sides rather than an
 * inference, and `aspect_confident` is true whenever the quad is not almost
 * degenerate. Enough to exercise both branches of the screen's warning; not
 * enough to believe.
 */

interface StoredCalibration {
  camera_id: string
  aligned: boolean
  diagnostics: CameraCalibration['diagnostics']
  Hinv: number[][]
}

let calibrations: StoredCalibration[] | null = null

function state(): StoredCalibration[] {
  if (calibrations === null) calibrations = []
  return calibrations
}

/* A short, deterministic hash - enough to spread fake per-camera values
   without needing real geometry, not a real hash function. Also used by
   crossCheckCameras below. */
function hashString(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * A fake, AFFINE-ONLY Hinv (no perspective term - g=h=0, i=1 always), same
 * "there is no homography here" disclaimer as the rest of this file. What
 * it DOES reproduce, and why this exists at all: alignment is supposed to
 * pull every camera's independently-invented frame toward agreement, and
 * the BEV overlay's whole point is making that visible. So an UNALIGNED
 * camera gets a frame that wanders far from a shared "world truth" base
 * (large per-camera rotation/scale/offset noise, seeded off its own id -
 * every camera invents its own), while an ALIGNED one stays close to that
 * same base (small noise only) - real ghosting when unaligned, real
 * convergence once aligned, exactly the thing an operator is supposed to
 * be able to see happen. */
const WORLD_BASE = { scale: 0.006, angle: 0 }

function fakeHinv(cameraId: string, aligned: boolean): number[][] {
  const seed = hashString(cameraId)
  const noise = aligned ? 0.12 : 1
  const angle = WORLD_BASE.angle + (((seed % 40) - 20) * Math.PI) / 180 / (aligned ? 4 : 1)
  const scale = WORLD_BASE.scale * (1 + (((seed >> 4) % 5) - 2) * 0.04 * noise)
  const tx = (((seed >> 8) % 10) - 5) * noise
  const ty = (((seed >> 12) % 10) - 5) * noise
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    [scale * cos, -scale * sin, tx],
    [scale * sin, scale * cos, ty],
    [0, 0, 1],
  ]
}

export function listCalibration(): CameraCalibration[] {
  return state().map((entry) => ({
    camera_id: entry.camera_id,
    aligned: entry.aligned,
    diagnostics: { ...entry.diagnostics },
    Hinv: entry.Hinv.map((row) => [...row]),
  }))
}

function sideLength(a: [number, number], b: [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

export function calibrateRect(body: CalibrationRectRequest): CalibrationRectResult {
  const points = body.points ?? []
  if (points.length !== 4) {
    throw new ApiError('http', 'La calibration demande exactement 4 points', 422)
  }
  if (!body.img_w || !body.img_h) {
    throw new ApiError('http', 'img_w et img_h sont obligatoires', 422)
  }

  const top = sideLength(points[0], points[1])
  const side = sideLength(points[1], points[2])
  /* Near-collinear points make the real solve meaningless, and the service
     answers 422 for them - so a quad with a side of nothing does here too. */
  if (top < 10 || side < 10) {
    throw new ApiError('http', 'Points trop proches ou alignes', 422)
  }

  const aspect = Number((top / side).toFixed(3))
  const confident = aspect > 0.2 && aspect < 5

  const diagnostics: CameraCalibration['diagnostics'] = {
    n_points: 4,
    /* ~0 by construction, exactly as the real fit reports - kept so the
       screen has the misleading number to NOT present as accuracy. */
    px_err_mean: 2.9e-13,
    px_err_max: 3.4e-13,
    aspect_source: confident
      ? 'vanishing-point inference'
      : 'vanishing-point inference -- LOW CONFIDENCE, verify by dragging the 4th corner',
    inferred_aspect: aspect,
    aspect_stability_std: confident ? 0.02 : 0.41,
    aspect_confident: confident,
    calib_res: [body.img_w, body.img_h],
  }

  const list = state()
  const existing = list.findIndex((entry) => entry.camera_id === body.camera_id)
  /* Re-calibrating drops alignment: the camera's floor frame just changed,
     so whatever it was reconciled with no longer holds. */
  const entry: StoredCalibration = {
    camera_id: body.camera_id,
    aligned: false,
    diagnostics,
    Hinv: fakeHinv(body.camera_id, false),
  }
  if (existing === -1) list.push(entry)
  else list[existing] = entry

  return { ...diagnostics, aligned: false }
}

export function alignCameras(points: SharedPoint[]): AlignResult {
  /* Deliberately the WHOLE calibrated list, not scoped to the cameras named
     in `points` - this matches the real service exactly (engine.py's own
     align_cameras(cal, align_points) BFS's from the whole calibrated set,
     using `points` only to find which pairs are connected), and it is what
     makes "a camera nothing connects to comes back aligned: false, not
     silently dropped from the response" possible at all - see the test
     this reproduces. An earlier version of this function scoped to
     `points` specifically to close an agency-leak here, which was the
     wrong layer for that fix: it also broke this real, load-bearing
     behavior. The actual fix belongs in fixtures/calibration.ts, which
     filters `results` down to cameras the caller may see AFTER calling
     this - the same place every other list here (visibleZones, `visible`
     for GET /calibration) already does its scoping, post-hoc rather than
     by starving the underlying computation of data it legitimately needs. */
  const list = state()
  if (list.length < 2) {
    throw new ApiError('http', 'Au moins deux cameras doivent etre calibrees', 400)
  }

  /* The real service picks the most trustworthy camera, not the first. This
     picks the first, and says so rather than implying a judgement. */
  const reference = list[0].camera_id
  const results: AlignResult['results'] = {
    [reference]: { aligned: true, reference: true, n_points: null, via: null },
  }

  const weak: string[] = []
  for (const entry of list.slice(1)) {
    const shared = points.filter(
      (point) => point[entry.camera_id] !== undefined && point[reference] !== undefined,
    ).length

    if (shared >= 2) {
      entry.aligned = true
      entry.Hinv = fakeHinv(entry.camera_id, true)
      entry.diagnostics = {
        ...entry.diagnostics,
        aligned: true,
        aligned_to: reference,
        aligned_with_n_points: shared,
        fit: shared >= 4 ? 'homography' : shared === 3 ? 'affine' : 'similarity',
        aspect_superseded: shared >= 4,
      }
      results[entry.camera_id] = {
        aligned: true,
        reference: false,
        n_points: shared,
        via: reference,
      }
      if (shared < 4) weak.push(entry.camera_id)
    } else {
      entry.aligned = false
      entry.Hinv = fakeHinv(entry.camera_id, false)
      results[entry.camera_id] = {
        aligned: false,
        reference: false,
        n_points: shared,
        via: null,
        error:
          'no chain of >=2-point camera pairs connects this camera back to the reference -- record more shared points involving it',
      }
    }
  }

  list[0].aligned = true
  list[0].Hinv = fakeHinv(list[0].camera_id, true)
  list[0].diagnostics = { ...list[0].diagnostics, aligned: true }

  return {
    reference,
    results,
    /* EMPTY, on purpose.
       
       This used to return distance_cm: 0 for every recorded spot, which read
       on screen as "the cameras agree perfectly" - the most flattering
       possible claim, made by a fixture that solved no geometry at all and
       printed next to a camera that had just failed to align. The real
       service computes these from the corrected homographies. Nothing here
       can, so it says nothing and the screen omits the line. */
    residual_checks: [],
    weak_fits:
      weak.length > 0
        ? `camera(s) ${weak.join(', ')} were aligned with <4 shared points, so their own rectangle still determines their world frame. If any of them shows a bad aspect, click more shared points (>=4) to replace it outright.`
        : null,
  }
}

export function deleteCalibration(cameraId: string): void {
  const list = state()
  const index = list.findIndex((entry) => entry.camera_id === cameraId)
  if (index === -1) throw new ApiError('http', 'Camera non calibree', 404)
  list.splice(index, 1)
}

/**
 * Read-only, same "no real homography" disclaimer as the rest of this file.
 * What it DOES reproduce is the refusal behaviour: every named camera must
 * already be calibrated AND aligned, or this throws 422 rather than
 * returning a comparison that means nothing - exactly like the real
 * service, which refuses for the same reason (cross-checking an unaligned
 * camera doesn't verify anything, it has no shared frame to verify against
 * yet).
 */
export function crossCheckCameras(points: SharedPoint): CrossCheckResult {
  const camIds = Object.keys(points)
  if (camIds.length < 2) {
    throw new ApiError('http', 'Il faut le meme point dans au moins 2 cameras', 422)
  }

  const list = state()
  const missing = camIds.filter((id) => !list.some((entry) => entry.camera_id === id))
  if (missing.length > 0) {
    throw new ApiError('http', `Camera(s) non calibree(s): ${missing.join(', ')}`, 422)
  }
  const unaligned = camIds.filter((id) => !list.find((entry) => entry.camera_id === id)?.aligned)
  if (unaligned.length > 0) {
    throw new ApiError(
      'http',
      `Camera(s) non alignee(s): ${unaligned.join(', ')} - executez d'abord l'alignement`,
      422,
    )
  }

  /* Deterministic per-camera fake "world" position derived from the clicked
     pixel and a hash of the camera id - consistent enough across calls with
     the same inputs to be usable in a test, spread out enough that
     different camera pairs produce visibly different pairwise distances. */
  const worlds: Record<string, [number, number]> = {}
  for (const id of camIds) {
    const [px, py] = points[id]
    const seed = hashString(id)
    worlds[id] = [
      Number((px / 100 + (seed % 7) * 0.05).toFixed(1)),
      Number((py / 100 + ((seed >> 3) % 7) * 0.05).toFixed(1)),
    ]
  }

  const sorted = [...camIds].sort()
  const pairs: CrossCheckResult['pairs'] = []
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]
      const b = sorted[j]
      const dist = Math.hypot(worlds[a][0] - worlds[b][0], worlds[a][1] - worlds[b][1])
      pairs.push({ cam_a: a, cam_b: b, distance_cm: Number(dist.toFixed(1)) })
    }
  }
  return { worlds, pairs }
}

let gates: Array<[number, number]> | null = null

function gateState(): Array<[number, number]> {
  if (gates === null) gates = []
  return gates
}

export function listGates(): Array<[number, number]> {
  return gateState().map(([x, y]) => [x, y])
}

/**
 * REPLACES the whole list every call, same convention as alignCameras - the
 * frontend accumulates gate clicks locally and resends the full set. Each
 * entry's camera must already be calibrated, or 422; its pixel points
 * convert to a fake world coordinate the same crude way calibrateRect's
 * aspect number is crude, consistent rather than accurate.
 */
export function saveGates(entries: Gate[]): Array<[number, number]> {
  const list = state()
  const world: Array<[number, number]> = []
  for (const entry of entries) {
    if (!list.some((c) => c.camera_id === entry.camera)) {
      throw new ApiError('http', `Camera ${entry.camera} non calibree`, 422)
    }
    for (const [px, py] of entry.points) {
      world.push([Number((px / 100).toFixed(2)), Number((py / 100).toFixed(2))])
    }
  }
  gates = world
  return listGates()
}

export function clearGates(): void {
  gates = []
}

/** Tests only - module state would otherwise leak between them. */
export function resetCalibrationStore(): void {
  calibrations = null
  gates = null
}
