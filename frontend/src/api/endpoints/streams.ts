import { USE_MOCKS } from '../config'
import {
  createSocketStream,
  parseJsonFrame,
  type SocketStream,
  type SocketStreamDeps,
} from '../socketStream'
import {
  createMockAlertStream,
  createMockOccupancyStream,
  createMockPeopleStream,
  createMockWorkstationStream,
} from '@/mocks/aiStreams'
import type {
  AlertFeature,
  AlertFrame,
  OccupancyFrame,
  PeopleStreamFrame,
  WorkstationFrame,
} from '../types'

/**
 * The alerts and occupancy feeds, both proxied by the backend.
 *
 * The frontend never talks to the AI service. Decided in the meeting on
 * 2026-08-11: frontend calls backend, backend calls everything else, and
 * exceptions get announced. That matters here more than anywhere - the AI
 * service has no authentication at all, and the wanted feed carries names and
 * face photographs of flagged people. A browser reaching it directly would be
 * an open biometric endpoint.
 *
 * ALL SEVEN PATHS BELOW ARE NOW REAL.
 *
 * The backend proxy exists - backend/app/websocket/ai_proxy.py - and it settled
 * the open question this comment used to raise: one WebSocket per feature,
 * not merged into a single `/alerts`, exactly what this file assumed. It's a
 * byte-for-byte relay onto the AI service's own stream, no reshaping, so the
 * frame types below (built against contracts/ai-service.md) need no changes
 * either. The five original paths (weapon/fire/emotion/wanted alerts, plus
 * occupancy) are documented in contracts/api.md; workstations and people
 * tracks (added 2026-09-23, closing the two gaps this comment used to flag)
 * are not yet - same contract-drift note as everything else proxied ahead of
 * the doc, see api/endpoints/workstations.ts.
 */

export const ALERT_STREAM_PATHS: Record<AlertFeature, string> = {
  weapon: '/ws/alerts/weapon',
  fire: '/ws/alerts/fire',
  emotion: '/ws/alerts/emotion',
  wanted: '/ws/alerts/wanted',
}

export const OCCUPANCY_STREAM_PATH = '/ws/occupancy'

export const WORKSTATION_STREAM_PATH = '/ws/workstations'

/**
 * Parses an alerts frame.
 *
 * Validates only the discriminant and the one field that carries the payload,
 * for the same reason the attendance parser does: a frame we cannot read is
 * dropped, but a frame carrying an unexpected extra is still real data.
 */
export function parseAlertFrame(data: unknown): AlertFrame | null {
  const frame = parseJsonFrame(data)
  if (!frame) return null

  if (frame.type === 'snapshot') {
    if (typeof frame.cameras !== 'object' || frame.cameras === null) return null
    return frame as unknown as AlertFrame
  }
  if (frame.type === 'update') {
    if (typeof frame.camera !== 'string') return null
    if (!Array.isArray(frame.detections)) return null
    return frame as unknown as AlertFrame
  }
  /* Added in #112: a stored alert was created, updated or resolved. Only the
     id and the event are checked - the rest is the stored record itself. */
  if (frame.type === 'alert_state') {
    if (typeof frame.id !== 'string') return null
    if (!['created', 'updated', 'resolved'].includes(frame.event as string)) return null
    return frame as unknown as AlertFrame
  }
  return null
}

export function parseOccupancyFrame(data: unknown): OccupancyFrame | null {
  const frame = parseJsonFrame(data)
  if (!frame) return null

  if (frame.type === 'snapshot') {
    if (typeof frame.zones !== 'object' || frame.zones === null) return null
    return frame as unknown as OccupancyFrame
  }
  if (frame.type === 'update') {
    if (typeof frame.zone !== 'string') return null
    if (typeof frame.count !== 'number') return null
    return frame as unknown as OccupancyFrame
  }
  return null
}

/**
 * A workstation frame.
 *
 * The update case carries a whole row rather than a nested payload, so the
 * discriminant and `name` are what get checked: a frame we cannot attribute
 * to a workstation is useless, while one carrying an unexpected extra field
 * is still real data.
 */
export function parseWorkstationFrame(data: unknown): WorkstationFrame | null {
  const frame = parseJsonFrame(data)
  if (!frame) return null

  if (frame.type === 'snapshot') {
    if (!Array.isArray(frame.workstations)) return null
    return frame as unknown as WorkstationFrame
  }
  if (frame.type === 'update') {
    if (typeof frame.name !== 'string') return null
    return frame as unknown as WorkstationFrame
  }
  return null
}

export function createAlertStream(
  feature: AlertFeature,
  deps: SocketStreamDeps = {},
): SocketStream<AlertFrame> {
  if (USE_MOCKS) return createMockAlertStream(feature)
  return createSocketStream(ALERT_STREAM_PATHS[feature], parseAlertFrame, deps)
}

export function createOccupancyStream(deps: SocketStreamDeps = {}): SocketStream<OccupancyFrame> {
  if (USE_MOCKS) return createMockOccupancyStream()
  return createSocketStream(OCCUPANCY_STREAM_PATH, parseOccupancyFrame, deps)
}

export function createWorkstationStream(
  deps: SocketStreamDeps = {},
): SocketStream<WorkstationFrame> {
  if (USE_MOCKS) return createMockWorkstationStream()
  return createSocketStream(WORKSTATION_STREAM_PATH, parseWorkstationFrame, deps)
}

/** WS /people/tracks/stream, proxied by backend/app/websocket/ai_proxy.py. */
export const PEOPLE_STREAM_PATH = '/ws/people/tracks'

export function parsePeopleFrame(data: unknown): PeopleStreamFrame | null {
  const frame = parseJsonFrame(data)
  if (!frame) return null

  if (frame.type === 'snapshot') {
    if (typeof frame.state !== 'string' || !Array.isArray(frame.tracks)) return null
    return frame as unknown as PeopleStreamFrame
  }
  if (frame.type === 'state') {
    if (typeof frame.phase !== 'string') return null
    return frame as unknown as PeopleStreamFrame
  }
  if (frame.type === 'tracks') {
    if (!Array.isArray(frame.tracks) || typeof frame.boxes !== 'object' || frame.boxes === null) {
      return null
    }
    return frame as unknown as PeopleStreamFrame
  }
  return null
}

export function createPeopleStream(deps: SocketStreamDeps = {}): SocketStream<PeopleStreamFrame> {
  if (USE_MOCKS) return createMockPeopleStream()
  return createSocketStream(PEOPLE_STREAM_PATH, parsePeopleFrame, deps)
}
