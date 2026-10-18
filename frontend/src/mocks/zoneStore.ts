import type { CameraZone, CameraZoneCreate, CameraZoneSaved, ZoneRestriction } from '@/api/types'
import { ApiError } from '@/api/errors'
import { listCalibration } from './calibrationStore'
import { CAMERA_ID_COUNTER, CAMERA_ID_LOBBY, CAMERA_ID_STORE } from './cameraStore'
import { isPeopleRunning } from './peopleStore'

/**
 * A writable set of detection zones for mock mode.
 *
 * THE SEEDED NAMES ARE THE OCCUPANCY STREAM'S NAMES, on purpose: lobby,
 * counters and vault are exactly the three zones mocks/aiStreams.ts pushes
 * counts for. In fixture mode the Occupancy screen and this screen should
 * describe the same site, the way the AI service's single zone store does
 * for real - draw a zone here and the occupancy feed has no idea (it is a
 * scripted replay), but at least the two lists are not describing different
 * buildings. Same reasoning as cameraStore seeding the alert stream's camera
 * names.
 *
 * Refusals mirror contracts/ai-service.md §/zoning:
 *   422  fewer than 3 points, or a blank name
 *   404  deleting a zone that does not exist
 *   NO 409 on a duplicate name - re-posting a name REPLACES that zone, mode
 *        included. That is the AI service's documented behaviour and it is
 *        reproduced rather than softened, because a screen built against a
 *        409 that never comes would be a screen built against nothing.
 */

let zones: CameraZone[] | null = null

function seed(): CameraZone[] {
  if (zones === null) {
    zones = [
      {
        name: 'lobby',
        mode: 'pixel',
        camera_id: CAMERA_ID_LOBBY,
        polygon_px: [
          [240, 620],
          [1180, 590],
          [1320, 980],
          [180, 1010],
        ],
        polygon_m: null,
      },
      {
        name: 'counters',
        mode: 'pixel',
        camera_id: CAMERA_ID_COUNTER,
        polygon_px: [
          [700, 420],
          [1500, 440],
          [1480, 820],
          [660, 800],
        ],
        polygon_m: null,
      },
      /* On the Rabat camera, so a Casablanca manager never sees it and an
         admin switching branches does. Also the only OFFLINE camera, which
         makes it the zone that exists on a camera with no picture to
         redraw it over - a real state, since a zone outlives the stream. */
      {
        name: 'vault',
        mode: 'pixel',
        camera_id: CAMERA_ID_STORE,
        polygon_px: [
          [520, 300],
          [1400, 330],
          [1380, 900],
          [500, 870],
        ],
        polygon_m: null,
      },
    ]
  }
  return zones
}

function clone(zone: CameraZone): CameraZone {
  return {
    ...zone,
    polygon_px: zone.polygon_px
      ? zone.polygon_px.map(([x, y]) => [x, y] as [number, number])
      : null,
    polygon_m: zone.polygon_m ? zone.polygon_m.map(([x, y]) => [x, y] as [number, number]) : null,
  }
}

export function listZones(): CameraZone[] {
  return seed().map(clone)
}

export function createZone(body: CameraZoneCreate): CameraZoneSaved {
  const name = body.name.trim()
  if (!name) throw new ApiError('http', 'Le nom de la zone est obligatoire', 422)
  if (!Array.isArray(body.polygon) || body.polygon.length < 3) {
    throw new ApiError('http', 'Une zone demande au moins 3 points', 422)
  }

  const extraIds = body.extra_camera_ids ?? []
  /* Mode is inferred from camera COUNT, exactly like the real service -
     never sent by the caller, never assumed from a flag. One camera:
     pixel. Two or more: world. */
  const world = extraIds.length > 0
  const allCameraIds = [body.camera_id, ...extraIds]

  const warnings: string[] = []
  let polygonM: Array<[number, number]> | null = null
  const originalPixelPolygon = body.polygon.map(
    ([x, y]) => [Math.round(x), Math.round(y)] as [number, number],
  )

  if (world) {
    const cal = listCalibration()
    /* Every camera in the fused set has to be calibrated AND aligned, not
       just the one the polygon was drawn on - converting through any
       uncalibrated/unaligned camera anchors the zone to that camera's own
       invented frame, which looks valid and makes fused counts silently
       wrong. Same refusal ai/features/zoning/api.py's _to_world enforces
       for the drawn-on camera; applied here to the whole set since an
       unaligned FUSED camera is exactly as dangerous as an unaligned
       drawn-on one. */
    for (const id of allCameraIds) {
      const entry = cal.find((c) => c.camera_id === id)
      if (!entry) {
        throw new ApiError(
          'http',
          `camera ${id} has no calibration - a world zone needs every fused camera calibrated first`,
          422,
        )
      }
      if (!entry.aligned) {
        throw new ApiError(
          'http',
          `camera ${id} is calibrated but not aligned to a shared frame - run alignment first`,
          422,
        )
      }
    }
    /* No real Hinv here either, same disclaimer as calibrationStore - a
       crude, deterministic pixel-to-fake-metre scale, consistent enough to
       exercise the screen's world-mode rendering, not a real projection. */
    polygonM = body.polygon.map(([x, y]) => [
      Number((x / 100).toFixed(2)),
      Number((y / 100).toFixed(2)),
    ])
    if (!isPeopleRunning()) {
      warnings.push(
        "'/people' is not currently running (idle/bootstrapping/error) - this zone will count 0 until it is. Register its cameras with /people, then check its status.",
      )
    }
  }

  /* camera_id is ALWAYS null for a world zone - not an orphan, the AI
     service's own stored shape has no single owning camera for one
     (ai/features/zoning/zones.py's zones_to_dict only writes a `camera`
     field for pixel zones). Zones.tsx treats this as a distinct, expected
     state, not the same "broken/unreachable" case as a pixel zone whose
     camera_id genuinely could not be matched. */
  const saved: CameraZone = {
    name,
    mode: world ? 'world' : 'pixel',
    camera_id: world ? null : body.camera_id,
    polygon_px: world ? null : originalPixelPolygon,
    polygon_m: polygonM,
    converted_from: world ? { camera: body.camera_id, polygon_px: originalPixelPolygon } : null,
  }

  const list = seed()
  const existing = list.findIndex((zone) => zone.name === name)
  if (existing === -1) list.push(saved)
  else list[existing] = saved

  /* Empty for a pixel zone on a healthy service - the AI service's
     documented warnings only ever apply to world zones (/people not
     running) or to camera assignment, neither of which a pixel zone
     touches. */
  return { ...clone(saved), warnings }
}

/** Who may stand in a world zone (PUT /api/zones/{name}/restriction). */
export function setZoneRestriction(name: string, restriction: ZoneRestriction): void {
  const zone = seed().find((z) => z.name === name)
  if (!zone) throw new ApiError('http', 'Zone introuvable', 404)
  if (restriction !== 'anyone' && zone.mode !== 'world') {
    throw new ApiError(
      'http',
      'Seule une zone world (suivi des personnes) peut etre surveillee',
      422,
    )
  }
  zone.restriction = restriction
}

export function deleteZone(name: string): void {
  const list = seed()
  const index = list.findIndex((zone) => zone.name === name)
  if (index === -1) throw new ApiError('http', 'Zone introuvable', 404)
  list.splice(index, 1)
}

/** Tests only - module state would otherwise leak between them. */
export function resetZoneStore(): void {
  zones = null
}
