import { fetchJson } from '../client'
import type { FaceEntry } from '../types'

/**
 * Staff face enrollment — PROPOSED, not in contracts/api.md.
 *
 * ai/features/face_recognition/api.py's /face, enrollment routes only. See
 * FaceEntry's doc comment in api/types.ts for why /scan and /capture are
 * deliberately not here at all - those are backend-triggered against real
 * hardware, not something this dashboard calls.
 */

export function fetchFaces(signal?: AbortSignal): Promise<FaceEntry[]> {
  return fetchJson<FaceEntry[]>(
    { key: 'GET /api/face/faces', path: '/api/face/faces', auth: true },
    { signal },
  )
}

/**
 * multipart/form-data: name + exactly one photo with exactly one face.
 * 422 if the image doesn't decode to a single clear face. Enrolling a name
 * that already exists ADDS a photo to that person's gallery rather than
 * replacing it - `embeddings_count` in the response is the running total.
 */
export function enrollFace(name: string, image: File, signal?: AbortSignal): Promise<FaceEntry> {
  const form = new FormData()
  form.append('name', name)
  form.append('image', image)
  return fetchJson<FaceEntry>(
    { key: 'POST /api/face/enroll', path: '/api/face/enroll', method: 'POST', auth: true },
    { signal, body: form },
  )
}

/** Removes that person's WHOLE gallery entry, not one photo. */
export function deleteFace(name: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/face/faces/{name}',
      path: `/api/face/faces/${encodeURIComponent(name)}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}
