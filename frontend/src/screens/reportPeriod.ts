/**
 * Date-range rules for the reports screen. All dates are UTC days, the same
 * "day" the backend buckets by, so the picker, the request and the report agree
 * about where a month starts. The backend refuses anything this would allow
 * through (a future end, a span over a year); these checks only say so earlier,
 * in plain words.
 */

export const MAX_REPORT_DAYS = 366

export interface DateRange {
  /** YYYY-MM-DD, inclusive. */
  start: string
  /** YYYY-MM-DD, inclusive. */
  end: string
}

export type PresetKey = 'this_month' | 'last_month' | 'last_30'

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Midnight UTC of an ISO date. */
function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now)
}

export function presetRange(key: PresetKey, now: Date = new Date()): DateRange {
  const today = utcDate(todayIso(now))
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  switch (key) {
    case 'this_month':
      return { start: toIsoDate(monthStart), end: toIsoDate(today) }
    case 'last_month': {
      const previous = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
      return { start: toIsoDate(previous), end: toIsoDate(addDays(monthStart, -1)) }
    }
    case 'last_30':
      return { start: toIsoDate(addDays(today, -29)), end: toIsoDate(today) }
  }
}

/** The preset a range equals, if any - so its button can show as selected. */
export function matchingPreset(range: DateRange, now: Date = new Date()): PresetKey | null {
  const keys: PresetKey[] = ['this_month', 'last_month', 'last_30']
  return (
    keys.find((key) => {
      const preset = presetRange(key, now)
      return preset.start === range.start && preset.end === range.end
    }) ?? null
  )
}

/** Whole days covered, both ends included. NaN for an unreadable date. */
export function dayCount(range: DateRange): number {
  return (
    Math.round((utcDate(range.end).getTime() - utcDate(range.start).getTime()) / 86_400_000) + 1
  )
}

/** Why a range cannot be reported on, or null if it can. */
export function validateRange(range: DateRange, now: Date = new Date()): string | null {
  const pattern = /^\d{4}-\d{2}-\d{2}$/
  if (!pattern.test(range.start) || !pattern.test(range.end))
    return 'Choose both a start and an end date.'
  const days = dayCount(range)
  if (Number.isNaN(days)) return 'One of those dates is not valid.'
  if (days < 1) return 'The end date comes before the start date.'
  if (range.end > todayIso(now))
    return 'A report cannot cover the future - the end date must be today or earlier.'
  if (days > MAX_REPORT_DAYS) return `A report covers at most ${MAX_REPORT_DAYS} days.`
  return null
}

/** "1 Sep - 30 Sep 2026 (30 days)". */
export function describeRange(range: DateRange): string {
  const format = (iso: string, withYear: boolean) =>
    utcDate(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    })
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4)
  const days = dayCount(range)
  return `${format(range.start, !sameYear)} - ${format(range.end, true)} (${days} ${days === 1 ? 'day' : 'days'})`
}
