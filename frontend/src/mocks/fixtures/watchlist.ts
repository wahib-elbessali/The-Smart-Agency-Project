import { registerMock, registerMockWriter } from '../registry'
import type { WantedThreshold, WatchlistEntry } from '@/api/types'
import * as store from '../watchlistStore'

/**
 * PROPOSED - GET/POST /api/watchlist, DELETE /api/watchlist/{name}, GET/PUT
 * /api/watchlist/threshold, see api/endpoints/watchlist.ts.
 *
 * ADMIN and MANAGER only, same as /api/face - one site-wide gallery, no
 * agency scoping.
 */

registerMock<WatchlistEntry[]>('GET /api/watchlist', {
  normal: store.listWatchlist,
  empty: () => [],
  large: store.listWatchlist,
})

registerMockWriter('POST /api/watchlist', (body) => {
  const form = body as FormData
  const name = String(form.get('name') ?? '')
  const image = form.get('image')
  return store.addToWatchlist(name, image !== null && typeof image !== 'string')
})

registerMockWriter('DELETE /api/watchlist/{name}', (_body, path) => {
  const parts = path.split('/').filter(Boolean)
  const name = decodeURIComponent(parts[parts.length - 1] ?? '')
  store.removeFromWatchlist(name)
  return undefined
})

registerMock<WantedThreshold>('GET /api/watchlist/threshold', {
  normal: store.getWantedThreshold,
  empty: store.getWantedThreshold,
  large: store.getWantedThreshold,
})

registerMockWriter('PUT /api/watchlist/threshold', (body) => {
  return store.setWantedThreshold(body as { threshold?: number; min_face_px?: number })
})
