import { fetchJson } from '../client'
import type { AttendanceMark, AttendanceRecord } from '../types'

/**
 * GET /api/attendance/today
 *
 * The snapshot the presence screen starts from. WS /ws/attendance then keeps it
 * current - see attendanceMerge.ts for why those two cannot simply be
 * concatenated.
 */
export function fetchAttendanceToday(signal?: AbortSignal): Promise<AttendanceRecord[]> {
  return fetchJson<AttendanceRecord[]>(
    { key: 'GET /api/attendance/today', path: '/api/attendance/today', auth: true },
    { signal },
  )
}

/**
 * One employee's attendance history, most recent first.
 *
 * The only historical attendance route in the contract - everything else is
 * today. So this is the sole source for "has this person been late before" or
 * "when did they last work a full day", and any trend the interface shows has
 * to come from here or be fabricated.
 *
 * ADMIN, MANAGER and SECURITY only; a MANAGER or SECURITY caller asking about
 * an employee outside their own agency gets a 403 rather than an empty list.
 */
export function fetchEmployeeAttendance(
  employeeId: string,
  signal?: AbortSignal,
): Promise<AttendanceRecord[]> {
  return fetchJson<AttendanceRecord[]>(
    {
      key: 'GET /api/attendance/employee/{id}',
      path: `/api/attendance/employee/${employeeId}`,
      auth: true,
    },
    { signal },
  )
}

/**
 * Records an arrival, as a badge reader would.
 *
 * IT IS NOT AN ERROR TO CALL THIS TWICE. If the employee already has an open
 * record the backend returns THAT record instead of creating a second one, with
 * a 200 either way - so the response cannot be read as "a check-in happened".
 * A caller that reports success unconditionally will cheerfully tell someone
 * they were checked in at 14:03 when the record it got back says 08:12. Compare
 * the returned `check_in` against what you sent before claiming anything.
 *
 * Errors: 404 if the RFID matches no ACTIVE employee; 403 if a MANAGER or
 * SECURITY caller targets someone outside their own agency.
 */
export function checkIn(body: AttendanceMark, signal?: AbortSignal): Promise<AttendanceRecord> {
  return fetchJson<AttendanceRecord>(
    {
      key: 'POST /api/attendance/check-in',
      path: '/api/attendance/check-in',
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}

/**
 * Closes the employee's current open record.
 *
 * Unlike check-in this one does refuse: 409 when there is no open record, which
 * is the ordinary case of checking out somebody who never checked in.
 */
export function checkOut(body: AttendanceMark, signal?: AbortSignal): Promise<AttendanceRecord> {
  return fetchJson<AttendanceRecord>(
    {
      key: 'POST /api/attendance/check-out',
      path: '/api/attendance/check-out',
      method: 'POST',
      auth: true,
    },
    { signal, body },
  )
}
