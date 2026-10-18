import { registerMock, registerMockWriter } from '../registry'
import type { CameraZone, CameraZoneCreate } from '@/api/types'
import { ApiError } from '@/api/errors'
import * as cameras from '../cameraStore'
import * as store from '../zoneStore'
import { requestUser } from '../currentUser'

/**
 * PROPOSED - GET/POST /api/zones and DELETE /api/zones/{name}, see
 * api/endpoints/zones.ts. Field names from contracts/ai-service.md §/zoning;
 * `camera_id` is the one field that is ours rather than the AI service's,
 * because the browser speaks our camera UUIDs and the AI service speaks the
 * names the backend registered them under.
 *
 * SCOPING IS THE INTERESTING PART, and it is a claim about what the backend
 * proxy should do rather than a transcription of something that exists.
 *
 * The AI service has no notion of an agency at all - one site, one flat zone
 * store, no owner on a zone. Our backend does, and the only thing tying a
 * zone to a branch is the camera it was drawn on. So this answers a MANAGER
 * with the zones on their own branch's cameras and nothing else, and refuses
 * a write against another branch's camera with the 403 cameras.py already
 * answers ("Acces limite a votre agence"). If backend proxies these routes
 * without that filter, every manager will see every branch's zones - which
 * is why it is written down here rather than
 * left to be discovered.
 *
 * A PIXEL zone whose `camera_id` is null - the proxy could not match the AI
 * service's camera name to any camera row - belongs to no branch, so only an
 * ADMIN sees it. It is not nothing: a renamed camera produces exactly that.
 *
 * A WORLD zone's `camera_id` is ALSO always null, but for a different reason
 * entirely (see CameraZone's doc comment) - it is not broken, a world zone
 * genuinely has no single owning camera. Scoped instead through
 * `converted_from.camera` when present (the camera it was drawn on, before
 * conversion) - same rule as ensureCameraScope below. A world zone with no
 * `converted_from` (made some other way, not through this dashboard) has
 * nothing to scope it by at all, so it falls back to ADMIN-only, same as an
 * orphan - not because it is broken, but because nothing here can prove
 * which branch it belongs to.
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

/** Which agency a zone belongs to, or null if nothing here can prove one -
 * a pixel zone reads it straight from camera_id, a world zone falls back to
 * converted_from.camera (see the header comment above). */
function agencyOfZone(zone: CameraZone): string | null {
  if (zone.camera_id !== null) return agencyOfCamera(zone.camera_id)
  if (zone.converted_from) return agencyOfCamera(zone.converted_from.camera)
  return null
}

function visibleZones(): CameraZone[] {
  const user = requestUser()
  const all = store.listZones()
  if (!user || user.role === 'ADMIN') return all
  return all.filter((zone) => agencyOfZone(zone) === user.agency_id)
}

registerMock<CameraZone[]>('GET /api/zones', {
  normal: visibleZones,
  empty: () => [],
  large: visibleZones,
})

registerMockWriter('POST /api/zones', (body) => {
  const payload = body as CameraZoneCreate
  /* Every camera this zone touches has to be one the caller may write
     against - world mode fuses across `extra_camera_ids` too, and skipping
     those would let a MANAGER quietly fuse another agency's camera into a
     zone by naming it as an extra rather than the drawn-on one. */
  ensureCameraScope(payload.camera_id)
  for (const id of payload.extra_camera_ids ?? []) ensureCameraScope(id)
  return store.createZone(payload)
})

registerMockWriter('DELETE /api/zones/{name}', (_body, path) => {
  const parts = path.split('/').filter(Boolean)
  const name = decodeURIComponent(parts[parts.length - 1] ?? '')
  const zone = store.listZones().find((z) => z.name === name)
  if (!zone) throw new ApiError('http', 'Zone introuvable', 404)
  /* A zone with no provable branch (orphan, or a world zone with no
     converted_from) has no camera-scope check to run, so only the role rule
     applies - and that is ADMIN and MANAGER already. */
  const agencyId = agencyOfZone(zone)
  if (agencyId !== null) {
    const user = requestUser()
    if (user && user.role !== 'ADMIN' && user.agency_id !== agencyId) {
      throw new ApiError('http', 'Acces limite a votre agence', 403)
    }
  }
  store.deleteZone(name)
  return undefined
})
