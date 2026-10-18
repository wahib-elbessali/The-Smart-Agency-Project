import type { AttendanceEvent, AttendanceRecord } from './types'

/**
 * Merging the REST snapshot with the live socket feed.
 *
 * This file exists because of one detail in contracts/api.md that is easy to
 * read past: GET /api/attendance/today returns records WITH an `id`, and
 * WS /ws/attendance sends frames WITHOUT one. So "just key on id" is not
 * available, and appending every frame produces duplicate rows the first time
 * the socket reconnects and the backend replays.
 *
 * The three failure modes this has to survive, in the order they will actually
 * happen:
 *
 * 1. DUPLICATES - a reconnect replays frames we already have.
 * 2. OUT OF ORDER - a check_out frame lands before the check_in frame for the
 *    same visit, or a stale check_in frame arrives after the check_out.
 * 3. UNKNOWN FRAMES - `event` is documented with one value ("check_in") but
 *    check-out exists as an endpoint, so other values will appear. An unknown
 *    value must not throw and must not drop the row.
 */

/** A row on the presence screen. `id` is optional: socket frames have none. */
export interface AttendanceEntry {
  id?: string
  employee_id: string
  employee_name: string
  agency_id: string
  check_in: string
  check_out: string | null
  method: string
}

/**
 * What makes two rows "the same visit".
 *
 * employee_id alone is wrong: an employee can check in, leave, and come back the
 * same day, and that is two rows, not one. check_in is what separates them, and
 * it is present on both the REST record and the socket frame.
 */
export function identityOf(entry: Pick<AttendanceEntry, 'employee_id' | 'check_in'>): string {
  return `${entry.employee_id}|${entry.check_in}`
}

export function entryFromRecord(record: AttendanceRecord): AttendanceEntry {
  return {
    id: record.id,
    employee_id: record.employee_id,
    employee_name: record.employee_name,
    agency_id: record.agency_id,
    check_in: record.check_in,
    check_out: record.check_out,
    method: record.method,
  }
}

export function entryFromEvent(event: AttendanceEvent): AttendanceEntry {
  return {
    employee_id: event.employee_id,
    employee_name: event.employee_name,
    agency_id: event.agency_id,
    check_in: event.check_in,
    check_out: event.check_out,
    method: event.method,
  }
}

/**
 * Folds one entry into the list, replacing the matching visit if there is one.
 *
 * The check_out rule is deliberately one-way: once a visit has a check_out, a
 * later frame carrying `null` does NOT clear it. That is what protects against
 * a replayed check_in frame arriving after the check_out and making someone who
 * has gone home look like they are still in the building - the dangerous
 * direction of this error. The cost is that a genuine backend *correction* back
 * to null would be ignored; if that turns out to be a real case, it needs a
 * sequence number or timestamp on the frame, which is a contract change.
 */
export function upsertEntry(list: AttendanceEntry[], incoming: AttendanceEntry): AttendanceEntry[] {
  const key = identityOf(incoming)
  const index = list.findIndex((entry) => identityOf(entry) === key)

  if (index === -1) return [...list, incoming]

  const existing = list[index]
  const merged: AttendanceEntry = {
    ...existing,
    ...incoming,
    /* Keep the id we already had - socket frames don't carry one and we don't
       want to lose it on the first live update. */
    id: existing.id ?? incoming.id,
    check_out: incoming.check_out ?? existing.check_out,
  }

  const next = [...list]
  next[index] = merged
  return next
}

/** Ignores frames that are not attendance updates rather than throwing on them. */
export function isAttendanceUpdate(event: AttendanceEvent): boolean {
  return event.type === 'attendance_updated'
}

/**
 * Display order: still in the building first, then most recent arrival first.
 *
 * Someone glancing at a wall display is asking "who is here now?", so the open
 * visits belong at the top rather than interleaved by time.
 */
export function sortEntries(list: AttendanceEntry[]): AttendanceEntry[] {
  return [...list].sort((a, b) => {
    const aOpen = a.check_out === null
    const bOpen = b.check_out === null
    if (aOpen !== bOpen) return aOpen ? -1 : 1
    return b.check_in.localeCompare(a.check_in)
  })
}

export interface PresenceTotals {
  present: number
  departed: number
  total: number
}

export function totalsOf(list: AttendanceEntry[]): PresenceTotals {
  const present = list.filter((entry) => entry.check_out === null).length
  return { present, departed: list.length - present, total: list.length }
}

/**
 * Was this arrival after the agency's opening time?
 *
 * Derived, not reported: nothing in the contract says "late". It compares
 * `check_in` against the agency's `opening_time`, both of which are contract
 * fields, and returns null when we have no agency to compare against rather
 * than defaulting to "on time".
 *
 * `opening_time` is nullable in AgencyResponse, so "unknown" is a real case and
 * returns null rather than defaulting to "on time".
 *
 * It is a wall-clock "HH:MM:SS" with no timezone, and `check_in` is an instant. This compares them in the VIEWER'S timezone, which is right when
 * the dashboard hangs in the branch it is showing and wrong for an ADMIN
 * watching several cities. That is a real limitation, not a rounding error -
 * it needs a timezone on the agency record to fix properly, which is a contract
 * change. Flagged rather than silently wrong.
 */
export function isLate(checkIn: string, openingTime: string | null | undefined): boolean | null {
  if (!openingTime) return null

  const arrival = new Date(checkIn)
  if (Number.isNaN(arrival.getTime())) return null

  const parts = openingTime.split(':')
  if (parts.length < 2) return null

  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  const seconds = Number(parts[2] ?? '0')
  if (![hours, minutes, seconds].every(Number.isFinite)) return null

  const opening = new Date(arrival)
  opening.setHours(hours, minutes, seconds, 0)

  return arrival.getTime() > opening.getTime()
}
