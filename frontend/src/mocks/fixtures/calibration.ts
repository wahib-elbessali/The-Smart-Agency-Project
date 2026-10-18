import { registerMock, registerMockWriter } from '../registry'
import type { CalibrationRectRequest, CameraCalibration, Gate, SharedPoint } from '@/api/types'
import { ApiError } from '@/api/errors'
import * as cameras from '../cameraStore'
import * as store from '../calibrationStore'
import { requestUser } from '../currentUser'

/**
 * PROPOSED - the /api/calibration routes, see api/endpoints/calibration.ts.
 *
 * Scoped through the camera, like zones: the AI service knows nothing about
 * agencies, so the proxy is what keeps one branch's geometry out of
 * another's list. A calibration whose camera has since been deleted is
 * dropped from a non-admin's view rather than shown unattributed.
 */

function agencyOfCamera(cameraId: string): string | null {
  try {
    return cameras.getCamera(cameraId).agency_id
  } catch {
    return null
  }
}

function ensureCameraScope(cameraId: string): void {
  const user = requestUser()
  const agencyId = agencyOfCamera(cameraId)
  if (agencyId === null) throw new ApiError('http', 'Camera introuvable', 404)
  if (!user || user.role === 'ADMIN') return
  if (user.agency_id !== agencyId) {
    throw new ApiError('http', 'Acces limite a votre agence', 403)
  }
}

function visible(): CameraCalibration[] {
  const user = requestUser()
  const all = store.listCalibration()
  if (!user || user.role === 'ADMIN') return all
  return all.filter((entry) => agencyOfCamera(entry.camera_id) === user.agency_id)
}

registerMock<CameraCalibration[]>('GET /api/calibration', {
  normal: visible,
  empty: () => [],
  large: visible,
})

registerMockWriter('POST /api/calibration/rect', (body) => {
  const payload = body as CalibrationRectRequest
  ensureCameraScope(payload.camera_id)
  return store.calibrateRect(payload)
})

registerMockWriter('POST /api/calibration/align', (body) => {
  const payload = body as { points: SharedPoint[] }
  /* Every camera named in a shared point has to be one the caller may
     touch - alignment rewrites the geometry of all of them at once. */
  for (const point of payload.points ?? []) {
    for (const cameraId of Object.keys(point)) ensureCameraScope(cameraId)
  }

  const result = store.alignCameras(payload.points ?? [])

  const user = requestUser()
  if (!user || user.role === 'ADMIN') return result

  /* store.alignCameras() genuinely runs over the WHOLE calibrated site, not
     just the cameras this caller named - that's real, load-bearing service
     behavior (see its own comment), which means its response can legitimately
     include another agency's camera: as the chosen `reference`, or as an
     entry in `results` the BFS reached through a chain the caller never
     asked about. Every entry not in the caller's own agency is dropped here,
     the same place every other list in this file is scoped, rather than by
     starving the underlying computation of data it legitimately needs. If
     the reference itself isn't visible, its entry (and everything chained
     through it) drops out along with it - describing an alignment relative
     to a camera the caller cannot see would leak that camera's existence
     for no benefit, since the caller has no way to act on the result either
     way. */
  const visibleResults = Object.fromEntries(
    Object.entries(result.results).filter(
      ([cameraId]) => agencyOfCamera(cameraId) === user.agency_id,
    ),
  )
  return { ...result, results: visibleResults }
})

registerMockWriter('DELETE /api/calibration/{id}', (_body, path) => {
  const parts = path.split('/').filter(Boolean)
  const cameraId = parts[parts.length - 1] ?? ''
  ensureCameraScope(cameraId)
  store.deleteCalibration(cameraId)
  return undefined
})

registerMockWriter('POST /api/calibration/cross_check', (body) => {
  const payload = body as { points: SharedPoint }
  /* Same "every named camera has to be one the caller may touch" rule as
     align - read-only doesn't mean unscoped, it would still reveal another
     agency's camera existing and how it's calibrated. */
  for (const cameraId of Object.keys(payload.points ?? {})) ensureCameraScope(cameraId)
  return store.crossCheckCameras(payload.points ?? {})
})

registerMock<Array<[number, number]>>('GET /api/calibration/gates', {
  normal: () => store.listGates(),
  empty: () => [],
  large: () => store.listGates(),
})

registerMockWriter('POST /api/calibration/gates', (body) => {
  const payload = body as { gates: Gate[] }
  for (const entry of payload.gates ?? []) ensureCameraScope(entry.camera)
  return store.saveGates(payload.gates ?? [])
})

registerMockWriter('DELETE /api/calibration/gates', () => {
  /* Not scoped to one camera - gates are stored as camera-agnostic world
     coordinates once saved, same as the real service, so there is no
     single agency to check against a clear-all. ADMIN and MANAGER already
     gate this route (see mocks/roles.ts); an agency-scoped delete would
     need the real backend to track which agency created which gate, which
     nothing here does. */
  store.clearGates()
  return undefined
})
