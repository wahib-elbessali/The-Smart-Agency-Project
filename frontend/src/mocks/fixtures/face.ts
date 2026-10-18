import { registerMock, registerMockWriter } from '../registry'
import type { FaceEntry } from '@/api/types'
import * as store from '../faceStore'

/**
 * PROPOSED - GET /api/face/faces, POST /api/face/enroll, DELETE
 * /api/face/faces/{name}, see api/endpoints/face.ts.
 *
 * ADMIN and MANAGER only, no agency scoping at all: the AI service's face
 * gallery is one site-wide list, same as calibration/watchlist, not a
 * per-branch concept.
 */

registerMock<FaceEntry[]>('GET /api/face/faces', {
  normal: store.listFaces,
  empty: () => [],
  large: store.listFaces,
})

registerMockWriter('POST /api/face/enroll', (body) => {
  const form = body as FormData
  const name = String(form.get('name') ?? '')
  const image = form.get('image')
  return store.enrollFace(name, image !== null && typeof image !== 'string')
})

registerMockWriter('DELETE /api/face/faces/{name}', (_body, path) => {
  const parts = path.split('/').filter(Boolean)
  const name = decodeURIComponent(parts[parts.length - 1] ?? '')
  store.deleteFace(name)
  return undefined
})
