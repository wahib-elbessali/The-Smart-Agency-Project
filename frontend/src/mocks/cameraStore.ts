import type { Camera, CameraCreate, CameraUpdate, WeaponThreshold } from '@/api/types'
import { ApiError } from '@/api/errors'
import { AGENCY_ID, AGENCY_ID_RABAT } from './fixtures/people'

/**
 * A writable camera list for mock mode, scoped per agency, plus the one
 * global weapon threshold.
 *
 * Same reasoning as serviceStore: the Cameras screen exists to add, rename and
 * remove these, so a frozen fixture would make every write look like it
 * silently failed.
 *
 * The seeded names are the same three the mock alert streams speak about
 * (aiStreams.ts: cam-lobby, cam-counter, cam-store), on purpose - in mock
 * mode the Alerts screen and this list should describe the same cameras, the
 * way the real AI source registry and this table do. Rename one here and the
 * Alerts screen keeps its old name, exactly as it would against the backend
 * until the consumer re-syncs.
 *
 * Refusals mirror backend/app/api/cameras.py, same status code:
 *   409  the `name` or the `stream_url` collides with any camera at any
 *        branch (both unique globally; stream_url since backend #113)
 *   422  `name` or `stream_url` is blank after trimming; or the threshold is
 *        not in (0, 1]
 *   404  the camera does not exist
 */

export const CAMERA_ID_LOBBY = 'c1000000-0000-4000-8000-000000000001'
export const CAMERA_ID_COUNTER = 'c1000000-0000-4000-8000-000000000002'
export const CAMERA_ID_STORE = 'c1000000-0000-4000-8000-000000000003'

let cameras: Camera[] | null = null
let nextId = 6000
let threshold: WeaponThreshold | null = null

function seed(): Camera[] {
  if (cameras === null) {
    cameras = [
      /* Both Casablanca cameras are ONLINE because both are in the mock
         weapon stream's opening snapshot (aiStreams.ts), and the backend flips
         a camera to ONLINE on its first stream event. cam-counter is also the
         one the scripted pistol appears on, so the live view has something to
         draw. */
      {
        id: CAMERA_ID_LOBBY,
        agency_id: AGENCY_ID,
        name: 'cam-lobby',
        stream_url: 'rtsp://192.168.1.16:8554/lobby',
        status: 'ONLINE',
      },
      {
        id: CAMERA_ID_COUNTER,
        agency_id: AGENCY_ID,
        name: 'cam-counter',
        stream_url: 'rtsp://192.168.1.17:8554/counter',
        status: 'ONLINE',
      },
      /* In Rabat, so an ADMIN switching branches sees the list change and a
         Casablanca MANAGER never sees it - and so the global uniqueness of
         `name` has something in another branch to collide with. OFFLINE
         because the mock streams never mention it, which also makes it the
         camera whose frame answers 404. */
      {
        id: CAMERA_ID_STORE,
        agency_id: AGENCY_ID_RABAT,
        name: 'cam-store',
        stream_url: 'rtsp://192.168.2.10:8554/store',
        status: 'OFFLINE',
      },
    ]
  }
  return cameras
}

export function listCameras(agencyId: string): Camera[] {
  return seed()
    .filter((c) => c.agency_id === agencyId)
    .map((c) => ({ ...c }))
}

export function getCamera(id: string): Camera {
  const found = seed().find((c) => c.id === id)
  if (!found) throw new ApiError('http', 'Camera introuvable', 404)
  return { ...found }
}

function assertUniqueName(name: string, excludingId?: string): void {
  const clash = seed().some((c) => c.name === name && c.id !== excludingId)
  if (clash) throw new ApiError('http', 'Le nom de la camera est deja utilise', 409)
}

function assertUniqueStream(streamUrl: string, excludingId?: string): void {
  const clash = seed().some((c) => c.stream_url === streamUrl && c.id !== excludingId)
  if (clash) {
    throw new ApiError('http', 'Le flux de la camera est deja utilise par une autre camera', 409)
  }
}

export function createCamera(agencyId: string, body: CameraCreate): Camera {
  const name = body.name.trim()
  const streamUrl = body.stream_url.trim()
  if (!name || !streamUrl) {
    throw new ApiError('http', 'Le nom et le flux de la camera sont obligatoires', 422)
  }
  assertUniqueStream(streamUrl)
  assertUniqueName(name)

  const created: Camera = {
    id: `c9000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`,
    agency_id: agencyId,
    name,
    stream_url: streamUrl,
    status: 'OFFLINE',
  }
  seed().push(created)
  return { ...created }
}

export function updateCamera(id: string, body: CameraUpdate): Camera {
  const list = seed()
  const index = list.findIndex((c) => c.id === id)
  if (index === -1) throw new ApiError('http', 'Camera introuvable', 404)

  const current = list[index]
  const updated: Camera = { ...current }
  if (body.name !== undefined) {
    const name = body.name.trim()
    if (!name) throw new ApiError('http', 'Le nom de la camera est obligatoire', 422)
    assertUniqueName(name, id)
    updated.name = name
  }
  if (body.stream_url !== undefined) {
    const streamUrl = body.stream_url.trim()
    if (!streamUrl) throw new ApiError('http', 'Le flux de la camera est obligatoire', 422)
    assertUniqueStream(streamUrl, id)
    updated.stream_url = streamUrl
  }
  list[index] = updated
  return { ...updated }
}

export function deleteCamera(id: string): void {
  const list = seed()
  const index = list.findIndex((c) => c.id === id)
  if (index === -1) throw new ApiError('http', 'Camera introuvable', 404)
  list.splice(index, 1)
}

/** The contract's own example value. */
/** The AI service knows cameras by name; the alert consumer maps back by it. */
export function findCameraByName(name: string): Camera | undefined {
  const found = seed().find((c) => c.name === name)
  return found ? { ...found } : undefined
}

export function getWeaponThreshold(): WeaponThreshold {
  if (threshold === null) threshold = { confidence: 0.6 }
  return { ...threshold }
}

/** Field(gt=0, le=1) - a 422 outside that, the same as Pydantic's. */
export function setWeaponThreshold(body: WeaponThreshold): WeaponThreshold {
  const value = body.confidence
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ApiError('http', 'confidence doit etre > 0 et <= 1', 422)
  }
  threshold = { confidence: value }
  return { ...threshold }
}

/** Tests only - module state would otherwise leak between them. */
export function resetCameraStore(): void {
  cameras = null
  nextId = 6000
  threshold = null
}
