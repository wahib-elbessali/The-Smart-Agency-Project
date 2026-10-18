import type { FaceEntry } from '@/api/types'
import { ApiError } from '@/api/errors'

/**
 * Mock gallery for /face (ai/features/face_recognition/api.py), enrollment
 * only - see FaceEntry's doc comment in api/types.ts.
 *
 * No real face detection here, same disclaimer as calibrationStore's
 * "there is no homography here" - a real photo is decoded only to confirm
 * it IS a photo (not empty, not corrupt), never analysed for a face at all.
 * `embeddings_count` is a plain counter, not a real gallery size.
 */

let faces: Map<string, number> | null = null

function state(): Map<string, number> {
  if (faces === null) {
    faces = new Map([
      ['Amina Benali', 2],
      ['Youssef Idrissi', 1],
    ])
  }
  return faces
}

export function listFaces(): FaceEntry[] {
  return [...state().entries()]
    .map(([name, embeddings_count]) => ({ name, embeddings_count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function enrollFace(name: string, hasImage: boolean): FaceEntry {
  const trimmed = name.trim()
  if (!trimmed) throw new ApiError('http', 'Le nom est obligatoire', 422)
  if (!hasImage) throw new ApiError('http', 'Une photo est obligatoire', 400)

  const map = state()
  const count = (map.get(trimmed) ?? 0) + 1
  map.set(trimmed, count)
  return { name: trimmed, embeddings_count: count }
}

export function deleteFace(name: string): number {
  const map = state()
  if (!map.has(name)) throw new ApiError('http', `no such person: ${name}`, 404)
  const removed = map.get(name) ?? 0
  map.delete(name)
  return removed
}

/** Tests only - module state would otherwise leak between them. */
export function resetFaceStore(): void {
  faces = null
}
