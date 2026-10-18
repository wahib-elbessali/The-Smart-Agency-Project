import { fetchJson } from '../client'
import type { WantedThreshold, WatchlistEntry } from '../types'

/**
 * Wanted-person watchlist — PROPOSED, not in contracts/api.md.
 *
 * ai/features/wanted_detection/api.py's /watchlist and /threshold. Separate
 * gallery from /face on purpose - see WatchlistEntry's doc comment in
 * api/types.ts. The Alerts screen already shows a wanted hit when the
 * stream fires one; this is the missing other half, managing who's on the
 * list in the first place.
 */

export function fetchWatchlist(signal?: AbortSignal): Promise<WatchlistEntry[]> {
  return fetchJson<WatchlistEntry[]>(
    /* include_embeddings deliberately omitted - this dashboard never needs
       the raw vectors, only the count. */
    { key: 'GET /api/watchlist', path: '/api/watchlist', auth: true },
    { signal },
  )
}

/** multipart/form-data: name + one photo, exactly one face. Adds to an
 * existing name's gallery rather than replacing it. */
export function addToWatchlist(
  name: string,
  image: File,
  signal?: AbortSignal,
): Promise<WatchlistEntry> {
  const form = new FormData()
  form.append('name', name)
  form.append('image', image)
  return fetchJson<WatchlistEntry>(
    { key: 'POST /api/watchlist', path: '/api/watchlist', method: 'POST', auth: true },
    { signal, body: form },
  )
}

/** Removes that person's WHOLE watchlist entry. */
export function removeFromWatchlist(name: string, signal?: AbortSignal): Promise<void> {
  return fetchJson<void>(
    {
      key: 'DELETE /api/watchlist/{name}',
      path: `/api/watchlist/${encodeURIComponent(name)}`,
      method: 'DELETE',
      auth: true,
    },
    { signal },
  )
}

export function fetchWantedThreshold(signal?: AbortSignal): Promise<WantedThreshold> {
  return fetchJson<WantedThreshold>(
    { key: 'GET /api/watchlist/threshold', path: '/api/watchlist/threshold', auth: true },
    { signal },
  )
}

/**
 * Takes effect on the NEXT detection cycle (`applies_within_seconds`), not
 * instantly - said in the UI, not implied to be live immediately.
 */
export function setWantedThreshold(
  body: { threshold?: number; min_face_px?: number },
  signal?: AbortSignal,
): Promise<WantedThreshold> {
  return fetchJson<WantedThreshold>(
    {
      key: 'PUT /api/watchlist/threshold',
      path: '/api/watchlist/threshold',
      method: 'PUT',
      auth: true,
    },
    { signal, body },
  )
}
