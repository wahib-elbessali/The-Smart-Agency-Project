import { fetchJson } from '../client'
import type { Camera, CameraCreate, CameraUpdate } from '../types'

/**
 * Camera endpoints — contracts/api.md §11, added 2026-09-12.
 *
 * ADMIN, MANAGER and SECURITY throughout, except delete, which drops SECURITY.
 * There is no "every camera" list: only per agency, so an ADMIN has to say
 * which branch, the same as services. A non-ADMIN asking about a branch other
 * than their own gets a 403 ("Acces limite a votre agence"), and a camera id
 * that belongs elsewhere gets the same.
 */

export function fetchCameras(agencyId: string, signal?: AbortSignal): Promise<Camera[]> {
  return fetchJson<Camera[]>(
    {
      key: 'GET /api/agencies/{id}/cameras',
      path: `/api/agencies/${agencyId}/cameras`,
      auth: true,
    },
    { signal },
  )
}

/**
 * 409 when `name` is already taken - by any camera at any branch, since the
 * AI service's source registry is site-wide. 422 when either field is blank
 * after trimming.
 */
export function createCamera(
  agencyId: string,
  body: CameraCreate,
  signal?: AbortSignal,
): Promise<Camera> {
  return fetchJson<Camera>(
    {
      key: 'POST /api/agencies/{id}/cameras',
      path: `/api/agencies/${agencyId}/cameras`,
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

/** Same refusals as create. Only the fields sent are changed. */
export function updateCamera(
  id: string,
  body: CameraUpdate,
  signal?: AbortSignal,
): Promise<Camera> {
  return fetchJson<Camera>(
    { key: 'PUT /api/cameras/{id}', path: `/api/cameras/${id}`, method: 'PUT', auth: true },
    { signal, body },
  )
}

/** ADMIN and MANAGER only. 204, no body. */
export function deleteCamera(id: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    { key: 'DELETE /api/cameras/{id}', path: `/api/cameras/${id}`, method: 'DELETE', auth: true },
    { signal },
  )
}

/**
 * backend/app/api/cameras.py's `get_camera_frame`, added 2026-09-23 - not
 * yet in contracts/api.md. The current picture from one camera, as image
 * bytes.
 *
 * The AI service serves this as GET /frame?camera=<id>&format=jpeg
 * &quality=<1-100> (contracts/ai-service.md, App-level) - a still frame at the
 * resolution the detectors see, so boxes from the alert stream line up on it.
 * The browser must not call that service (project rule, decided 2026-08-11), so
 * this route asks backend for it instead: authenticate, look the camera up by
 * our id, forward to the AI service by the name it knows the camera as, and
 * pass the bytes back with the AI service's own status:
 *
 *   GET /api/cameras/{camera_id}/frame?format=jpeg&quality=75
 *   -> 200 image/jpeg
 *   -> 404 when the camera does not exist, or the AI service cannot open its
 *      stream (the same 404 it answers itself)
 *
 * Same roles and agency scoping as the camera. If the AI service itself has
 * no picture for this camera the screen shows "no picture" and keeps the
 * detections - the boxes are still true, they just have nothing to sit on.
 */
/**
 * The same picture at the camera's NATIVE resolution, for calibration.
 *
 * Kept as its own function rather than a flag, because the two callers want
 * opposite things and silently getting the other one is not visible on
 * screen. `fetchCameraFrame` above returns the detector-scaled frame, so
 * alert boxes land in the right place. This one must not be scaled: the 4
 * clicked points are sent with `img_w`/`img_h`, the service uses the image
 * centre as an assumed principal point, and points measured on a resized
 * frame describe a camera that does not exist.
 */
export function fetchNativeFrame(id: string, signal?: AbortSignal): Promise<Blob> {
  return fetchJson<Blob>(
    {
      key: 'GET /api/cameras/{id}/frame',
      path: `/api/cameras/${id}/frame?native=true`,
      auth: true,
    },
    { signal, responseType: 'blob' },
  )
}

export function fetchCameraFrame(id: string, signal?: AbortSignal): Promise<Blob> {
  return fetchJson<Blob>(
    {
      key: 'GET /api/cameras/{id}/frame',
      path: `/api/cameras/${id}/frame?format=jpeg&quality=75`,
      auth: true,
    },
    { signal, responseType: 'blob' },
  )
}
