import type { AttendanceEntry } from '@/api/attendanceMerge'

/**
 * Chart series derived from the attendance snapshot the screen already has.
 *
 * EVERY NUMBER HERE COMES FROM DATA WE ACTUALLY HOLD. That constraint is the
 * reason this file is shaped the way it is. The obvious dashboard move is a
 * "+18% on last week" chip under each figure, and there is no last week:
 * contracts/api.md exposes GET /api/attendance/today and nothing historical.
 * A trend computed from data we do not have is a fabricated number on a wall
 * display that people make staffing decisions from, so instead these series
 * describe today - which today's snapshot can honestly support.
 *
 * Kept out of the screen component so the bucketing is testable without
 * mounting React, and so the screen file stays about layout.
 */

const BUCKET_MINUTES = 30

/** Minutes since local midnight, or null for an unparseable timestamp. */
function minutesInto(iso: string | null): number | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.getHours() * 60 + date.getMinutes()
}

function label(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export interface Bucket {
  label: string
  value: number
}

/**
 * Check-ins grouped into half-hour columns, from the first arrival to the last.
 *
 * The range is the data's own, not a fixed 00:00-23:59. A day that starts at
 * 07:58 and ends at 09:39 should be four columns, not forty-eight mostly-empty
 * ones - the empty ones carry no information and flatten the four that do.
 */
export function arrivalsByHalfHour(entries: AttendanceEntry[]): Bucket[] {
  const times = entries.map((e) => minutesInto(e.check_in)).filter((m): m is number => m !== null)

  if (times.length === 0) return []

  const first = Math.floor(Math.min(...times) / BUCKET_MINUTES) * BUCKET_MINUTES
  const last = Math.floor(Math.max(...times) / BUCKET_MINUTES) * BUCKET_MINUTES

  const counts = new Map<number, number>()
  for (let t = first; t <= last; t += BUCKET_MINUTES) counts.set(t, 0)

  for (const t of times) {
    const bucket = Math.floor(t / BUCKET_MINUTES) * BUCKET_MINUTES
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }

  return [...counts.entries()].map(([minutes, value]) => ({ label: label(minutes), value }))
}

/** Index of the busiest bucket - the one column that gets the accent. */
export function busiestIndex(buckets: Bucket[]): number | undefined {
  if (buckets.length === 0) return undefined
  let best = 0
  for (let i = 1; i < buckets.length; i += 1) {
    if (buckets[i].value > buckets[best].value) best = i
  }
  return best
}

/**
 * Headcount in the building at each half-hour step, for the sparkline.
 *
 * Someone counts as present from their check-in until their check-out, so this
 * rises and falls rather than only accumulating - which is the difference
 * between "how many are here" and "how many came in".
 */
export function headcountSeries(entries: AttendanceEntry[]): number[] {
  const spans = entries
    .map((e) => ({ in: minutesInto(e.check_in), out: minutesInto(e.check_out) }))
    .filter((s): s is { in: number; out: number | null } => s.in !== null)

  if (spans.length === 0) return []

  const first = Math.floor(Math.min(...spans.map((s) => s.in)) / BUCKET_MINUTES) * BUCKET_MINUTES
  const last = Math.max(
    ...spans.map((s) => s.out ?? s.in),
    // Carry the line to now, so a quiet last hour is visible as a flat run
    // rather than as the chart simply stopping.
    new Date().getHours() * 60 + new Date().getMinutes(),
  )

  const series: number[] = []
  for (let t = first; t <= last; t += BUCKET_MINUTES) {
    series.push(spans.filter((s) => s.in <= t && (s.out === null || s.out > t)).length)
  }
  return series
}

/**
 * Reader methods that are initialisms and must not be title-cased.
 *
 * Without this, RFID - which is most of the traffic on this dashboard - renders
 * as "Rfid", which looks like a typo rather than a hardware standard. Naive
 * title-casing over machine constants gets this wrong every time, so the
 * exceptions are named rather than guessed at from word length.
 */
const INITIALISMS = new Set(['RFID', 'NFC', 'QR', 'PIN', 'ID'])

/**
 * How people badged in, for the donut.
 *
 * `method` is a documented field on the attendance record, so these labels are
 * transcribed rather than invented. Underscores become spaces and the value is
 * cased purely for display - the underlying value is untouched.
 */
export function methodMix(entries: AttendanceEntry[]): Bucket[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.method, (counts.get(entry.method) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([method, value]) => ({
      label: method
        .split('_')
        .map((word) =>
          INITIALISMS.has(word.toUpperCase())
            ? word.toUpperCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(' '),
      value,
    }))
    .sort((a, b) => b.value - a.value)
}
