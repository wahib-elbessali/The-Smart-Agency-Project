import { registerMock, registerMockWriter } from '../registry'
import type { Camera, CameraCreate, CameraUpdate, WeaponThreshold } from '@/api/types'
import { ApiError } from '@/api/errors'
import * as store from '../cameraStore'
import { requestUser } from '../currentUser'
import { videoFrame } from '../videoFrames'

/**
 * Field names from CameraResponse / AIWeaponThresholdResponse in
 * backend/app/schemas/camera.py. contracts/api.md §11-12, added 2026-09-12.
 *
 * Agency scoping is enforced here rather than in cameraStore, for the same
 * reason agencyStore's `visibleTo` lives in its fixture file - this layer IS
 * the backend when mocks are on. cameras.py answers a non-ADMIN asking about
 * another branch with 403 "Acces limite a votre agence", on the list, the
 * create, and any camera whose agency is not theirs - so that is what these
 * do, rather than the 404 the agencies fixture uses (its route hides the
 * other branch's existence; this one does not).
 */
function ensureAgencyScope(agencyId: string): void {
  const user = requestUser()
  if (!user || user.role === 'ADMIN') return
  if (user.agency_id !== agencyId) {
    throw new ApiError('http', 'Acces limite a votre agence', 403)
  }
}

/** For /api/agencies/{agency_id}/cameras - the id is second-to-last. */
function agencyIdFrom(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function scopedList(path: string): Camera[] {
  const agencyId = agencyIdFrom(path)
  ensureAgencyScope(agencyId)
  return store.listCameras(agencyId)
}

registerMock<Camera[]>('GET /api/agencies/{id}/cameras', {
  normal: scopedList,
  empty: () => [],
  large: scopedList,
})

registerMockWriter('POST /api/agencies/{id}/cameras', (body, path) => {
  const agencyId = agencyIdFrom(path)
  ensureAgencyScope(agencyId)
  return store.createCamera(agencyId, body as CameraCreate)
})

registerMockWriter('PUT /api/cameras/{id}', (body, path) => {
  const id = lastSegment(path)
  ensureAgencyScope(store.getCamera(id).agency_id)
  return store.updateCamera(id, body as CameraUpdate)
})

registerMockWriter('DELETE /api/cameras/{id}', (_body, path) => {
  const id = lastSegment(path)
  ensureAgencyScope(store.getCamera(id).agency_id)
  store.deleteCamera(id)
  return undefined
})

/* Global, so no scoping: every branch's guard reads and writes the same one. */
registerMock<WeaponThreshold>('GET /api/ai-alerts/thresholds/weapon', {
  normal: () => store.getWeaponThreshold(),
  empty: () => store.getWeaponThreshold(),
  large: () => store.getWeaponThreshold(),
})

registerMockWriter('PUT /api/ai-alerts/thresholds/weapon', (body) =>
  store.setWeaponThreshold(body as WeaponThreshold),
)

/**
 * PROPOSED - GET /api/cameras/{id}/frame, see api/endpoints/cameras.ts.
 *
 * The real answer is a JPEG the detector is looking at; the fixture cannot
 * have one, so it draws a placard that says which camera it is, at 1920x1080
 * - the frame size the scripted weapon stream's bboxes are in (aiStreams.ts
 * puts the pistol around x 900-1350, y 330-660). The size matters more than
 * the picture: the live view draws boxes in the frame's own pixels, so a
 * mock frame of another size would put them in the wrong place and make the
 * overlay look broken when it is not.
 *
 * An OFFLINE camera answers 404, exactly as the AI service does for a source
 * it cannot open - the backend has never heard from that camera, so there is
 * no picture to forward.
 */
function placard(name: string): Blob {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#1c1f26"/>
  <rect x="48" y="48" width="1824" height="984" fill="none" stroke="#3a3f4b" stroke-width="4" stroke-dasharray="16 12"/>
  <text x="960" y="520" font-family="system-ui, sans-serif" font-size="64" fill="#9aa0ad" text-anchor="middle">${name}</text>
  <text x="960" y="600" font-family="system-ui, sans-serif" font-size="36" fill="#6b7180" text-anchor="middle">fixture frame - no camera connected</text>
</svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}

/**
 * A real frame when there is footage for this camera, the placard when
 * there is not.
 *
 * DROP AN .MP4 INTO frontend/public/fixtures AND THIS BECOMES USEFUL: see
 * mocks/videoFrames.ts. It matters most for the two screens built to be
 * clicked on a picture of a room - you cannot pick a floor tile out of a
 * grey placard, and you cannot find the same real spot in two of them.
 *
 * A camera with footage answers even when its `status` is not ONLINE. The
 * status means "the backend has heard from it", and in fixture mode the
 * file on disk is the better evidence - otherwise the one camera in the
 * other branch could never show anything. Delete its file to get the 404
 * back and see how the screens handle a dead stream.
 */
async function frameFor(path: string): Promise<Blob> {
  const parts = path.split('?')[0].split('/').filter(Boolean)
  /* `native=true` may be on the query string (calibration wants the
     unscaled frame); the id is still the segment before 'frame'. */
  const id = parts[parts.length - 2] ?? ''
  const camera = store.getCamera(id)
  ensureAgencyScope(camera.agency_id)

  const fromVideo = await videoFrame(camera.name)
  if (fromVideo) return fromVideo

  if (camera.status !== 'ONLINE') {
    throw new ApiError('http', 'Flux camera indisponible', 404)
  }
  return placard(camera.name)
}

registerMock<Blob>('GET /api/cameras/{id}/frame', {
  normal: frameFor,
  empty: frameFor,
  large: frameFor,
})
