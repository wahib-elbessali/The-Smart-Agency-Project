import { registerMock, registerMockWriter } from '../registry'
import type { PeopleSources, PeopleSourcesUpdate, PeopleStatus } from '@/api/types'
import {
  getPeopleSources,
  getPeopleStatus,
  registerPeopleSources,
  removePeopleSource,
} from '../peopleStore'

/**
 * PROPOSED - GET /api/people/status, GET/POST/DELETE /api/people/sources,
 * see api/endpoints/people.ts.
 *
 * No agency scoping here, same reasoning as calibration: /people tracks a
 * whole SITE, not a branch, and a tracked scene can span cameras from
 * different agencies by nature. Unlike zones/calibration this isn't
 * ADMIN+MANAGER only for reads - SECURITY can read the live map (a
 * monitoring view, same bucket as /alerts) but not touch the source
 * registry (mocks/roles.ts draws that split).
 */

registerMock<PeopleStatus>('GET /api/people/status', {
  normal: getPeopleStatus,
  empty: () => ({
    phase: 'idle',
    person_scale: null,
    room: null,
    fps: null,
    warnings: ['need >=2 registered cameras for cross-camera tracking'],
    error: null,
    cams_bootstrapped: null,
    gates_loaded: null,
    active_tracks: null,
  }),
  large: getPeopleStatus,
})

registerMock<PeopleSources>('GET /api/people/sources', {
  normal: getPeopleSources,
  empty: () => ({ sources_known: [], calibrated: [], aligned: [] }),
  large: getPeopleSources,
})

registerMockWriter('POST /api/people/sources', (body): PeopleSourcesUpdate => {
  const payload = body as { camera_ids: string[] }
  registerPeopleSources(payload.camera_ids ?? [])
  return { ...getPeopleSources(), warnings: getPeopleStatus().warnings }
})

registerMockWriter('DELETE /api/people/sources/{camera}', (_body, path) => {
  const parts = path.split('/').filter(Boolean)
  const cameraId = decodeURIComponent(parts[parts.length - 1] ?? '')
  removePeopleSource(cameraId)
  return { camera: cameraId, deleted: true }
})
