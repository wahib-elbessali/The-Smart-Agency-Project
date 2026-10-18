import type { AttendanceStream, StreamStatus } from '@/api/attendanceStream'
import type { AttendanceEvent } from '@/api/types'
import { MOCK_SCENARIO } from '@/api/config'
import { AGENCY_ID, fullNameOf, makeEmployees } from './fixtures/people'

/**
 * A fake WS /ws/attendance, for mock mode.
 *
 * This is not decoration. The live-merge logic is the part of the presence
 * screen most likely to be wrong, and without a stream in mock mode there is no
 * way to see it work until the backend is up. So this deliberately emits the
 * cases that break things:
 *
 * - a DUPLICATE of an event already sent
 * - an OUT OF ORDER pair (check_out before the matching check_in)
 * - a frame with an `event` value the contract never documented
 *
 * Frame shape is exactly the WS entry in contracts/api.md, `device_id` included.
 */

const FIRST_EVENT_MS = 2_500
const INTERVAL_MS = 6_000

function eventFor(index: number, kind: string, checkOut: string | null): AttendanceEvent {
  /* Indices 8+ are people the attendance fixture has not used, so they arrive
     as genuinely new rows rather than colliding with the snapshot. */
  const employee = makeEmployees(10)[index % 10]
  const checkIn = new Date()
  checkIn.setHours(9, 30 + index, 0, 0)

  return {
    type: 'attendance_updated',
    event: kind,
    employee_id: employee.id,
    employee_name: fullNameOf(employee),
    agency_id: AGENCY_ID,
    check_in: checkIn.toISOString(),
    check_out: checkOut,
    method: index % 3 === 0 ? 'FACE_RECOGNITION' : 'RFID',
    device_id: 'f1000000-0000-4000-8000-000000000001',
  }
}

function script(): AttendanceEvent[] {
  const arrival8 = eventFor(8, 'check_in', null)
  const arrival9 = eventFor(9, 'check_in', null)

  const departure8: AttendanceEvent = {
    ...arrival8,
    event: 'check_out',
    check_out: new Date(new Date(arrival8.check_in).getTime() + 45 * 60_000).toISOString(),
  }

  return [
    arrival8,
    arrival9,
    /* Duplicate: a reconnect replaying a frame we already folded in. The table
       must not grow a second row for it. */
    arrival8,
    departure8,
    /* Out of order: the original check_in frame arriving again AFTER the
       check_out. Naive merging would resurrect a person who has gone home. */
    arrival8,
    /* Undocumented `event` value. Must not throw and must not drop the row. */
    { ...arrival9, event: 'attendance_amended' },
  ]
}

export function createMockAttendanceStream(): AttendanceStream {
  const eventListeners = new Set<(event: AttendanceEvent) => void>()
  const statusListeners = new Set<(status: StreamStatus) => void>()
  const timers: ReturnType<typeof setTimeout>[] = []

  let status: StreamStatus = 'connecting'
  let stopped = false

  function setStatus(next: StreamStatus) {
    if (status === next || stopped) return
    status = next
    for (const listener of statusListeners) listener(next)
  }

  /* The 'error' scenario models a socket that never comes up, so the badge and
     the stale-data warning can actually be looked at. */
  if (MOCK_SCENARIO === 'error') {
    status = 'closed'
  } else {
    timers.push(
      setTimeout(() => {
        setStatus('open')
        script().forEach((event, i) => {
          timers.push(
            setTimeout(() => {
              for (const listener of eventListeners) listener(event)
            }, i * INTERVAL_MS),
          )
        })
      }, FIRST_EVENT_MS),
    )
  }

  return {
    get status() {
      return status
    },
    subscribe(onEvent) {
      eventListeners.add(onEvent)
      return () => eventListeners.delete(onEvent)
    },
    onStatusChange(listener) {
      statusListeners.add(listener)
      listener(status)
      return () => statusListeners.delete(listener)
    },
    close() {
      stopped = true
      timers.forEach(clearTimeout)
      timers.length = 0
      eventListeners.clear()
      statusListeners.clear()
    },
  }
}
