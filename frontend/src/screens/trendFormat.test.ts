import { describe, expect, it } from 'vitest'
import type { ServicePerformance } from '@/api/types'
import { formatDay, formatDuration, sortServices, uptimeLevel } from './trendFormat'

const service = (name: string, avg: number | null): ServicePerformance => ({
  service_id: name,
  name,
  tickets_completed: 1,
  avg_queue_wait_seconds: null,
  avg_service_seconds: avg,
  service_samples: avg === null ? 0 : 1,
  is_slowest: false,
})

describe('formatDuration', () => {
  it('shows seconds for short times so a 40 s service is not rounded to a minute', () => {
    expect(formatDuration(40)).toBe('40 s')
    expect(formatDuration(89)).toBe('89 s')
  })

  it('switches to whole minutes once it is long enough to read that way', () => {
    expect(formatDuration(90)).toBe('2 min')
    expect(formatDuration(1800)).toBe('30 min')
  })

  it('shows a dash for no data, never 0', () => {
    expect(formatDuration(null)).toBe('—')
  })
})

describe('sortServices', () => {
  it('puts the slowest first and services with no timed tickets last, without mutating', () => {
    const input = [service('none', null), service('fast', 60), service('slow', 900)]
    expect(sortServices(input).map((s) => s.name)).toEqual(['slow', 'fast', 'none'])
    expect(input.map((s) => s.name)).toEqual(['none', 'fast', 'slow'])
  })
})

describe('formatDay', () => {
  it('names the UTC day regardless of the viewer timezone', () => {
    expect(formatDay('2026-10-02')).toContain('2')
  })
})

describe('uptimeLevel', () => {
  it('grades uptime, and gives a day with no samples no grade at all', () => {
    expect(uptimeLevel(100)).toBe('good')
    expect(uptimeLevel(99)).toBe('good')
    expect(uptimeLevel(95)).toBe('degraded')
    expect(uptimeLevel(90)).toBe('degraded')
    expect(uptimeLevel(89.9)).toBe('bad')
    expect(uptimeLevel(0)).toBe('bad')
    expect(uptimeLevel(null)).toBeNull()
  })
})
