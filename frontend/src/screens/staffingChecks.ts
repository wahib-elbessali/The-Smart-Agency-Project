import type { AgentAttendance, AgentSummary, Counter, Workstation } from '@/api/types'

/**
 * The two independent staffing signals for one counter on the visitor board
 * (scenario-planning backlog, "Busy Monday morning"). They answer different
 * questions and are kept apart on purpose:
 *
 *   attendance - did the assigned agent badge in today? Catches a whole-day
 *                absence, but says nothing about right now.
 *   occupancy  - is anyone physically at the counter right now? Catches
 *                "stepped away", but says nothing about who. Deliberately the
 *                plain workstation status, not an employee-specific track.
 *
 * "No data" is never a flag: an agent with no linked employee, a feed that is
 * down, or a workstation that has never been classified all stay silent
 * rather than reading as an absence.
 */

export interface StaffingFlag {
  kind: 'not_checked_in' | 'checked_out' | 'nobody_there'
  text: string
}

function clock(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function attendanceFlag(
  covering: AgentSummary | null,
  counterIsOpen: boolean,
): StaffingFlag | null {
  if (!covering || !counterIsOpen) return null
  const attendance: AgentAttendance | null = covering.attendance
  if (!attendance) return null
  switch (attendance.state) {
    case 'not_checked_in':
      return { kind: 'not_checked_in', text: `${covering.full_name} hasn't badged in today` }
    case 'checked_out': {
      const at = clock(attendance.at)
      return {
        kind: 'checked_out',
        text: `${covering.full_name} badged out${at ? ` at ${at}` : ''}`,
      }
    }
    default:
      return null
  }
}

export function occupancyOf(
  counter: Counter,
  workstations: Map<string, Workstation>,
): Workstation | null {
  return counter.workstation_name ? (workstations.get(counter.workstation_name) ?? null) : null
}

export function occupancyFlag(
  counter: Counter,
  workstation: Workstation | null,
): StaffingFlag | null {
  if (!counter.is_open || !workstation) return null
  /* `unknown` means not classified yet - a broken camera is not an unmanned
     counter, so it never becomes a flag. */
  return workstation.status === 'away'
    ? { kind: 'nobody_there', text: 'Nobody at the counter right now' }
    : null
}

/** Agents who are badged in today and hold no counter - the people a manager
 * could actually move to cover a flagged one. */
export function freeAgents(agents: AgentSummary[]): AgentSummary[] {
  return agents.filter((a) => a.assignment === null && a.attendance?.state === 'checked_in')
}

/** True while at least one agent's attendance can't be trusted because the
 * badge feed (the MQTT broker) is down. */
export function attendanceFeedDown(agents: AgentSummary[]): boolean {
  return agents.some((a) => a.attendance?.state === 'unavailable')
}
