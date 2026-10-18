import { USE_MOCKS, WS_AUTH_MODE, WS_BASE_URL } from './config'
import {
  backoffDelay,
  buildSocketTarget as buildTarget,
  createSocketStream,
  parseJsonFrame,
  type SocketStream,
  type SocketStreamDeps,
  type StreamStatus,
} from './socketStream'
import { createMockAttendanceStream } from '@/mocks/attendanceStream'
import type { AttendanceEvent } from './types'

/**
 * The live attendance transport.
 *
 * The connect / backoff / status machinery now lives in socketStream.ts, shared
 * with the alerts and occupancy feeds. What stays here is the part that is
 * genuinely about attendance: the path, and what makes a frame valid.
 *
 * Two things about this socket that took testing to establish and are easy to
 * undo by accident:
 *
 * 1. It is a real WebSocket. `WS /ws/attendance` - EventSource speaks Server-Sent
 *    Events and cannot open a WebSocket at all.
 *
 * 2. It is called "attendance", not "alerts". The socket carries check-ins and
 *    check-outs. Leaving "alerts" in the name is how a feed of people arriving
 *    at work quietly ends up rendered on a security-alerts screen - and the real
 *    alerts feed, which carries weapons and flagged faces, is a different socket
 *    entirely.
 */

export type { StreamStatus }

/** Kept as its own name because six call sites and the tests use it. */
export type AttendanceStream = SocketStream<AttendanceEvent>

export const ATTENDANCE_STREAM_PATH = '/ws/attendance'

/** Attendance-shaped wrapper over the shared builder, for the existing tests. */
export function buildSocketTarget(
  token: string | null,
  mode = WS_AUTH_MODE,
  base = WS_BASE_URL,
): { url: string; protocols?: string[] } | null {
  return buildTarget(ATTENDANCE_STREAM_PATH, token, mode, base)
}

export { backoffDelay }

export function createLiveAttendanceStream(deps: SocketStreamDeps = {}): AttendanceStream {
  return createSocketStream(ATTENDANCE_STREAM_PATH, parseFrame, deps)
}

/**
 * Parses a socket frame, returning null for anything unreadable.
 *
 * Deliberately checks three fields and no more. `event` is not validated
 * against the documented pair, because a frame carrying a third kind is still
 * a real event the merge can handle - rejecting it would lose data over a
 * documentation gap.
 */
export function parseFrame(data: unknown): AttendanceEvent | null {
  const frame = parseJsonFrame(data)
  if (!frame) return null

  if (typeof frame.type !== 'string') return null
  if (typeof frame.employee_id !== 'string') return null
  if (typeof frame.check_in !== 'string') return null

  return frame as unknown as AttendanceEvent
}

export function createAttendanceStream(deps: SocketStreamDeps = {}): AttendanceStream {
  if (USE_MOCKS) return createMockAttendanceStream()
  return createLiveAttendanceStream(deps)
}
