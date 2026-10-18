import type { AlertsByCamera } from '@/api/streamMerge'
import type { TrackDict } from '@/api/types'

type Box = [number, number, number, number]
type Mat = number[][]

function applyH(H: Mat, x: number, y: number): [number, number] {
  const w = H[2][0] * x + H[2][1] * y + H[2][2]
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w]
}

/**
 * Which tracked person each live detection belongs to (2026-10-18 day test:
 * the map showed a plain dot for someone holding a pistol).
 *
 * A detection is a box in one camera's picture - a weapon, or a face - with
 * no track id. The people stream sends, per camera, the box of every person
 * it sees. So: take the person box on that camera that contains the
 * detection's centre (the nearest one if none does), project that person's
 * foot point onto the floor through the camera's calibration, and mark the
 * nearest track. A camera with no calibration, or no person box, marks
 * nobody rather than guessing.
 */
export function trackMarkers({
  tracks,
  boxes,
  detections,
  hinvByCameraName,
  maxDistance,
  label,
}: {
  tracks: TrackDict[]
  boxes: Record<string, Box[]>
  detections: AlertsByCamera
  hinvByCameraName: Map<string, Mat>
  /** Floor units: a foot point farther than this from every track is ignored. */
  maxDistance: number
  label: (cls: string) => string
}): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [camera, dets] of Object.entries(detections)) {
    const H = hinvByCameraName.get(camera)
    const people = boxes[camera] ?? []
    if (!H || people.length === 0) continue
    for (const det of dets ?? []) {
      if (!det.bbox) continue
      const cx = (det.bbox[0] + det.bbox[2]) / 2
      const cy = (det.bbox[1] + det.bbox[3]) / 2
      const inside = people.filter(
        ([x1, y1, x2, y2]) => cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2,
      )
      const candidates = inside.length > 0 ? inside : people
      const person = candidates.reduce((best, b) =>
        Math.hypot((b[0] + b[2]) / 2 - cx, (b[1] + b[3]) / 2 - cy) <
        Math.hypot((best[0] + best[2]) / 2 - cx, (best[1] + best[3]) / 2 - cy)
          ? b
          : best,
      )
      const [wx, wy] = applyH(H, (person[0] + person[2]) / 2, person[3])
      let nearest: TrackDict | null = null
      let distance = Infinity
      for (const track of tracks) {
        const d = Math.hypot(track.x - wx, track.y - wy)
        if (d < distance) {
          distance = d
          nearest = track
        }
      }
      if (!nearest || distance > maxDistance) continue
      const text = label(det.class)
      const list = out.get(nearest.id) ?? []
      if (!list.includes(text)) list.push(text)
      out.set(nearest.id, list)
    }
  }
  return out
}
