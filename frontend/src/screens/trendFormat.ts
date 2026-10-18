import type { ServicePerformance } from '@/api/types'

/** "12 min" / "45 s" - service times run seconds to tens of minutes, so the
 * overview's minute rounding would hide a 40 second service as "1m". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 90) return `${Math.round(seconds)} s`
  return `${Math.round(seconds / 60)} min`
}

export function formatDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Slowest service first; services with no timed tickets sink to the bottom. */
export function sortServices(services: ServicePerformance[]): ServicePerformance[] {
  return [...services].sort((a, b) => (b.avg_service_seconds ?? -1) - (a.avg_service_seconds ?? -1))
}

export type UptimeLevel = 'good' | 'degraded' | 'bad'

/** null in, null out: a day with no samples has no level, it is not "bad". */
export function uptimeLevel(pct: number | null): UptimeLevel | null {
  if (pct === null) return null
  if (pct >= 99) return 'good'
  if (pct >= 90) return 'degraded'
  return 'bad'
}
