import type { BranchOverview } from '@/api/types'

/**
 * The admin's branch comparison: one row per branch, reusing exactly the metrics the per-branch
 * overview already has - nothing is invented for the comparison.
 *
 * NEUTRAL ON PURPOSE. There is no highlighting, no thresholds and no "worst
 * branch": which number looks off depends on the branch, and the admin is the
 * one who knows. So this module only extracts, formats and sorts.
 */

export type ColumnKey =
  | 'name'
  | 'waiting'
  | 'in_service'
  | 'completed_today'
  | 'cancelled_today'
  | 'open_alerts'
  | 'critical_alerts'
  | 'avg_queue_wait'
  | 'avg_service'
  | 'avg_total'
  | 'positive'
  | 'negative'
  | 'samples'
  | 'returning'
  | 'service_positive'

export interface Column {
  key: ColumnKey
  label: string
  /** Where the number comes from, for the tooltip - so a header is never a mystery. */
  hint: string
  value(row: BranchOverview): number | string | null
  format(value: number | string | null): string
}

const count = (v: number | string | null) => (v === null ? '—' : String(v))
const percent = (v: number | string | null) => (v === null ? '—' : `${Math.round(Number(v))}%`)
/** Same minute rounding the per-branch overview uses; "—" is no data, not zero. */
export const minutes = (v: number | string | null) =>
  v === null ? '—' : `${Math.round(Number(v) / 60)}m`

export const COLUMNS: readonly Column[] = [
  {
    key: 'name',
    label: 'Branch',
    hint: 'Branch name',
    value: (r) => r.name,
    format: (v) => String(v),
  },
  {
    key: 'waiting',
    label: 'Waiting',
    hint: 'Tickets waiting now',
    value: (r) => r.overview.tickets.waiting,
    format: count,
  },
  {
    key: 'in_service',
    label: 'In service',
    hint: 'Tickets called or being served',
    value: (r) => r.overview.tickets.in_service,
    format: count,
  },
  {
    key: 'completed_today',
    label: 'Done today',
    hint: 'Tickets completed today (UTC)',
    value: (r) => r.overview.tickets.completed_today,
    format: count,
  },
  {
    key: 'cancelled_today',
    label: 'Cancelled today',
    hint: 'Tickets cancelled today (UTC)',
    value: (r) => r.overview.tickets.cancelled_today,
    format: count,
  },
  {
    key: 'open_alerts',
    label: 'Open alerts',
    hint: 'Open and acknowledged alerts',
    value: (r) => r.overview.alerts.open_total,
    format: count,
  },
  {
    key: 'critical_alerts',
    label: 'Critical',
    hint: 'Open alerts of CRITICAL severity',
    value: (r) => r.overview.alerts.open_by_severity.CRITICAL ?? 0,
    format: count,
  },
  {
    key: 'avg_queue_wait',
    label: 'Avg wait',
    hint: 'Average queue wait, last 24 h',
    value: (r) => r.overview.wait_times.avg_queue_wait_seconds,
    format: minutes,
  },
  {
    key: 'avg_service',
    label: 'Avg service',
    hint: 'Average service duration, last 24 h',
    value: (r) => r.overview.wait_times.avg_service_duration_seconds,
    format: minutes,
  },
  {
    key: 'avg_total',
    label: 'Avg total',
    hint: 'Average time from taking a ticket to completion, last 24 h',
    value: (r) => r.overview.wait_times.avg_total_seconds,
    format: minutes,
  },
  {
    key: 'positive',
    label: 'Positive',
    hint: 'Positive share of emotion samples, last 24 h',
    value: (r) => r.overview.satisfaction.positive_pct,
    format: percent,
  },
  {
    key: 'negative',
    label: 'Negative',
    hint: 'Negative share of emotion samples, last 24 h',
    value: (r) => r.overview.satisfaction.negative_pct,
    format: percent,
  },
  {
    key: 'samples',
    label: 'Samples',
    hint: 'Emotion samples behind those two shares',
    value: (r) => r.overview.satisfaction.total_samples,
    format: count,
  },
  {
    key: 'returning',
    label: 'Returning',
    hint: 'Returning share of visitors recognised by face, last 30 days',
    value: (r) => r.overview.visitor_recognition.returning_pct,
    format: percent,
  },
  {
    key: 'service_positive',
    label: 'At counter',
    hint: 'Positive share of emotion samples taken during service, last 24 h',
    value: (r) => r.overview.service_satisfaction.positive_pct,
    format: percent,
  },
]

export type SortDirection = 'asc' | 'desc'

export interface Sort {
  key: ColumnKey
  direction: SortDirection
}

/** Branches by name until the admin asks for something else. */
export const DEFAULT_SORT: Sort = { key: 'name', direction: 'asc' }

/**
 * Sorts a copy. Rows with no value for the chosen column always go LAST,
 * whichever way it is sorted - "no data" is not the smallest value, and sorting
 * it to the top of a descending list would put empty branches above busy ones.
 * Ties keep the incoming order (alphabetical from the server), so the order of
 * equal rows does not jump around between refreshes.
 */
export function sortBranches(rows: BranchOverview[], sort: Sort): BranchOverview[] {
  const column = COLUMNS.find((c) => c.key === sort.key)
  if (!column) return [...rows]
  const factor = sort.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, value: column.value(row) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index
      if (a.value === null) return 1
      if (b.value === null) return -1
      const compared =
        typeof a.value === 'string' || typeof b.value === 'string'
          ? String(a.value).localeCompare(String(b.value), undefined, { sensitivity: 'base' })
          : a.value - b.value
      return compared === 0 ? a.index - b.index : compared * factor
    })
    .map((entry) => entry.row)
}

/** Clicking the sorted column flips it; clicking another starts ascending for
 * the name and descending for numbers, which is the order people look for. */
export function nextSort(current: Sort, key: ColumnKey): Sort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { key, direction: key === 'name' ? 'asc' : 'desc' }
}
