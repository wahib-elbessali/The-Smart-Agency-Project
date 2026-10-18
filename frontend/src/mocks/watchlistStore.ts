import type { WantedThreshold, WatchlistEntry } from '@/api/types'
import { ApiError } from '@/api/errors'

/**
 * Mock gallery for /watchlist (ai/features/wanted_detection/api.py) - same
 * "no real face detection, just a counter" disclaimer as faceStore, and a
 * genuinely separate Map, not a re-export of it (the real service keeps two
 * separate gallery files on purpose, see WatchlistEntry's doc comment).
 */

let watchlist: Map<string, number> | null = null
let threshold = 0.62
let minFacePx = 60
const STARTUP_DEFAULT = { threshold: 0.62, min_face_px: 60 }
const THRESHOLD_FLOOR = 0.4
const APPLIES_WITHIN_SECONDS = 10

function state(): Map<string, number> {
  if (watchlist === null) {
    watchlist = new Map([['MAROUANE-B-2024-114', 3]])
  }
  return watchlist
}

export function listWatchlist(): WatchlistEntry[] {
  return [...state().entries()]
    .map(([name, embeddings_count]) => ({ name, embeddings_count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function addToWatchlist(name: string, hasImage: boolean): WatchlistEntry {
  const trimmed = name.trim()
  if (!/^[\w .+-]{1,80}$/.test(trimmed)) {
    throw new ApiError('http', 'name must be 1-80 chars of letters, digits, space, . _ + or -', 422)
  }
  if (!hasImage) throw new ApiError('http', 'Une photo est obligatoire', 400)

  const map = state()
  const count = (map.get(trimmed) ?? 0) + 1
  map.set(trimmed, count)
  return { name: trimmed, embeddings_count: count }
}

export function removeFromWatchlist(name: string): number {
  const map = state()
  if (!map.has(name)) throw new ApiError('http', `not on the watchlist: ${name}`, 404)
  const removed = map.get(name) ?? 0
  map.delete(name)
  return removed
}

export function getWantedThreshold(): WantedThreshold {
  const map = state()
  const embeddingsTotal = [...map.values()].reduce((sum, n) => sum + n, 0)
  return {
    threshold,
    min_face_px: minFacePx,
    startup_default: STARTUP_DEFAULT,
    floor: THRESHOLD_FLOOR,
    watchlist_size: map.size,
    embeddings_total: embeddingsTotal,
    applies_within_seconds: APPLIES_WITHIN_SECONDS,
  }
}

export function setWantedThreshold(body: {
  threshold?: number
  min_face_px?: number
}): WantedThreshold {
  if (body.threshold !== undefined) {
    if (body.threshold < THRESHOLD_FLOOR) {
      throw new ApiError('http', `threshold cannot go below ${THRESHOLD_FLOOR}`, 422)
    }
    threshold = body.threshold
  }
  if (body.min_face_px !== undefined) {
    if (body.min_face_px < 1) throw new ApiError('http', 'min_face_px must be positive', 422)
    minFacePx = body.min_face_px
  }
  return getWantedThreshold()
}

/** Tests only - module state would otherwise leak between them. */
export function resetWatchlistStore(): void {
  watchlist = null
  threshold = STARTUP_DEFAULT.threshold
  minFacePx = STARTUP_DEFAULT.min_face_px
}
