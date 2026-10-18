import { describe, expect, it } from 'vitest'
import { queueSignal } from './queueSignal'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const ago = (seconds: number) => ({ created_at: new Date(NOW - seconds * 1000).toISOString() })
const many = (count: number, seconds: number) => Array.from({ length: count }, () => ago(seconds))
const T = {
  queue_depth_warning: 5,
  queue_depth_critical: 10,
  oldest_wait_warning_seconds: 600,
  oldest_wait_critical_seconds: 1200,
}

describe('queueSignal', () => {
  it('is ok for a short, fresh queue, and for an empty one', () => {
    expect(queueSignal([ago(30), ago(60)], T, NOW)).toEqual({ level: 'ok', reasons: [] })
    expect(queueSignal([], T, NOW).level).toBe('ok')
  })

  it('warns and goes critical on depth alone', () => {
    expect(queueSignal(many(5, 10), T, NOW)).toEqual({ level: 'warn', reasons: ['5 waiting'] })
    expect(queueSignal(many(10, 10), T, NOW).level).toBe('critical')
  })

  it('warns and goes critical on the oldest ticket alone, however short the line', () => {
    expect(queueSignal([ago(700)], T, NOW)).toEqual({
      level: 'warn',
      reasons: ['oldest has waited 11 min'],
    })
    expect(queueSignal([ago(60), ago(1300)], T, NOW).level).toBe('critical')
  })

  it('takes the worse of the two measures and reports both reasons', () => {
    const signal = queueSignal([...many(5, 10), ago(1300)], T, NOW)
    expect(signal.level).toBe('critical')
    expect(signal.reasons).toEqual(['6 waiting', 'oldest has waited 21 min'])
  })

  it('treats a null threshold as switched off', () => {
    const partlyOff = {
      ...T,
      queue_depth_critical: null,
      oldest_wait_warning_seconds: null,
      oldest_wait_critical_seconds: null,
    }
    expect(queueSignal(many(50, 9999), partlyOff, NOW).level).toBe('warn')
    const allOff = {
      queue_depth_warning: null,
      queue_depth_critical: null,
      oldest_wait_warning_seconds: null,
      oldest_wait_critical_seconds: null,
    }
    expect(queueSignal(many(50, 9999), allOff, NOW).level).toBe('ok')
  })

  it('lets critical win even when the pair is misconfigured (critical below warning)', () => {
    const odd = { ...T, queue_depth_warning: 8, queue_depth_critical: 3 }
    expect(queueSignal(many(4, 1), odd, NOW).level).toBe('critical')
  })

  it('ignores unreadable timestamps and never reports a negative wait', () => {
    expect(queueSignal([{ created_at: 'nonsense' }], T, NOW).level).toBe('ok')
    const future = { created_at: new Date(NOW + 5000).toISOString() }
    expect(queueSignal([future], T, NOW).level).toBe('ok')
  })
})
