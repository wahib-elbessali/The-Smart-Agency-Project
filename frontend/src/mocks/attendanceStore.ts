import type { AttendanceMark, AttendanceRecord } from '@/api/types'
import { ApiError } from '@/api/errors'
import { AGENCY_ID, fullNameOf, makeEmployees } from './fixtures/people'

/**
 * A writable attendance log for mock mode.
 *
 * Same reasoning as the employee and agency stores: a screen that records
 * arrivals cannot be built against a frozen fixture, because the check-in
 * appears to succeed and the roster never changes.
 *
 * It reproduces the contract's refusals with their documented status codes, so
 * the form meets its real failure modes long before there is a server:
 *
 *   404  check-in or check-out for an RFID no ACTIVE employee holds
 *   409  check-out with no open record
 *
 * And the one behaviour that is NOT an error and is easy to get wrong:
 * checking in somebody who is already checked in returns their EXISTING open
 * record with a 200. No new row, no refusal. The UI has to notice that for
 * itself by comparing the timestamp it sent.
 */

/** Records live here once created; the seeded history is generated below. */
let log: AttendanceRecord[] | null = null
let nextId = 5000

const ROSTER_SIZE = 10

/** Days of history to generate, so the per-employee view has something to show. */
const HISTORY_DAYS = 12

function isoAt(dayOffset: number, hour: number, minute: number): string {
  const d = new Date()
  d.setDate(d.getDate() - dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

/**
 * Builds a plausible history: most days worked, occasional lateness, one or two
 * absences per person.
 *
 * Deterministic rather than random - derived from the employee index and the
 * day - so the same person has the same history across reloads. A history that
 * reshuffles every refresh makes it impossible to tell a real bug from noise.
 */
function seed(): AttendanceRecord[] {
  const employees = makeEmployees(ROSTER_SIZE)
  const records: AttendanceRecord[] = []

  employees.forEach((employee, index) => {
    /* No card, no history - and that is consistent rather than convenient.
       Attendance is recorded by badge, so the one roster member without an
       RFID card has never badged in and cannot have. It also gives the
       interface a real "nothing recorded yet" case to render, which every
       roster otherwise hides. */
    if (employee.rfid_uid == null) return

    for (let day = 1; day <= HISTORY_DAYS; day += 1) {
      /* Skip weekends and a deterministic "absent" day per person. */
      const date = new Date()
      date.setDate(date.getDate() - day)
      const weekday = date.getDay()
      if (weekday === 0 || weekday === 6) continue
      if ((index + day) % 7 === 0) continue

      const late = (index * 3 + day) % 5 === 0
      const inHour = 8
      const inMinute = late ? 40 + ((index + day) % 15) : 5 + ((index * 7 + day) % 20)
      const outHour = 16 + ((index + day) % 2)

      records.push({
        id: `a1000000-0000-4000-8000-${String(records.length + 1).padStart(12, '0')}`,
        employee_id: employee.id,
        employee_name: fullNameOf(employee),
        agency_id: employee.agency_id,
        check_in: isoAt(day, inHour, inMinute),
        check_out: isoAt(day, outHour, (index * 11 + day) % 60),
        method: index % 7 === 0 ? 'FACE_RECOGNITION' : 'RFID',
      })
    }
  })

  return records
}

function all(): AttendanceRecord[] {
  if (log === null) log = seed()
  return log
}

export function historyFor(employeeId: string): AttendanceRecord[] {
  const employees = makeEmployees(ROSTER_SIZE)
  if (!employees.some((e) => e.id === employeeId)) {
    throw new ApiError('http', 'Employe introuvable.', 404)
  }

  /* Most recent first, which is what the contract specifies. */
  return all()
    .filter((r) => r.employee_id === employeeId)
    .sort((a, b) => b.check_in.localeCompare(a.check_in))
}

/** The employee holding this card, if they are ACTIVE. */
function activeByRfid(rfid: string) {
  const employee = makeEmployees(ROSTER_SIZE).find(
    (e) => e.rfid_uid != null && e.rfid_uid.toUpperCase() === rfid.trim().toUpperCase(),
  )
  if (!employee || employee.status !== 'ACTIVE') {
    throw new ApiError('http', 'Aucun employe actif ne correspond a cette carte.', 404)
  }
  return employee
}

function openRecordFor(employeeId: string): AttendanceRecord | undefined {
  /* The most recent open one - an employee can have several closed records and
     at most one open, and "most recent" is what check-out closes. */
  return all()
    .filter((r) => r.employee_id === employeeId && r.check_out === null)
    .sort((a, b) => b.check_in.localeCompare(a.check_in))[0]
}

export function checkIn(body: AttendanceMark): AttendanceRecord {
  const employee = activeByRfid(body.employee_rfid)

  const existing = openRecordFor(employee.id)
  /* Already inside: return what is there. Not an error, and NOT a new row. */
  if (existing) return { ...existing }

  const created: AttendanceRecord = {
    id: `a9000000-0000-4000-8000-${String((nextId += 1)).padStart(12, '0')}`,
    employee_id: employee.id,
    employee_name: fullNameOf(employee),
    agency_id: employee.agency_id ?? AGENCY_ID,
    check_in: body.timestamp ?? new Date().toISOString(),
    check_out: null,
    method: 'RFID',
  }

  all().unshift(created)
  return { ...created }
}

export function checkOut(body: AttendanceMark): AttendanceRecord {
  const employee = activeByRfid(body.employee_rfid)

  const open = openRecordFor(employee.id)
  if (!open) {
    throw new ApiError('http', "Cet employe n'a pas de pointage ouvert.", 409)
  }

  open.check_out = body.timestamp ?? new Date().toISOString()
  return { ...open }
}

/** Tests only - module state would otherwise leak between them. */
export function resetAttendanceStore(): void {
  log = null
  nextId = 5000
}
