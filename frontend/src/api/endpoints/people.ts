import { fetchJson } from '../client'
import type { PeopleSources, PeopleSourcesUpdate, PeopleStatus } from '../types'

/**
 * Person tracking — PROPOSED, not in contracts/api.md.
 *
 * ai/features/person_tracking/api.py's /people, proxied by the backend for
 * the same reason everything AI-facing is (project rule, 2026-08-11). No
 * POST /people/start exists on the real service and none is added here -
 * bootstrap is automatic once >=2 registered cameras are calibrated AND
 * aligned, see PeopleStatus's doc comment in api/types.ts.
 *
 * `camera_ids` below are OUR uuids, same "the browser never sees a stream
 * URL" rule as zones.ts's `camera_id` / `extra_camera_ids` - the backend
 * resolves each one and builds the AI service's `sources: {camera: url}`
 * map itself. /people keeps its OWN source registry, independent of
 * zoning's - registering a camera for a world zone does not register it
 * here too, by design (every feature's registry is independent, per
 * ai/reference_ui/console's own README).
 *
 * The live stream itself (WS /people/tracks/stream) is in
 * api/endpoints/streams.ts, alongside the alert/occupancy streams it shares
 * the reconnect machinery with.
 */

/**
 * Phase/warnings/error/scale/room/fps only. `sources_known`/`calibrated`/
 * `aligned` are NOT here despite this module's own docstring claiming they
 * are - verified against the actually running service (2026-09-23), that
 * docstring is stale. They're on fetchPeopleSources below instead.
 */
export function fetchPeopleStatus(signal?: AbortSignal): Promise<PeopleStatus> {
  return fetchJson<PeopleStatus>(
    { key: 'GET /api/people/status', path: '/api/people/status', auth: true },
    { signal },
  )
}

export function fetchPeopleSources(signal?: AbortSignal): Promise<PeopleSources> {
  return fetchJson<PeopleSources>(
    { key: 'GET /api/people/sources', path: '/api/people/sources', auth: true },
    { signal },
  )
}

/** Merges into the registry - accumulates across calls, same convention as
 * every other feature's own /sources. */
export function registerPeopleSources(
  cameraIds: string[],
  signal?: AbortSignal,
): Promise<PeopleSourcesUpdate> {
  return fetchJson<PeopleSourcesUpdate>(
    {
      key: 'POST /api/people/sources',
      path: '/api/people/sources',
      method: 'POST',
      auth: true,
    },
    { signal, body: { camera_ids: cameraIds } },
  )
}

/** Stops watching one camera. Adding/removing a camera invalidates any
 * current bootstrap and re-triggers one, same as the real service. Returns
 * just {camera, deleted} - unlike POST, it doesn't recompute sources/
 * calibrated/aligned/warnings, so re-fetch fetchPeopleSources afterward
 * rather than trusting this response for the new state. */
export function removePeopleSource(
  cameraId: string,
  signal?: AbortSignal,
): Promise<{ camera: string; deleted: boolean }> {
  return fetchJson<{ camera: string; deleted: boolean }>(
    {
      key: 'DELETE /api/people/sources/{camera}',
      path: `/api/people/sources/${encodeURIComponent(cameraId)}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
