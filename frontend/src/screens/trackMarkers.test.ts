import { describe, expect, it } from 'vitest'
import { trackMarkers } from './trackMarkers'

/* Identity calibration: pixel (x, y) is floor (x, y). */
const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

describe('trackMarkers', () => {
  const tracks = [
    { id: '7', x: 100, y: 300, hits: 1, misses: 0 },
    { id: '9', x: 500, y: 300, hits: 1, misses: 0 },
  ]
  const boxes = {
    cam1: [
      [80, 100, 120, 300] as [number, number, number, number],
      [480, 100, 520, 300] as [number, number, number, number],
    ],
  }

  it('marks the track whose person box holds the detection', () => {
    const marks = trackMarkers({
      tracks,
      boxes,
      detections: { cam1: [{ class: 'pistol', confidence: 0.9, bbox: [505, 180, 515, 200] }] },
      hinvByCameraName: new Map([['cam1', IDENTITY]]),
      maxDistance: 50,
      label: (c) => c,
    })
    expect([...marks.entries()]).toEqual([['9', ['pistol']]])
  })

  it('marks nobody for an uncalibrated camera or one far from every track', () => {
    const detections = {
      cam1: [
        {
          class: 'pistol',
          confidence: 0.9,
          bbox: [505, 180, 515, 200] as [number, number, number, number],
        },
      ],
    }
    expect(
      trackMarkers({
        tracks,
        boxes,
        detections,
        hinvByCameraName: new Map(),
        maxDistance: 50,
        label: (c) => c,
      }).size,
    ).toBe(0)
    expect(
      trackMarkers({
        tracks: [{ id: '1', x: 2000, y: 2000, hits: 1, misses: 0 }],
        boxes,
        detections,
        hinvByCameraName: new Map([['cam1', IDENTITY]]),
        maxDistance: 50,
        label: (c) => c,
      }).size,
    ).toBe(0)
  })
})
