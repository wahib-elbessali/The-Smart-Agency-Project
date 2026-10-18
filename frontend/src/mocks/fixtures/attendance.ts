import { registerMock, registerMockWriter } from '../registry'
import * as attendanceStore from '../attendanceStore'
import type { AttendanceMark, AttendanceRecord } from '@/api/types'
import { AGENCY_ID, fullNameOf, makeEmployees } from './people'

/**
 * Field names from GET /api/attendance/today.
 *
 * Times are built relative to "today" rather than hard-coded, so the screen
 * shows plausible clock times whenever it is opened instead of a frozen date
 * that makes every row look stale.
 */

function atToday(hours: number, minutes: number): string {
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  return date.toISOString()
}

interface Shift {
  /** Index into the shared roster. */
  employee: number
  inAt: [number, number]
  outAt?: [number, number]
}

/* Deliberately mixed: people still in, people who have gone home, and two late
   arrivals against the 08:30 opening_time so the derived "late" badge has
   something to show. */
const SHIFTS: Shift[] = [
  { employee: 0, inAt: [8, 24] },
  { employee: 1, inAt: [8, 12] },
  { employee: 2, inAt: [8, 47] },
  { employee: 3, inAt: [8, 5], outAt: [12, 40] },
  { employee: 4, inAt: [7, 58] },
  { employee: 5, inAt: [9, 21] },
  { employee: 6, inAt: [8, 30], outAt: [13, 15] },
  { employee: 7, inAt: [8, 19] },
]

function recordOf(shift: Shift, index: number): AttendanceRecord {
  const employee = makeEmployees(10)[shift.employee]
  return {
    id: `d1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    employee_id: employee.id,
    employee_name: fullNameOf(employee),
    agency_id: AGENCY_ID,
    check_in: atToday(...shift.inAt),
    check_out: shift.outAt ? atToday(...shift.outAt) : null,
    method: 'RFID',
  }
}

function normal(): AttendanceRecord[] {
  return SHIFTS.map(recordOf)
}

function large(): AttendanceRecord[] {
  const roster = makeEmployees(200)
  return roster.map((employee, index) => ({
    id: `d1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    employee_id: employee.id,
    employee_name: fullNameOf(employee),
    agency_id: AGENCY_ID,
    check_in: atToday(8, index % 55),
    check_out: index % 4 === 0 ? atToday(16, index % 30) : null,
    method: index % 7 === 0 ? 'FACE_RECOGNITION' : 'RFID',
  }))
}

registerMock<AttendanceRecord[]>('GET /api/attendance/today', {
  normal,
  /* An empty day is a real answer, not a failure: before opening time nobody
     has badged in yet. The screen must say so rather than look broken. */
  empty: () => [],
  large,
})

/* The id is in the path, not the body - same as the real request. */
function idFrom(path: string): string {
  return path.split('/').pop() ?? ''
}

/**
 * Per-employee history comes from the writable store rather than from `normal`
 * above, because it has to include anything just recorded through check-in.
 * All three scenarios share it: the history is about one employee, so the
 * empty/large distinction has nothing to vary.
 */
registerMock<AttendanceRecord[]>('GET /api/attendance/employee/{id}', {
  normal: () => [],
  empty: () => [],
  large: () => [],
})

registerMockWriter('GET /api/attendance/employee/{id}', (_body, path) =>
  attendanceStore.historyFor(idFrom(path)),
)

registerMockWriter('POST /api/attendance/check-in', (body) =>
  attendanceStore.checkIn(body as AttendanceMark),
)

registerMockWriter('POST /api/attendance/check-out', (body) =>
  attendanceStore.checkOut(body as AttendanceMark),
)
