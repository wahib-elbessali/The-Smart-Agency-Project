import { describe, expect, it } from 'vitest'
import type { AgentSummary, Counter, Workstation } from '@/api/types'
import {
  attendanceFeedDown,
  attendanceFlag,
  freeAgents,
  occupancyFlag,
  occupancyOf,
} from './staffingChecks'

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  user_id: 'u1',
  full_name: 'Nadia Agent',
  assignment: null,
  attendance: { state: 'checked_in', at: '2026-10-02T08:00:00Z' },
  ...over,
})

const counter = (over: Partial<Counter> = {}): Counter =>
  ({
    id: 'c1',
    number: 1,
    name: 'Counter 1',
    point_type: 'COUNTER',
    is_open: true,
    service_id: 's1',
    emotion_camera_id: null,
    workstation_name: 'desk-1',
    ...over,
  }) as Counter

const station = (status: Workstation['status']): Workstation =>
  ({ name: 'desk-1', zone: 'z', status, since: 0, zone_known: true }) as Workstation

describe('attendanceFlag', () => {
  it('flags an assigned agent who has not badged in today', () => {
    const flag = attendanceFlag(agent({ attendance: { state: 'not_checked_in', at: null } }), true)
    expect(flag?.kind).toBe('not_checked_in')
    expect(flag?.text).toContain("Nadia Agent hasn't badged in")
  })

  it('flags a badge-out, naming the person', () => {
    const flag = attendanceFlag(
      agent({ attendance: { state: 'checked_out', at: '2026-10-02T12:30:00Z' } }),
      true,
    )
    expect(flag?.kind).toBe('checked_out')
    expect(flag?.text).toContain('Nadia Agent badged out')
  })

  it('stays silent for a badged-in agent', () => {
    expect(attendanceFlag(agent(), true)).toBeNull()
  })

  it('stays silent when there is no data: no linked employee, or the feed is down', () => {
    expect(attendanceFlag(agent({ attendance: null }), true)).toBeNull()
    expect(
      attendanceFlag(agent({ attendance: { state: 'unavailable', at: null } }), true),
    ).toBeNull()
  })

  it('stays silent with nobody assigned, and for a closed counter', () => {
    expect(attendanceFlag(null, true)).toBeNull()
    expect(
      attendanceFlag(agent({ attendance: { state: 'not_checked_in', at: null } }), false),
    ).toBeNull()
  })
})

describe('occupancyFlag', () => {
  it('flags an open counter nobody is at', () => {
    expect(occupancyFlag(counter(), station('away'))?.kind).toBe('nobody_there')
  })

  it('never flags present, unknown, a closed counter, or a counter with no workstation', () => {
    expect(occupancyFlag(counter(), station('present'))).toBeNull()
    expect(occupancyFlag(counter(), station('unknown'))).toBeNull()
    expect(occupancyFlag(counter({ is_open: false }), station('away'))).toBeNull()
    expect(occupancyFlag(counter(), null)).toBeNull()
  })

  it('looks a workstation up only when the counter has one bound', () => {
    const map = new Map([['desk-1', station('away')]])
    expect(occupancyOf(counter(), map)?.status).toBe('away')
    expect(occupancyOf(counter({ workstation_name: null }), map)).toBeNull()
    expect(occupancyOf(counter({ workstation_name: 'missing' }), map)).toBeNull()
  })
})

describe('free agents and the feed notice', () => {
  it('lists only agents badged in who hold no counter', () => {
    const assignment = {
      counter_id: 'c1',
      counter_name: null,
      service_id: 's1',
      service_name: 'S',
      no_show_min_wait_seconds: 60,
    }
    const list = [
      agent({ user_id: 'a', full_name: 'Free One' }),
      agent({ user_id: 'b', full_name: 'Busy', assignment }),
      agent({
        user_id: 'c',
        full_name: 'Not In',
        attendance: { state: 'not_checked_in', at: null },
      }),
      agent({ user_id: 'd', full_name: 'No Employee', attendance: null }),
    ]
    expect(freeAgents(list).map((a) => a.full_name)).toEqual(['Free One'])
  })

  it('reports the feed as down only when some agent is unavailable', () => {
    expect(attendanceFeedDown([agent()])).toBe(false)
    expect(attendanceFeedDown([agent({ attendance: { state: 'unavailable', at: null } })])).toBe(
      true,
    )
  })
})
