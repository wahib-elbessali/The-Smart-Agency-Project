import { fetchJson } from '../client'
import type {
  CameraZone,
  CameraZoneCreate,
  CameraZoneSaved,
  Intruder,
  ZoneRestriction,
} from '../types'

/**
 * Detection zones — PROPOSED, not in contracts/api.md (2026-09-19).
 *
 * These are the polygons the AI service counts people inside
 * (contracts/ai-service.md §/zoning). They are NOT `Agency.zones`; see the
 * comment on `CameraZone` in api/types.ts for why two unrelated things share
 * the word.
 *
 * WHY THESE GO THROUGH THE BACKEND
 *
 * ai/reference_ui/console calls the AI service's /zoning routes directly and
 * that is fine for a local test page - the service runs allow_origins=["*"]
 * with no authentication at all. This dashboard cannot: decided 2026-08-11
 * (a project rule), and it matters more here than for the read-only alert
 * streams, because these are WRITES that reconfigure the site's geometry.
 * Re-posting an existing name silently replaces that zone, mode included.
 *
 * So all three are proxies the backend has to write, mapping our camera UUID
 * to the camera name the AI service knows it by - the same mapping
 * app/ai_alerts/consumer.py already performs when it registers sources.
 * Until they exist a real backend answers 404 and the screen says the
 * detector is not reachable; on fixtures they work end to end.
 *
 * Roles: ADMIN and MANAGER, scoped to the caller's own agency through the
 * camera each zone hangs off. Not SECURITY - registering cameras and moving
 * the alert threshold is theirs (contracts/api.md §11-12), but the floor
 * geometry the counts are computed from is a different kind of act. Worth
 * confirming with backend rather than assuming.
 */

/**
 * Every zone the caller may see, camera by camera.
 *
 * The AI service answers with a name-keyed map; this expects the backend to
 * hand back a list with the name inside each entry, because a list is what
 * every other route here returns and the name is already the key inside it.
 */
export function fetchZones(signal?: AbortSignal): Promise<CameraZone[]> {
  return fetchJson<CameraZone[]>(
    { key: 'GET /api/zones', path: '/api/zones', auth: true },
    { signal },
  )
}

/**
 * Creating a zone whose name already exists REPLACES it - no 409.
 * `extra_camera_ids` on the body means world mode - see CameraZoneCreate.
 */
export function createZone(body: CameraZoneCreate, signal?: AbortSignal): Promise<CameraZoneSaved> {
  return fetchJson<CameraZoneSaved>(
    { key: 'POST /api/zones', path: '/api/zones', method: 'POST', auth: true },
    { signal, body },
  )
}

/**
 * The name is the key, so it goes in the path - encoded, since nothing stops
 * someone naming a zone "hall d'entrée" or "counter/2".
 */
export function deleteZone(name: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/zones/{name}',
      path: `/api/zones/${encodeURIComponent(name)}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}

/** Who may stand in the zone (world zones only, 422 otherwise). */
export function setZoneRestriction(
  name: string,
  restriction: ZoneRestriction,
  signal?: AbortSignal,
): Promise<{ name: string; restriction: ZoneRestriction; warnings?: string[] }> {
  return fetchJson(
    {
      key: 'PUT /api/zones/{name}/restriction',
      path: `/api/zones/${encodeURIComponent(name)}/restriction`,
      method: 'PUT',
      auth: true,
    },
    { signal, body: { restriction } },
  )
}

/** Tracked people with an active intrusion alert (ADMIN, MANAGER, SECURITY). */
export function fetchIntruders(signal?: AbortSignal): Promise<Intruder[]> {
  return fetchJson<Intruder[]>(
    { key: 'GET /api/zones/intruders', path: '/api/zones/intruders', auth: true },
    { signal },
  )
}
