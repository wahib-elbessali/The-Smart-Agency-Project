import type { Agency, Ticket } from '@/api/types'

/**
 * How backed-up one service's line is: the worse of two measures, each compared against a per-agency
 * warning and critical threshold, same shape as a sensor's warning_max /
 * critical_max.
 *
 * DASHBOARD-VISUAL ONLY, on purpose. A long queue is a service-quality
 * problem, not a safety one, so this never becomes an Alert row and never
 * reaches the push/email pipeline - it is a pure function of the live queue,
 * nothing is stored. A null threshold switches that threshold off.
 *
 * Does not assume warning < critical: a misconfigured pair still resolves,
 * with critical winning whenever its own limit is reached.
 */

export type QueueLevel = 'ok' | 'warn' | 'critical'

export interface QueueSignal {
  level: QueueLevel
  /** Human reasons, e.g. "7 waiting", "oldest has waited 12 min". Empty when ok. */
  reasons: string[]
}

type Thresholds = Pick<
  Agency,
  | 'queue_depth_warning'
  | 'queue_depth_critical'
  | 'oldest_wait_warning_seconds'
  | 'oldest_wait_critical_seconds'
>

function rank(level: QueueLevel): number {
  return level === 'critical' ? 2 : level === 'warn' ? 1 : 0
}

function levelFor(value: number, warning: number | null, critical: number | null): QueueLevel {
  if (critical !== null && value >= critical) return 'critical'
  if (warning !== null && value >= warning) return 'warn'
  return 'ok'
}

export function minutesLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return minutes < 1 ? 'under a minute' : `${minutes} min`
}

/** `waiting` must already be this one service's WAITING tickets. */
export function queueSignal(
  waiting: Pick<Ticket, 'created_at'>[],
  thresholds: Thresholds,
  now: number,
): QueueSignal {
  const depthLevel = levelFor(
    waiting.length,
    thresholds.queue_depth_warning,
    thresholds.queue_depth_critical,
  )

  const createdTimes = waiting
    .map((t) => new Date(t.created_at).getTime())
    .filter((ms) => !Number.isNaN(ms))
  const oldestSeconds =
    createdTimes.length > 0 ? Math.max(0, Math.floor((now - Math.min(...createdTimes)) / 1000)) : 0
  const ageLevel = levelFor(
    oldestSeconds,
    thresholds.oldest_wait_warning_seconds,
    thresholds.oldest_wait_critical_seconds,
  )

  const reasons: string[] = []
  if (depthLevel !== 'ok') reasons.push(`${waiting.length} waiting`)
  if (ageLevel !== 'ok') reasons.push(`oldest has waited ${minutesLabel(oldestSeconds)}`)

  return { level: rank(depthLevel) >= rank(ageLevel) ? depthLevel : ageLevel, reasons }
}
